// Workspaces: a folder of repos the lead reorganises through a plan the user approves. Real
// directories and real git repos / linked worktrees: a manual move breaks their links, the
// Foreman must re-link them with `git worktree repair`.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools, type ToolHooks } from '../src/agents/tools.js';
import { git } from '../src/util/git.js';
import { applyPlan, checkPlan, describeLinks, TRASH_DIR, WORKSPACE_OPTIONS } from '../src/workspace.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

let ws: string;

async function repo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  await git(dir, ['add', '.']);
  await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
}

const gitOk = async (dir: string) => (await git(dir, ['status', '--porcelain'], { allowFail: true })).code === 0;
const worktreePaths = async (main: string) =>
  (await git(main, ['worktree', 'list', '--porcelain'])).stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice(9)).toLowerCase());

beforeEach(() => {
  ws = fs.realpathSync(tempDir('ac-ws-'));
});
afterEach(() => rmrf(ws));

describe('checkPlan', () => {
  it('refuses paths outside the workspace, .git entries, protected paths and the workspace itself', async () => {
    fs.mkdirSync(path.join(ws, 'core', '.git'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'misc'));
    const outside = tempDir('ac-out-');
    try {
      const r = await checkPlan(ws, [
        { op: 'move', path: outside, to: 'x' },
        { op: 'trash', path: 'core/.git' },
        { op: 'move', path: 'core', to: 'misc/core' },
        { op: 'trash', path: '.' },
        { op: 'move', path: 'misc', to: 'misc/inner' },
      ], { protectedPaths: [path.join(ws, 'core')] });
      expect(r.plan).toBeUndefined();
      expect(r.errors.join('\n')).toMatch(/op 1 .*not inside the workspace/);
      expect(r.errors.join('\n')).toMatch(/op 2 .*\.git/);
      expect(r.errors.join('\n')).toMatch(/op 3 .*AgentCraft uses/);
      expect(r.errors.join('\n')).toMatch(/op 4 .*not inside the workspace/);
      expect(r.errors.join('\n')).toMatch(/op 5 .*into itself/);
    } finally {
      rmrf(outside);
    }
  });

  it('protects the folders around a protected path too (moving a parent would move it)', async () => {
    fs.mkdirSync(path.join(ws, 'group', 'core'), { recursive: true });
    const r = await checkPlan(ws, [{ op: 'move', path: 'group', to: 'other' }], { protectedPaths: [path.join(ws, 'group', 'core')] });
    expect(r.errors[0]).toMatch(/AgentCraft uses/);
  });

  it('replays the plan in order: later operations see earlier mkdirs and moves', async () => {
    fs.mkdirSync(path.join(ws, 'a'));
    fs.writeFileSync(path.join(ws, 'a', 'f.txt'), 'x');
    const ok = await checkPlan(ws, [
      { op: 'mkdir', path: 'archive' },
      { op: 'move', path: 'a', to: 'archive/a' },
      { op: 'move', path: 'archive/a/f.txt', to: 'archive/f.txt' },
    ], { protectedPaths: [] });
    expect(ok.errors).toEqual([]);

    const bad = await checkPlan(ws, [
      { op: 'move', path: 'a', to: 'b' },
      { op: 'trash', path: 'a' },
      { op: 'move', path: 'b', to: 'missing/b' },
      { op: 'mkdir', path: 'b' },
    ], { protectedPaths: [] });
    expect(bad.errors.join('\n')).toMatch(/op 2 .*does not exist any more/);
    expect(bad.errors.join('\n')).toMatch(/op 3 .*destination folder .* does not exist/);
    expect(bad.errors.join('\n')).toMatch(/op 4 .*already exists/);
  });
});

