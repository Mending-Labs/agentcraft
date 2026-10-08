// A shared Foreman ("mergeRequests" in config.json): an approved merge pushes the worker's branch
// and opens a GitLab merge request instead of merging into a checkout nobody works in.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitlabProject } from '../src/mergerequests.js';
import { MERGE_OPTIONS } from '../src/protocol.js';
import { git } from '../src/util/git.js';
import { demoRepo, makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

describe('GitLab project from a remote URL', () => {
  it('reads https, scp-like and ssh URLs (ssh.gitlab.<domain> -> gitlab.<domain>)', () => {
    expect(gitlabProject('https://gitlab.mending-labs.com/mending-labs/mendings-core.git')).toEqual({ base: 'https://gitlab.mending-labs.com', project: 'mending-labs/mendings-core' });
    expect(gitlabProject('git@ssh.gitlab.mending-labs.com:grp/sub/proj.git')).toEqual({ base: 'https://gitlab.mending-labs.com', project: 'grp/sub/proj' });
    expect(gitlabProject('ssh://git@ssh.gitlab.mending-labs.com:2222/grp/proj')).toEqual({ base: 'https://gitlab.mending-labs.com', project: 'grp/proj' });
    expect(gitlabProject('/srv/repos/x.git')).toBeUndefined();
  });
});

describe('approved merges as GitLab merge requests', () => {
  let h: Harness;
  let home: string;
  let repoPath: string;
  let bare: string;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(async () => {
    home = tempDir();
    repoPath = await demoRepo();
    bare = path.join(path.dirname(repoPath), 'origin.git');
    await git(path.dirname(repoPath), ['init', '--bare', '-q', bare]);
    // the URL GitLab knows; git rewrites it to the bare repo (a real push: no pushurl)
    await git(repoPath, ['remote', 'add', 'origin', 'https://gitlab.test/grp/demo-app.git']);
    await git(repoPath, ['config', `url.${bare}.insteadOf`, 'https://gitlab.test/grp/demo-app.git']);
    fs.writeFileSync(path.join(home, 'gitlab-token'), 'glpat-test\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mergeRequests: { tokenFile: path.join(home, 'gitlab-token') } }));
    calls.length = 0;
    // the bare repo stands for GitLab: allow the file transport for this test only
    vi.stubEnv('AGENTCRAFT_GIT_PROTOCOLS', 'file');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ iid: 42, web_url: 'https://gitlab.test/grp/demo-app/-/merge_requests/42' }), { status: 201 });
    });
    h = makeForeman(home, ['--backend', 'claude']);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await h.fm.close();
    rmrf(home);
    rmrf(path.dirname(repoPath));
  });

  it('pushes the branch, opens the MR, closes the task, leaves the checkout alone', async () => {
    const repo = await h.fm.repos.add(repoPath);
    const before = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const t = h.fm.tasks.create({ title: 'Add a file', assignee: 'kit', repoId: repo.id, createdBy: 'marlow' });
    const wt = await h.fm.repos.createWorktree(repo.id, 'kit', t);
    fs.writeFileSync(path.join(wt.path, 'added.txt'), 'hello\n');
    h.fm.tasks.update(t.id, { worktree: wt.id, ci: 'pass', summary: 'Adds added.txt' });
    h.fm.tasks.setStatus(t.id, 'review', { force: true });
    const d = h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], taskId: t.id, repoId: repo.id, worktree: wt.id });
    await h.fm.answerDecision(d.id, 'Merge');
    await until(() => h.fm.tasks.get(t.id)!.status === 'done');

    // the branch is on the remote, the base branch was not pushed nor changed
    const remoteHeads = (await git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).stdout.trim().split('\n');
    expect(remoteHeads).toEqual([`refs/heads/${wt.branch}`]);
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gitlab.test/api/v4/projects/grp%2Fdemo-app/merge_requests');
    expect((calls[0]!.init!.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('glpat-test');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body).toMatchObject({ source_branch: wt.branch, target_branch: repo.branch, title: `${t.id}: Add a file`, remove_source_branch: true });
    expect(body.description).toMatch(/Adds added\.txt[\s\S]*Approved in AgentCraft/);
    expect(h.fm.store.data.feed.some((f) => f.kind === 'merge' && /Merge request !42 opened/.test(f.text))).toBe(true);
    expect(h.fm.repos.findWorktree(repo.id, wt.id)!.status).toBe('merged');
  });

  it('no token: the merge is refused and the decision stays open', async () => {
    fs.writeFileSync(path.join(home, 'gitlab-token'), '');
    const repo = await h.fm.repos.add(repoPath);
    const t = h.fm.tasks.create({ title: 'Add a file', assignee: 'kit', repoId: repo.id, createdBy: 'marlow' });
    const wt = await h.fm.repos.createWorktree(repo.id, 'kit', t);
    fs.writeFileSync(path.join(wt.path, 'added.txt'), 'hello\n');
    h.fm.tasks.update(t.id, { worktree: wt.id, ci: 'pass' });
    h.fm.tasks.setStatus(t.id, 'review', { force: true });
    const d = h.fm.createDecision({ agentId: 'marlow', kind: 'merge', question: 'Merge?', options: [...MERGE_OPTIONS], taskId: t.id, repoId: repo.id, worktree: wt.id });
    await h.fm.answerDecision(d.id, 'Merge');
    expect(h.fm.decisions.get(d.id)!.status).toBe('open');
    expect(h.fm.decisions.get(d.id)!.context).toMatch(/GitLab token/);
    expect(calls).toHaveLength(0);
  });
});

describe('the checkouts of a shared Foreman follow their origin', () => {
  it('a new worktree starts from origin/main (fast-forward), not from a stale local main', async () => {
    const { execFileSync } = await import('node:child_process');
    const home = tempDir();
    const repoPath = await demoRepo();
    const bare = path.join(path.dirname(repoPath), 'origin.git');
    const other = path.join(path.dirname(repoPath), 'someone-else');
    const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
    sh(path.dirname(repoPath), 'init', '--bare', '-q', bare);
    sh(repoPath, 'remote', 'add', 'origin', 'https://gitlab.test/grp/demo-app.git');
    sh(repoPath, 'config', `url.${bare}.insteadOf`, 'https://gitlab.test/grp/demo-app.git');
    const branch = sh(repoPath, 'branch', '--show-current');
    sh(repoPath, '-c', 'protocol.file.allow=always', 'push', '-q', 'origin', branch);
    // someone merges an MR in GitLab meanwhile
    sh(path.dirname(repoPath), '-c', 'protocol.file.allow=always', 'clone', '-q', '-b', branch, bare, other);
    fs.writeFileSync(path.join(other, 'merged-in-gitlab.txt'), 'x\n');
    sh(other, 'add', '.');
    sh(other, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'merged in GitLab');
    sh(other, '-c', 'protocol.file.allow=always', 'push', '-q', 'origin', branch);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ mergeRequests: { tokenSecret: 'Gitlab' } }));
    vi.stubEnv('AGENTCRAFT_GIT_PROTOCOLS', 'file');
    const h = makeForeman(home, ['--backend', 'claude']);
    try {
      const repo = await h.fm.repos.add(repoPath);
      const t = h.fm.tasks.create({ title: 'Next', assignee: 'kit', repoId: repo.id, createdBy: 'marlow' });
      const wt = await h.fm.repos.createWorktree(repo.id, 'kit', t);
      expect(fs.existsSync(path.join(wt.path, 'merged-in-gitlab.txt'))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, 'merged-in-gitlab.txt'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await h.fm.close();
      rmrf(home);
      rmrf(path.dirname(repoPath));
    }
  });
});
