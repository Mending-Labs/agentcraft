// AI subscriptions of a shared Foreman's members. A subscription (Claude Pro/Max, ChatGPT) belongs
// to one person: a goal runs on the subscription of the member who set it, never on someone
// else's. Each member links their own, in game (/compte claude|codex, a masked field):
//
//   claude  the long-lived token `claude setup-token` prints on their own computer; kept in the
//           vault (ACCOUNT_CLAUDE__<member>) and given to that member's turns as
//           CLAUDE_CODE_OAUTH_TOKEN
//   codex   the content of their ~/.codex/auth.json after `codex login`; written to a Codex home of
//           their own (<home>/accounts/<member>/codex, owner-only) that their turns run with
//           (CODEX_HOME). Codex refreshes it there, so the file, not the vault, is the reference.
//
// The owner (config "userName") may also use the login of the account the Foreman runs as, as in
// single-user mode; so do goals without a member (the CLI, a single-user Foreman).
import fs from 'node:fs';
import path from 'node:path';
import type { AccountEngine } from './protocol.js';
import type { SecretVault } from './secrets.js';
import { idOf, type UserStore } from './users.js';

export class AccountError extends Error {}

/** Whose subscription a turn runs on; undefined: the login of the account the Foreman runs as. */
export interface TurnAccount {
  member: string;
  name: string;
  claudeToken?: string;
  codexHome?: string;
  /** the owner: an engine they did not link runs on the Foreman's own login */
  ownLogin?: boolean;
}

export const ACCOUNT_SECRET_PREFIX = 'ACCOUNT_';
const claudeSecret = (member: string) => `ACCOUNT_CLAUDE__${member.replace(/[^A-Za-z0-9_]/g, '_')}`;

export class Accounts {
  constructor(
    private home: string,
    private vault: SecretVault,
    private users: UserStore,
    private ownerName: () => string,
  ) {}

  private codexHome(member: string): string {
    return path.join(this.home, 'accounts', member, 'codex');
  }

  /** Engines a member linked. */
  linked(member: string): AccountEngine[] {
    const out: AccountEngine[] = [];
    if (this.vault.get(claudeSecret(member))) out.push('claude');
    if (fs.existsSync(path.join(this.codexHome(member), 'auth.json'))) out.push('codex');
    return out;
  }

  async set(member: string, engine: AccountEngine, value: string): Promise<void> {
    const v = value.trim();
    if (engine === 'claude') {
      if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(v)) {
        throw new AccountError('not a token from `claude setup-token` (it starts with sk-ant-oat). Run `claude setup-token` on your computer and paste what it prints.');
      }
      await this.vault.set(claudeSecret(member), v);
      return;
    }
    let auth: { tokens?: { refresh_token?: unknown }; OPENAI_API_KEY?: unknown };
    try {
      auth = JSON.parse(v) as typeof auth;
    } catch {
      throw new AccountError('not the content of ~/.codex/auth.json (it is JSON). Run `codex login` on your computer, then paste that file.');
    }
    if (typeof auth?.tokens?.refresh_token !== 'string' && typeof auth?.OPENAI_API_KEY !== 'string') {
      throw new AccountError('this auth.json holds no ChatGPT login. Run `codex login` on your computer, then paste ~/.codex/auth.json.');
    }
    const dir = this.codexHome(member);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'auth.json');
    fs.writeFileSync(file, JSON.stringify(auth, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  }

  async delete(member: string, engine: AccountEngine): Promise<boolean> {
    if (engine === 'claude') return this.vault.delete(claudeSecret(member));
    const dir = this.codexHome(member);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  /** The owner, who may use the Foreman's own login. */
  isOwner(memberName: string | undefined): boolean {
    return !memberName || idOf(memberName) === idOf(this.ownerName());
  }

  /**
   * The subscription for a goal set by `memberName`: undefined runs on the Foreman's own login
   * (single-user, no member, or the owner without a linked subscription of their own).
   */
  forMember(memberName: string | undefined): TurnAccount | undefined {
    if (!this.users.enabled || !memberName) return undefined;
    const m = this.users.get(memberName);
    if (!m) return undefined;
    const linked = this.linked(m.id);
    if (!linked.length && this.isOwner(m.name)) return undefined;
    const acc: TurnAccount = { member: m.id, name: m.name, ...(this.isOwner(m.name) ? { ownLogin: true } : {}) };
    const token = this.vault.get(claudeSecret(m.id));
    if (token) acc.claudeToken = token;
    if (linked.includes('codex')) acc.codexHome = this.codexHome(m.id);
    return acc;
  }

  /** Engines `memberName` still has to link before their goal can run on `engines`. */
  missing(memberName: string | undefined, engines: AccountEngine[]): AccountEngine[] {
    if (!this.users.enabled || !memberName) return [];
    const m = this.users.get(memberName);
    if (!m) return [];
    if (this.isOwner(m.name)) return [];
    const linked = this.linked(m.id);
    return [...new Set(engines)].filter((e) => !linked.includes(e));
  }
}

/** The account a turn needs for one engine, or why it cannot run. */
export function accountProblem(acc: TurnAccount | undefined, engine: AccountEngine): string | undefined {
  if (!acc || acc.ownLogin) return undefined;
  if (engine === 'claude' && !acc.claudeToken) return `${acc.name} has not linked a Claude subscription (in game: /compte claude)`;
  if (engine === 'codex' && !acc.codexHome) return `${acc.name} has not linked a Codex subscription (in game: /compte codex)`;
  return undefined;
}
