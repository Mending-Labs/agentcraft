// A merge refused because the user's checkout has uncommitted changes offers two more answers:
// commit them (as the user) then merge, or stash them around the merge. Real repos.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERGE_LOCAL_OPTIONS, MERGE_OPTIONS } from '../src/protocol.js';
import { git } from '../src/util/git.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

describe('merging into a checkout with the user\'s own changes', () => {
  let h: Harness;
  let home: string;
  let repoPath: string;

  beforeEach(async () => {
    home = tempDir();
    repoPath = await demoRepo();
    h = makeForeman(home, ['--backend', 'claude']);
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
    rmrf(path.dirname(repoPath));
  });

  /** A task whose worktree adds a file, in review, with its merge decision; the user edits README.md meanwhile. */
  async function setup() {
    const repo = await h.fm.repos.add(repoPath);
    const t = h.fm.tasks.create({ title: 'Add a file', assignee: 'kit', repoId: repo.id, createdBy: 'marlow' });
    const wt = await h.fm.repos.createWorktree(repo.id, 'kit', t);
    fs.writeFileSync(path.join(wt.path, 'added.txt'), 'hello\n');
    await h.fm.repos.refresh(repo.id);
    h.fm.tasks.update(t.id, { worktree: wt.id, ci: 'pass' });
    h.fm.tasks.setStatus(t.id, 'review', { force: true });
    const d = h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], taskId: t.id, repoId: repo.id, worktree: wt.id });
    fs.appendFileSync(path.join(repoPath, 'README.md'), '\nmy own local note\n');
    // a plain Merge is refused, and the decision now offers the two local options
    await h.fm.answerDecision(d.id, 'Merge');
    expect(h.fm.decisions.get(d.id)!.status).toBe('open');
    expect(h.fm.decisions.get(d.id)!.options).toEqual([...MERGE_OPTIONS, ...MERGE_LOCAL_OPTIONS]);
    return { t, d };
  }

  it('commit my changes, then merge: the user\'s change is committed (with their message) and the task merged', async () => {
    const { t, d } = await setup();
    await h.fm.answerDecision(d.id, MERGE_LOCAL_OPTIONS[0], 'docs: ma note locale');
    await until(() => h.fm.tasks.get(t.id)!.status === 'done');
    const log = (await git(repoPath, ['log', '--format=%s', '-3'])).stdout;
    expect(log).toMatch(/docs: ma note locale/);
    expect(fs.existsSync(path.join(repoPath, 'added.txt'))).toBe(true);
    expect((await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()).toBe('');
  });

  it('stash, merge, restore: the merge lands and the user\'s change is back, uncommitted', async () => {
    const { t, d } = await setup();
    await h.fm.answerDecision(d.id, MERGE_LOCAL_OPTIONS[1]);
    await until(() => h.fm.tasks.get(t.id)!.status === 'done');
    expect(fs.existsSync(path.join(repoPath, 'added.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toMatch(/my own local note/);
    expect((await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])).stdout).toMatch(/README\.md/);
    expect((await git(repoPath, ['stash', 'list'])).stdout.trim()).toBe('');
  });
});
