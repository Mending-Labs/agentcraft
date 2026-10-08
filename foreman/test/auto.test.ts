// Auto mode: the Foreman answers decisions for the user (permissions except risky ones,
// lead-approved merges with passing tests, workspace plans, questions), without a bell or toast.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools, type ToolHooks } from '../src/agents/tools.js';
import { autoRisk, parseAuto } from '../src/auto.js';
import { classifyToolUse, type Verdict } from '../src/policy.js';
import { TRASH_DIR } from '../src/workspace.js';
import { demoRepo, makeForeman, rmrf, tempDir, testConfig, until, type Harness } from './helpers.js';

const ask = (reason: string, ...ruleKeys: string[]): Extract<Verdict, { action: 'ask' }> => ({ action: 'ask', reason, ruleKey: ruleKeys[0] ?? 'x', ruleKeys: ruleKeys.length ? ruleKeys : ['x'] });
const hooks: ToolHooks = { onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {} };
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');

describe('auto mode config', () => {
  it('is off by default; true, an object or --auto turns it on', () => {
    const home = tempDir();
    try {
      expect(testConfig(home).auto.enabled).toBe(false);
      expect(testConfig(home, ['--auto']).auto).toMatchObject({ enabled: true, permissions: true, merges: true, workspace: true, questions: true });
      expect(parseAuto({ merges: false }).enabled).toBe(true);
      expect(parseAuto({ merges: false }).merges).toBe(false);
      expect(parseAuto(true, false).enabled).toBe(false);
    } finally {
      rmrf(home);
    }
  });
});

describe('autoRisk (which permission prompts still ask)', () => {
  const worker = { role: 'worker' as const, workspaces: ['D:\\Work'] };
  it('lets ordinary prompts through', () => {
    expect(autoRisk(ask('npm install changes node_modules', 'Bash:npm install'), worker)).toBeUndefined();
    expect(autoRisk(ask('network access', 'Bash:net:curl:example.com'), worker)).toBeUndefined();
    expect(autoRisk(ask('unknown program', 'Bash:exact:abc'), worker)).toBeUndefined();
    expect(autoRisk(ask('git status on a repository outside the worktree: D:\\x', 'Bash:outside:git status:rtree:d:\\x'), worker)).toBeUndefined();
    expect(autoRisk(ask('writes', 'Bash:outside:mv:w:D:\\Work\\a'), worker)).toBeUndefined();
    expect(autoRisk(ask('write', 'Write:D:\\Work\\notes'), worker)).toBeUndefined();
  });
  it.runIf(process.platform === 'win32')('lets the lead run a PowerShell script proven read-only within its repo and workspaces', () => {
    const lead = { role: 'lead' as const, workspaces: ['D:\\Work'], tool: 'PowerShell', leadRoots: ['D:\\Repo', 'D:\\Work'] };
    const v = ask('the command name comes from a variable or substitution and cannot be checked', 'lead:Bash:exact:1');
    expect(autoRisk(v, { ...lead, command: "Get-ChildItem -LiteralPath 'D:\\Work' -Directory | ForEach-Object { $f = $_; git -C $f.FullName status --short }" })).toBeUndefined();
    expect(autoRisk(v, { ...lead, command: "Get-ChildItem 'D:\\Work' | Remove-Item -Recurse" })).toMatch(/Remove-Item/);
    expect(autoRisk(v, { ...lead, command: "Get-Content 'C:\\Users\\me\\.ssh\\id_rsa'" })).toMatch(/secrets file/);
    expect(autoRisk(v, { ...lead, tool: 'Bash', command: 'ls D:/Work' })).toMatch(/lead/);
  });

  it('keeps the risky ones for the user', () => {
    expect(autoRisk(ask('anything'), { role: 'lead', workspaces: [] })).toMatch(/lead/);
    expect(autoRisk(ask('process or system command (taskkill)', 'Bash:exact:1'), worker)).toMatch(/system/);
    expect(autoRisk(ask('rm -r', 'Bash:outside:rm:wtree:D:\\Work\\old'), worker)).toMatch(/recursive/);
    expect(autoRisk(ask('writes', 'Bash:outside:cp:w:C:\\Windows'), worker)).toMatch(/writing in/);
    expect(autoRisk(ask('write', 'Edit:C:\\Users\\x'), worker)).toMatch(/writing in/);
    expect(autoRisk(ask('editing git internals (.git): x', 'Write:.git:x'), worker)).toMatch(/git/);
    expect(autoRisk(ask("points git at another repository, work tree or index (it could move the user's checked-out branch)", 'Bash:exact:2'), worker)).toMatch(/git/);
    expect(autoRisk(ask('npm install --global changes tools outside the worktree', 'Bash:exact:3'), worker)).toMatch(/global/);
  });
});

describe('the lead reading git repos in its workspaces (policy, auto mode or not)', () => {
  it('git status / worktree list there need no prompt; elsewhere, or changing them, still ask', async () => {
    const ws = fs.realpathSync(tempDir('ac-ws-'));
    const repoDir = await demoRepo();
    try {
      const inWs = path.join(ws, 'other');
      fs.cpSync(repoDir, inWs, { recursive: true });
      // no temp dirs: the test folders live in the temp dir, which the policy treats as scratch space
      const ctx = { role: 'lead' as const, cwd: repoDir, readDirs: [ws], tempDirs: [] };
      expect(classifyToolUse('Bash', { command: `git -C "${inWs}" status --short` }, ctx).action).toBe('allow');
      expect(classifyToolUse('Bash', { command: `git -C "${inWs}" worktree list --porcelain` }, ctx).action).toBe('allow');
      expect(classifyToolUse('Bash', { command: `git -C "${inWs}" worktree remove x` }, ctx).action).not.toBe('allow');
      expect(classifyToolUse('Bash', { command: `git -C "${inWs}" status` }, { ...ctx, readDirs: [] }).action).not.toBe('allow');
    } finally {
      rmrf(ws);
      rmrf(path.dirname(repoDir));
    }
  });
});

