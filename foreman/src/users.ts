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
}

/** Who sends a client message: a member, or the local single user. */
export interface Actor {
  id: string;
  name: string;
  role: UserRole;
}

export class UserError extends Error {}

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

  constructor(home: string) {
    this.file = path.join(home, 'users.json');
  }

  list(): Member[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { users?: Member[] };
      return Array.isArray(raw.users) ? raw.users.filter((u) => u && typeof u.id === 'string' && typeof u.tokenHash === 'string') : [];
    } catch {
      return [];
    }
  }

  /** A shared Foreman: at least one member. */
  get enabled(): boolean {
    return this.list().length > 0;
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
    if (!token || !token.startsWith('acu_')) return undefined;
    const h = Buffer.from(hash(token), 'hex');
    return this.list().find((u) => {
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
