// Merge requests instead of local merges (a shared Foreman on a server, config "mergeRequests").
//
// On a server nobody works in the checkouts: they are clones the Foreman keeps up to date from
// their origin. An approved merge pushes the worker's branch to origin and opens a GitLab merge
// request into the base branch; people review and merge it in GitLab, as any other change.
//
// This and pulls.ts are the only places the Foreman talks to a remote. Agents still have no git
// network access (gitsafety.ts): only the Foreman pushes, only an approved branch, never a base
// branch. The token is the bot account's (a GitLab user with Developer access to the projects).
import fs from 'node:fs';

export interface MergeRequestConfig {
  /** file holding the GitLab token (owner-only); read at each use, so a rotation needs no restart */
  tokenFile?: string;
  /** or a vault secret name (/secret set) */
  tokenSecret?: string;
  /** the remote to push to (default "origin") */
  remote: string;
  /** GitLab deletes the branch once the MR is merged */
  removeSourceBranch: boolean;
}

export function parseMergeRequests(raw: unknown): MergeRequestConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const cfg: MergeRequestConfig = { remote: str(o.remote) ?? 'origin', removeSourceBranch: o.removeSourceBranch !== false };
  const tokenFile = str(o.tokenFile);
  const tokenSecret = str(o.tokenSecret);
  if (tokenFile) cfg.tokenFile = tokenFile;
  if (tokenSecret) cfg.tokenSecret = tokenSecret;
  if (!cfg.tokenFile && !cfg.tokenSecret) throw new Error('config "mergeRequests" needs "tokenFile" or "tokenSecret" (the GitLab token of the bot account)');
  return cfg;
}

export function mergeRequestToken(cfg: MergeRequestConfig, secret: (name: string) => string | undefined): string {
  if (cfg.tokenFile) {
    try {
      const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
      if (t) return t;
    } catch (e) {
      throw new Error(`cannot read the GitLab token file ${cfg.tokenFile}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  const t = cfg.tokenSecret ? secret(cfg.tokenSecret) : undefined;
  if (t) return t;
  throw new Error(`no GitLab token for merge requests (${cfg.tokenFile ? `file ${cfg.tokenFile} is empty` : `secret ${cfg.tokenSecret} is not set: /secret set ${cfg.tokenSecret}`})`);
}

/** "https://gitlab.x.com/group/sub/proj.git", "git@gitlab.x.com:group/proj.git", "ssh://git@host:2222/g/p" -> host + path. */
export function gitlabProject(remoteUrl: string): { base: string; project: string } | undefined {
  const u = remoteUrl.trim();
  let host: string | undefined;
  let p: string | undefined;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(u);
  if (scp) {
    host = scp[1];
    p = scp[2];
  } else {
    try {
      const url = new URL(u);
      host = url.hostname;
      p = url.pathname;
      // ssh.gitlab.<domain> (SSH on its own name) -> the web/API name
      if (url.protocol === 'ssh:') host = host.replace(/^ssh\./, '');
    } catch {
      return undefined;
    }
  }
  if (scp && host) host = host.replace(/^ssh\./, '');
  const project = p?.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!host || !project || !project.includes('/')) return undefined;
  return { base: `https://${host}`, project };
}

export interface OpenedMergeRequest {
  iid: number;
  url: string;
  /** an open MR for this branch already existed (pushed again) */
  existed: boolean;
}

/** Open (or find the open) merge request of `branch` into `target`. */
export async function openMergeRequest(
  opts: { base: string; project: string; token: string; branch: string; target: string; title: string; description: string; removeSourceBranch: boolean },
  fetchFn: typeof fetch = fetch,
): Promise<OpenedMergeRequest> {
  const api = `${opts.base}/api/v4/projects/${encodeURIComponent(opts.project)}/merge_requests`;
  const headers = { 'PRIVATE-TOKEN': opts.token, 'Content-Type': 'application/json' };
  const res = await fetchFn(api, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source_branch: opts.branch, target_branch: opts.target, title: opts.title.slice(0, 255), description: opts.description, remove_source_branch: opts.removeSourceBranch }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) {
    const mr = (await res.json()) as { iid: number; web_url: string };
    return { iid: mr.iid, url: mr.web_url, existed: false };
  }
  if (res.status === 409) {
    const q = `${api}?state=opened&source_branch=${encodeURIComponent(opts.branch)}&target_branch=${encodeURIComponent(opts.target)}`;
    const found = await fetchFn(q, { headers, signal: AbortSignal.timeout(30_000) });
    const list = found.ok ? ((await found.json()) as Array<{ iid: number; web_url: string }>) : [];
    if (list[0]) return { iid: list[0].iid, url: list[0].web_url, existed: true };
  }
  const body = await res.text().catch(() => '');
  throw new Error(`GitLab refused the merge request (HTTP ${res.status}): ${body.slice(0, 200)}`);
}
