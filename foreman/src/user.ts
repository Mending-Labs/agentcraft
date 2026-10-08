// The person the team works for. Used in agent prompts ("ask <name>"), feed lines and the sim's
// dialogue, and sent to the mod in foreman.status so the UI can say it too.
// Config: --user-name / AGENTCRAFT_USER_NAME / config.json "userName"; default: the OS user name.
//
// A shared Foreman (users.ts) has several people: while a member's message is handled, and while
// the agents work on a member's goal, userName() is that member (runAs), so "ask <name>" and
// "<name> answered" name the right person. Outside of both it is the configured owner.
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import type { Actor } from './users.js';

let current: string | undefined;
const acting = new AsyncLocalStorage<Actor | null>();

/** The OS account name with a capital first letter ("alex" -> "Alex"), or "the user". */
export function defaultUserName(): string {
  let raw = '';
  try {
    raw = os.userInfo().username;
  } catch {
    // no passwd entry (some containers)
  }
  raw = raw.trim().replace(/[^\p{L}\p{N} ._-]/gu, '');
  return raw ? raw[0]!.toUpperCase() + raw.slice(1) : 'the user';
}

/** Set once at Foreman start from the config. */
export function setUserName(name: string | undefined): void {
  const n = name?.trim();
  current = n ? n.slice(0, 40) : undefined;
}

/** The configured owner, whoever is acting. */
export function ownerName(): string {
  return current ?? (process.env.AGENTCRAFT_USER_NAME?.trim() || defaultUserName());
}

export function userName(): string {
  return acting.getStore()?.name ?? ownerName();
}

/** The member acting right now (a shared Foreman), if any. */
export function currentActor(): Actor | undefined {
  return acting.getStore() ?? undefined;
}

/** Run `fn` (and everything it starts) as `actor`; null/undefined: as the owner. */
export function runAs<T>(actor: Actor | null | undefined, fn: () => T): T {
  return acting.run(actor ?? null, fn);
}
