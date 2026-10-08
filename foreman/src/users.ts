// Team members of a shared Foreman (one Foreman on a server, several people in game).
//
// Without members (users.json absent or empty) the Foreman is single-user, as before: loopback
// only, no token, everything done in the name of config "userName". With members, every client
// presents a personal token (`Authorization: Bearer acu_...`); what it does is attributed to that
// member ("Astios answered Marlow") and limited by the member's role:
//
//   admin   everything: auto mode, the vault, workspaces, repositories, other members' goals
//   member  goals, messages, decisions (merges included), steering tasks and agents
//   viewer  watches (snapshot, diffs) and nothing else
//
// Tokens are shown once, when created (`npm start -- user add <name>`); only their SHA-256 is kept.
//
// A launcher can sign members in instead (no token to hand out): it writes, into the game folder of
// the AgentCraft instance, a pass signed with a key shared with this Foreman (<home>/launcher.key,
// or AGENTCRAFT_LAUNCHER_KEY_FILE). Who may have one is the launcher's business (the instance's
// whitelist in its panel); the Foreman trusts the signature. A player's pass finds the member that
// holds one of its Minecraft UUIDs, else the one created from that launcher account, else creates
// a "member" named after the player. Config "launcherMembers" ([{name, role, minecraft: [uuid...]}])
// declares people up front: one person's several Minecraft accounts become one member, and roles
// (admin) go by account - never by display name, which two players may share.
// Pass: "acl." + base64url(JSON) + "." + base64url(HMAC-SHA256 over "acl." + base64url(JSON)),
// JSON = {v: 1, aud: "agentcraft", sub: launcher account id, name, mc: [uuid...], iat, exp} (seconds).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './util/fsx.js';

export const ROLES = ['admin', 'member', 'viewer'] as const;
export type UserRole = (typeof ROLES)[number];

export interface Member {
  /** lowercase id ("astios"), also the account folder name */
  id: string;
  /** display name ("Astios"), as agents address them */
  name: string;
  role: UserRole;
  tokenHash: string;
  createdAt: number;
  /** Minecraft account UUIDs (lowercase, no dashes) a launcher pass may name for this member */
  minecraft?: string[];
  /** the launcher account this member was created from (launcher pass "sub") */
  launcherId?: string;
}

/** What a valid launcher pass says. */
export interface LauncherPass {
  sub: string;
  name: string;
  mc: string[];
}

/** Who sends a client message: a member, or the local single user. */
export interface Actor {
  id: string;
  name: string;
  role: UserRole;
}

export class UserError extends Error {}

