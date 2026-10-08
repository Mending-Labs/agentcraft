// The lead sizes the team: request_worker brings an off-shift worker on shift (the user agrees, or
// auto mode does), release_worker sends one back once it has no task. Also: a worker listing
// branches of another repo is a read (auto mode lets it through).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools, type ToolHooks } from '../src/agents/tools.js';
import { autoRisk } from '../src/auto.js';
import type { Backend } from '../src/foreman.js';
import { classifyToolUse } from '../src/policy.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const hooks: ToolHooks = { onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {} };
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

describe('the lead sizes the team', () => {
  let h: Harness;
  let home: string;
  let actions: Array<[string, string]>;

  const start = (args: string[] = []) => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', ...args]);
    actions = [];
    h.fm.backend = {
      name: 'claude',
      onAgentAction: async (id: string, action: string) => {
        actions.push([id, action]);
        h.fm.setAgent(id, { active: action === 'spawn' });
      },
    } as unknown as Backend;
    for (const id of ['rowan', 'tove']) h.fm.setAgent(id, { active: false });
  };
  const tool = (name: string) => agentTools(h.fm, 'marlow', 'lead', hooks).find((t) => t.name === name)!;

  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
  });

  it('auto mode brings the worker on shift at once', async () => {
    start(['--auto']);
    const r = await tool('request_worker').handler({ worker: 'rowan', reason: 'two parallel tasks' });
    expect(text(r)).toMatch(/on shift/);
    expect(actions).toEqual([['rowan', 'spawn']]);
    expect(h.toasts).toHaveLength(0);
  });

  it('otherwise asks the user, and a No keeps the worker off shift', async () => {
    start();
    const pending = tool('request_worker').handler({ worker: 'tove', reason: 'docs' });
    await until(() => h.fm.decisions.open().length === 1);
    const d = h.fm.decisions.open()[0]!;
    expect(d.options).toEqual(['Yes', 'No']);
    await h.fm.answerDecision(d.id, 'No', 'pas maintenant');
    expect(text(await pending)).toMatch(/keeps Tove off shift: pas maintenant/);
    expect(actions).toEqual([]);
  });

  it('release_worker refuses while the worker still has a task, then sends it off shift', async () => {
    start(['--auto']);
    await tool('request_worker').handler({ worker: 'rowan', reason: 'x' });
    const t = h.fm.tasks.create({ title: 'Write docs', assignee: 'rowan', createdBy: 'marlow' });
    const busy = await tool('release_worker').handler({ worker: 'rowan' });
    expect(busy.isError).toBe(true);
    expect(text(busy)).toMatch(new RegExp(`${t.id} \\(todo\\)`));
    h.fm.tasks.setStatus(t.id, 'cancelled', { force: true });
    expect(text(await tool('release_worker').handler({ worker: 'rowan' }))).toMatch(/off shift/);
    expect(actions.at(-1)).toEqual(['rowan', 'stop']);
  });

  it('only workers can be requested', async () => {
    start(['--auto']);
    const r = await tool('request_worker').handler({ worker: 'marlow', reason: 'x' });
    expect(r.isError).toBe(true);
  });
});

describe('a worker listing branches of another repository', () => {
  it('is a read that auto mode lets through; creating or deleting branches still asks', () => {
    const ctx = { role: 'worker' as const, cwd: process.cwd(), tempDirs: [] };
    const other = 'D:/Somewhere/else-repo';
    const ask = (command: string) => {
      const v = classifyToolUse('Bash', { command }, ctx);
      return v.action === 'ask' ? (autoRisk(v, { role: 'worker', workspaces: [] }) ?? 'auto') : v.action;
    };
    expect(ask(`git -C ${other} branch -a --list 'codex/*' -v`)).toBe('auto');
    expect(ask(`git -C ${other} tag --list`)).toBe('auto');
    expect(ask(`git -C ${other} config --get remote.origin.url`)).toBe('auto');
    expect(ask(`git -C ${other} branch -D old`)).toMatch(/git/);
    expect(ask(`git -C ${other} branch nouvelle`)).toMatch(/git/);
  });
});