describe('auto mode answers', () => {
  let h: Harness;
  let home: string;
  let ws: string;

  beforeEach(() => {
    home = tempDir();
    ws = fs.realpathSync(tempDir('ac-ws-'));
    h = makeForeman(home, ['--backend', 'claude', '--workspace', ws, '--auto']);
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
    rmrf(ws);
  });

  it('is announced in foreman.status and toggled live with auto.set', async () => {
    expect(h.fm.status.auto).toBe(true);
    const replies: unknown[] = [];
    await h.fm.handle({ v: 1, type: 'auto.set', id: 'c1', enabled: false }, (m) => replies.push(m));
    expect(h.fm.status.auto).toBe(false);
    expect(h.events.some((e) => e.type === 'foreman.status' && e.status.auto === false)).toBe(true);
  });

  it('answers a question with the recommended option, without a toast', async () => {
    const tool = agentTools(h.fm, 'kit', 'worker', hooks).find((t) => t.name === 'ask_user')!;
    const r = await tool.handler({ question: 'Which format?', options: ['JSON', 'CSV'] });
    expect(text(r)).toMatch(/Auto mode .*answered: JSON/);
    expect(h.fm.decisions.list().at(-1)).toMatchObject({ status: 'answered', answer: { option: 'JSON' } });
    expect(h.toasts).toHaveLength(0);
  });

  it('tells the agent to decide when a question has no options', async () => {
    const tool = agentTools(h.fm, 'kit', 'worker', hooks).find((t) => t.name === 'ask_user')!;
    const r = await tool.handler({ question: 'What name?' });
    expect(text(r)).toMatch(/decide yourself/);
  });

  it('applies a workspace plan without the podium', async () => {
    fs.mkdirSync(path.join(ws, 'tmp'));
    const tool = agentTools(h.fm, 'marlow', 'lead', hooks).find((t) => t.name === 'propose_workspace_changes')!;
    const r = await tool.handler({ workspace: ws, summary: 'tidy', operations: [{ op: 'trash', path: 'tmp' }] });
    expect(text(r)).toMatch(/Applied all 1 operations/);
    expect(fs.existsSync(path.join(ws, TRASH_DIR))).toBe(true);
    expect(h.fm.decisions.open()).toHaveLength(0);
  });

  it('asks again once auto mode is off', async () => {
    h.fm.setAuto(false);
    const tool = agentTools(h.fm, 'kit', 'worker', hooks).find((t) => t.name === 'ask_user')!;
    const pending = tool.handler({ question: 'Which format?', options: ['JSON', 'CSV'] });
    await until(() => h.fm.decisions.open().length === 1);
    await h.fm.answerDecision(h.fm.decisions.open()[0]!.id, 'CSV');
    expect(text(await pending)).toMatch(/Alex answered: CSV/);
  });

  describe('merges', () => {
    let repoPath: string;
    beforeEach(async () => {
      repoPath = await demoRepo();
    });
    afterEach(() => rmrf(path.dirname(repoPath)));

    async function taskInReview(ci: 'pass' | 'fail') {
      const repo = await h.fm.repos.add(repoPath);
      const t = h.fm.tasks.create({ title: 'Add a file', assignee: 'kit', repoId: repo.id, createdBy: 'marlow' });
      const wt = await h.fm.repos.createWorktree(repo.id, 'kit', t);
      fs.writeFileSync(path.join(wt.path, 'added.txt'), 'hello\n');
      await h.fm.repos.refresh(repo.id);
      h.fm.tasks.update(t.id, { worktree: wt.id, ci });
      h.fm.tasks.setStatus(t.id, 'review', { force: true });
      return { t, repo };
    }

    it('merges a lead-approved task whose tests pass', async () => {
      const { t } = await taskInReview('pass');
      const tool = agentTools(h.fm, 'marlow', 'lead', hooks).find((x) => x.name === 'request_merge')!;
      const r = await tool.handler({ task_id: t.id, summary: 'adds a file' });
      expect(text(r)).toMatch(/Auto mode is merging/);
      await until(() => h.fm.tasks.get(t.id)!.status === 'done');
      // the user's checkout may convert line endings (core.autocrlf)
      expect(fs.readFileSync(path.join(repoPath, 'added.txt'), 'utf8').trimEnd()).toBe('hello');
      expect(h.toasts).toHaveLength(0);
    });

    it('leaves a merge with failing tests to the user', async () => {
      const { t } = await taskInReview('fail');
      const tool = agentTools(h.fm, 'marlow', 'lead', hooks).find((x) => x.name === 'request_merge')!;
      const r = await tool.handler({ task_id: t.id, summary: 'adds a file' });
      expect(text(r)).toMatch(/Merge decision d\d+ sent/);
      expect(h.fm.decisions.open()).toHaveLength(1);
      expect(fs.existsSync(path.join(repoPath, 'added.txt'))).toBe(false);
    });
  });
});