describe('applyPlan', () => {
  it('moves, trashes (never deletes) and journals the reverse moves', async () => {
    fs.mkdirSync(path.join(ws, 'old'));
    fs.writeFileSync(path.join(ws, 'notes.txt'), 'n');
    const { plan } = await checkPlan(ws, [
      { op: 'mkdir', path: 'docs' },
      { op: 'move', path: 'notes.txt', to: 'docs/notes.txt' },
      { op: 'trash', path: 'old', why: 'empty' },
    ], { protectedPaths: [], now: new Date(2026, 9, 8, 9, 30, 0) });
    const res = await applyPlan(plan!, path.join(ws, '..', `${path.basename(ws)}-journal`));
    try {
      expect(res.failed).toBeUndefined();
      expect(fs.readFileSync(path.join(ws, 'docs', 'notes.txt'), 'utf8')).toBe('n');
      expect(fs.existsSync(path.join(ws, 'old'))).toBe(false);
      expect(fs.statSync(path.join(ws, TRASH_DIR, '2026-10-08_093000', 'old')).isDirectory()).toBe(true);
      const journal = JSON.parse(fs.readFileSync(res.journal, 'utf8'));
      expect(journal.undo[0]).toEqual({ op: 'move', path: path.join(ws, TRASH_DIR, '2026-10-08_093000', 'old'), to: path.join(ws, 'old') });
    } finally {
      rmrf(path.dirname(res.journal));
    }
  });

  it('re-links a moved main repo and its moved linked worktree', async () => {
    const main = path.join(ws, 'core');
    await repo(main);
    await git(main, ['worktree', 'add', '-q', '-b', 'feat', path.join(ws, 'core-feat')]);
    const { plan, errors } = await checkPlan(ws, [
      { op: 'mkdir', path: 'repos' },
      { op: 'mkdir', path: 'worktrees' },
      { op: 'move', path: 'core', to: 'repos/core' },
      { op: 'move', path: 'core-feat', to: 'worktrees/core-feat' },
    ], { protectedPaths: [] });
    expect(errors).toEqual([]);
    expect(describeLinks(plan!).join('\n')).toMatch(/git worktree repair/);
    const res = await applyPlan(plan!, path.join(ws, '.journal'));
    expect(res.failed).toBeUndefined();
    expect(res.repairs.every((r) => r.ok)).toBe(true);
    const newMain = path.join(ws, 'repos', 'core');
    const newWt = path.join(ws, 'worktrees', 'core-feat');
    expect(await gitOk(newWt)).toBe(true);
    expect(await worktreePaths(newMain)).toContain(newWt.toLowerCase());
    expect((await git(newWt, ['branch', '--show-current'])).stdout.trim()).toBe('feat');
  });

  it('re-links a worktree trashed away from its main repo', async () => {
    const main = path.join(ws, 'core');
    await repo(main);
    await git(main, ['worktree', 'add', '-q', '-b', 'old', path.join(ws, 'core-old')]);
    const { plan } = await checkPlan(ws, [{ op: 'trash', path: 'core-old' }], { protectedPaths: [] });
    const res = await applyPlan(plan!, path.join(ws, '.journal'));
    expect(res.repairs).toHaveLength(1);
    const trashed = mapTrash(plan!.trashDir, 'core-old');
    expect(await gitOk(trashed)).toBe(true);
    expect(await worktreePaths(main)).toContain(trashed.toLowerCase());
  });
});

const mapTrash = (trashDir: string, rel: string) => path.join(trashDir, rel);

describe('propose_workspace_changes (lead tool)', () => {
  let h: Harness;
  let home: string;
  const hooks: ToolHooks = { onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {} };

  beforeEach(() => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude', '--workspace', ws]);
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
  });

  const leadTool = () => agentTools(h.fm, 'marlow', 'lead', hooks).find((t) => t.name === 'propose_workspace_changes')!;
  const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

  it('is a lead tool only, and only with workspaces', () => {
    expect(leadTool()).toBeDefined();
    expect(agentTools(h.fm, 'kit', 'worker', hooks).some((t) => t.name === 'propose_workspace_changes')).toBe(false);
  });

  it('returns validation errors without asking the user', async () => {
    const r = await leadTool().handler({ workspace: ws, summary: 's', operations: [{ op: 'move', path: 'nope', to: 'x' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/does not exist/);
    expect(h.fm.decisions.open()).toHaveLength(0);
  });

  it('applies the plan only after Apply', async () => {
    fs.mkdirSync(path.join(ws, 'tmp'));
    const pending = leadTool().handler({ workspace: ws, summary: 'tidy', operations: [{ op: 'trash', path: 'tmp' }] });
    await until(() => h.fm.decisions.open().length === 1);
    const d = h.fm.decisions.open()[0]!;
    expect(d.options).toEqual([...WORKSPACE_OPTIONS]);
    expect(d.context).toMatch(/1\. trash tmp/);
    expect(fs.existsSync(path.join(ws, 'tmp'))).toBe(true);
    await h.fm.answerDecision(d.id, 'Apply');
    const r = await pending;
    expect(text(r)).toMatch(/Applied all 1 operations/);
    expect(fs.existsSync(path.join(ws, 'tmp'))).toBe(false);
    expect(fs.readdirSync(path.join(ws, TRASH_DIR))).toHaveLength(1);
  });

  it('changes nothing when rejected, and passes the feedback back', async () => {
    fs.mkdirSync(path.join(ws, 'keep'));
    const pending = leadTool().handler({ workspace: ws, summary: 'tidy', operations: [{ op: 'trash', path: 'keep' }] });
    await until(() => h.fm.decisions.open().length === 1);
    await h.fm.answerDecision(h.fm.decisions.open()[0]!.id, 'Reject', 'garde keep');
    const r = await pending;
    expect(text(r)).toMatch(/did not approve.*garde keep/s);
    expect(fs.existsSync(path.join(ws, 'keep'))).toBe(true);
  });
});
