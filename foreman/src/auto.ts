// Auto mode: the user lets the team go on without answering every decision.
//
//   permissions  a permission prompt is allowed without asking, unless it is one of the risky
//                kinds below (those still reach the podium)
//   merges       a merge the lead approved (request_merge) is merged when the task's tests pass
//   workspace    a workspace plan is applied without the podium (nothing is deleted anyway)
//   questions    ask_user gets the recommended (first) option, or "decide yourself"
//
// Policy denials (git push, the lead editing files, subagents...) are never affected: auto mode
// only answers what would otherwise have been asked.
import path from 'node:path';
import type { Verdict } from './policy.js';
import { isInsideOrEqual } from './util/fsx.js';

export interface AutoConfig {
  enabled: boolean;
  permissions: boolean;
  merges: boolean;
  workspace: boolean;
  questions: boolean;
}

export type AutoKind = Exclude<keyof AutoConfig, 'enabled'>;

export const AUTO_OFF: AutoConfig = { enabled: false, permissions: true, merges: true, workspace: true, questions: true };

/** config.json "auto": true | false | { enabled, permissions, merges, workspace, questions } */
export function parseAuto(v: unknown, enabledOverride?: boolean): AutoConfig {
  const out = { ...AUTO_OFF };
  if (typeof v === 'boolean') out.enabled = v;
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    out.enabled = o.enabled === undefined ? true : o.enabled === true;
    for (const k of ['permissions', 'merges', 'workspace', 'questions'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  }
  if (enabledOverride !== undefined) out.enabled = enabledOverride;
  return out;
}

/**
 * Why a permission prompt must still reach the user in auto mode (undefined: auto may allow it).
 * Risky: process/system commands, recursive changes outside the worktree, writes outside both the
 * worktree and the workspaces, git internals / git environment, links out of the worktree, and
 * anything the read-only lead would change in the user's checkout.
 */
export function autoRisk(verdict: Extract<Verdict, { action: 'ask' }>, opts: { role: 'lead' | 'worker'; workspaces: string[] }): string | undefined {
  if (opts.role === 'lead') return 'the lead works read-only in your checkout';
  if (/process or system command/i.test(verdict.reason)) return 'process or system command';
  if (/\bGIT_|git internals|\.git\b|another repository|changes a repository outside/i.test(verdict.reason)) return 'git outside the worktree';
  if (/--global/.test(verdict.reason)) return 'a global install or setting';
  const inWorkspace = (p: string) => opts.workspaces.some((w) => isInsideOrEqual(path.resolve(p), w));
  for (const key of verdict.ruleKeys) {
    let m: RegExpExecArray | null;
    if ((m = /^Bash:outside:(.+?):(r|w|x)tree:(.*)$/.exec(key)) && m[2] === 'w') return `recursive change of ${m[3]}`;
    if ((m = /^Bash:outside:(.+?):w:(.*)$/.exec(key)) && !inWorkspace(m[2]!)) return `writing in ${m[2]}`;
    if (/^\w+:\.git:/.test(key)) return 'git internals';
    if (/^\w+:link:/.test(key)) return 'a link out of the worktree';
    if ((m = /^(Write|Edit|MultiEdit|NotebookEdit):(.*)$/.exec(key)) && !inWorkspace(m[2]!)) return `writing in ${m[2]}`;
  }
  return undefined;
}