/** "8667ba71-b85a-4004-af54-457a9734eed7" / "8667BA71B85A4004AF54457A9734EED7" -> "8667ba71b85a4004af54457a9734eed7" */
export function normalizeUuid(raw: string): string | undefined {
  const u = raw.trim().toLowerCase().replace(/-/g, '');
  return /^[0-9a-f]{32}$/.test(u) ? u : undefined;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/** A launcher pass (tests and launchers written in JS). */
export function signLauncherPass(key: Buffer, who: LauncherPass, ttlSeconds = 7 * 24 * 3600, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const body = `acl.${b64url(Buffer.from(JSON.stringify({ v: 1, aud: 'agentcraft', sub: who.sub, name: who.name, mc: who.mc, iat, exp: iat + ttlSeconds })))}`;
  return `${body}.${b64url(crypto.createHmac('sha256', key).update(body).digest())}`;
}

/** What a valid pass says, or undefined (bad signature, expired, wrong audience). */
export function verifyLauncherPass(key: Buffer, pass: string, now = Date.now()): LauncherPass | undefined {
  const m = /^(acl\.[A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(pass);
  if (!m) return undefined;
  const want = crypto.createHmac('sha256', key).update(m[1]!).digest();
  const got = Buffer.from(m[2]!, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return undefined;
  let p: { v?: unknown; aud?: unknown; sub?: unknown; name?: unknown; mc?: unknown; iat?: unknown; exp?: unknown };
  try {
    p = JSON.parse(Buffer.from(m[1]!.slice(4), 'base64url').toString('utf8')) as typeof p;
  } catch {
    return undefined;
  }
  const t = now / 1000;
  if (p.v !== 1 || p.aud !== 'agentcraft' || typeof p.exp !== 'number' || typeof p.iat !== 'number') return undefined;
  if (p.exp < t || p.iat > t + 300 || typeof p.sub !== 'string' || !p.sub || typeof p.name !== 'string') return undefined;
  const mc = (Array.isArray(p.mc) ? p.mc : []).filter((x): x is string => typeof x === 'string').map(normalizeUuid).filter((x): x is string => !!x);
  const name = p.name.trim().replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 31) || 'Player';
  return { sub: p.sub.slice(0, 100), name, mc };
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,30}$/u;

const hash = (token: string): string => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

export const idOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Message types each role may send ("*": every type). */
const MEMBER_MESSAGES = new Set([
  'hello',
  'goal.submit',
  'user.message',
  'decision.answer',
  'task.action',
  'agent.action',
  'diff.request',
  'cancel',
  'retry',
  'prioritize',
  'reassign',
  'account.set',
  'account.delete',
]);
const VIEWER_MESSAGES = new Set(['hello', 'diff.request']);

export function allowed(role: UserRole, type: string): boolean {
  if (role === 'admin') return true;
  return (role === 'member' ? MEMBER_MESSAGES : VIEWER_MESSAGES).has(type);
}

export class UserStore {
  readonly file: string;

  private readonly launcherKeyFile: string;

  constructor(home: string) {
    this.file = path.join(home, 'users.json');
    this.launcherKeyFile = process.env.AGENTCRAFT_LAUNCHER_KEY_FILE?.trim() || path.join(home, 'launcher.key');
  }

  /** The key launcher passes are signed with (read at each use: a rotation needs no restart). */
  private launcherKey(): Buffer | undefined {
    try {
      const k = fs.readFileSync(this.launcherKeyFile, 'utf8').trim();
      return k.length >= 32 ? Buffer.from(k, 'utf8') : undefined;
    } catch {
      return undefined;
    }
  }

  /** The member of a launcher pass, created on the first one; new Minecraft accounts are remembered. */
  private fromLauncher(pass: LauncherPass): Member {
    const users = this.list();
    let u = users.find((x) => (x.minecraft ?? []).some((m) => pass.mc.includes(m))) ?? users.find((x) => x.launcherId === pass.sub);
    if (!u) {
      const base = idOf(pass.name) || 'player';
      let id = base;
      for (let i = 2; users.some((x) => x.id === id); i++) id = `${base}-${i}`;
      u = { id, name: id === base ? pass.name : `${pass.name} ${id.slice(base.length + 1)}`, role: 'member', tokenHash: '', createdAt: Date.now(), launcherId: pass.sub, minecraft: [...new Set(pass.mc)] };
      users.push(u);
      this.save(users);
      return u;
    }
    // a member found by its launcher account learns that account's (new) Minecraft UUID
    const known = new Set(u.minecraft ?? []);
    const fresh = pass.mc.filter((m) => !known.has(m) && !users.some((x) => x !== u && (x.minecraft ?? []).includes(m)));
    if (fresh.length) {
      u.minecraft = [...known, ...fresh];
      this.save(users);
    }
    return u;
  }

  /**
   * Config "launcherMembers": people declared up front, by their Minecraft accounts. Creates or
   * updates each (name, role, accounts); an account declared here leaves any other member.
   */
  seedLauncherMembers(list: Array<{ name: string; role?: UserRole; minecraft?: string[] }>): void {
    if (!list.length) return;
    const users = this.list();
    let changed = false;
    for (const p of list) {
      const id = idOf(p.name);
      if (!id || !NAME.test(p.name.trim())) throw new UserError(`launcherMembers: bad member name "${p.name}"`);
      const role = p.role ?? 'member';
      if (!ROLES.includes(role)) throw new UserError(`launcherMembers: ${p.name}: role must be one of ${ROLES.join(', ')}`);
      const mc = (p.minecraft ?? []).map((x) => normalizeUuid(x) ?? '');
      if (mc.some((x) => !x)) throw new UserError(`launcherMembers: ${p.name}: a Minecraft UUID has 32 hex digits (dashes allowed)`);
      for (const other of users) {
        if (other.id === id || !other.minecraft?.some((m) => mc.includes(m))) continue;
        other.minecraft = other.minecraft.filter((m) => !mc.includes(m));
        changed = true;
      }
      let u = users.find((x) => x.id === id);
      if (!u) {
        u = { id, name: p.name.trim(), role, tokenHash: '', createdAt: Date.now(), minecraft: [] };
        users.push(u);
        changed = true;
      }
      const merged = [...new Set([...(u.minecraft ?? []), ...mc])];
      if (u.role !== role || u.name !== p.name.trim() || merged.length !== (u.minecraft ?? []).length) {
        u.role = role;
        u.name = p.name.trim();
        u.minecraft = merged;
        changed = true;
      }
    }
    if (changed) this.save(users);
  }

  /** Give a member the Minecraft accounts a launcher pass may name for them. */
  setMinecraft(idOrName: string, uuids: string[]): Member {
    const norm = uuids.map((u) => normalizeUuid(u) ?? '');
    if (norm.some((u) => !u)) throw new UserError('a Minecraft UUID has 32 hex digits (dashes allowed)');
    const users = this.list();
    const u = users.find((x) => x.id === idOf(idOrName));
    if (!u) throw new UserError(`no member "${idOrName}"`);
    const taken = users.find((x) => x.id !== u.id && (x.minecraft ?? []).some((m) => norm.includes(m)));
    if (taken) throw new UserError(`that Minecraft account already belongs to ${taken.name}`);
    u.minecraft = [...new Set(norm)];
    this.save(users);
    return u;
  }

  list(): Member[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { users?: Member[] };
      return Array.isArray(raw.users) ? raw.users.filter((u) => u && typeof u.id === 'string' && typeof u.tokenHash === 'string') : [];
    } catch {
      return [];
    }
  }

  /** A shared Foreman: at least one member, or a launcher key (members come with their first pass). */
  get enabled(): boolean {
    return this.list().length > 0 || !!this.launcherKey();
  }

  get(idOrName: string): Member | undefined {
    const id = idOf(idOrName);
    return this.list().find((u) => u.id === id);
  }

  /** Create a member (or give an existing one a new token). Returns the token, shown once. */
  add(name: string, role: UserRole = 'member'): { member: Member; token: string } {
    const n = name.trim();
    if (!NAME.test(n)) throw new UserError(`bad member name "${name}" (letters, digits, space . _ -; at most 31 characters)`);
    if (!ROLES.includes(role)) throw new UserError(`role must be one of ${ROLES.join(', ')}`);
    const token = `acu_${crypto.randomBytes(24).toString('base64url')}`;
    const users = this.list();
    const id = idOf(n);
    if (!id) throw new UserError(`bad member name "${name}"`);
    const member: Member = { id, name: n, role, tokenHash: hash(token), createdAt: Date.now() };
    const i = users.findIndex((u) => u.id === id);
    if (i >= 0) users[i] = { ...member, createdAt: users[i]!.createdAt };
    else users.push(member);
    this.save(users);
    return { member, token };
  }

  setRole(idOrName: string, role: UserRole): Member {
    if (!ROLES.includes(role)) throw new UserError(`role must be one of ${ROLES.join(', ')}`);
    const users = this.list();
    const u = users.find((x) => x.id === idOf(idOrName));
    if (!u) throw new UserError(`no member "${idOrName}"`);
    u.role = role;
    this.save(users);
    return u;
  }

  remove(idOrName: string): boolean {
    const users = this.list();
    const rest = users.filter((u) => u.id !== idOf(idOrName));
    if (rest.length === users.length) return false;
    this.save(rest);
    return true;
  }

  /** The member a token belongs to (constant-time comparison of the hashes). */
  authenticate(token: string | undefined): Member | undefined {
    if (token?.startsWith('acl.')) {
      const key = this.launcherKey();
      const pass = key ? verifyLauncherPass(key, token) : undefined;
      return pass ? this.fromLauncher(pass) : undefined;
    }
    if (!token || !token.startsWith('acu_')) return undefined;
    const h = Buffer.from(hash(token), 'hex');
    return this.list().find((u) => {
      if (!u.tokenHash) return false;
      const other = Buffer.from(u.tokenHash, 'hex');
      return other.length === h.length && crypto.timingSafeEqual(other, h);
    });
  }

  private save(users: Member[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { users });
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
  }
}

export const actorOf = (m: Member): Actor => ({ id: m.id, name: m.name, role: m.role });
