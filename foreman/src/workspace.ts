// Workspaces: folders that are not repositories (a directory holding many repos, worktrees and
// assorted files) that the lead may tidy up. The lead never touches them itself: it proposes a
// plan of operations, the user approves it on the podium, and the Foreman applies it here.
//
//   mkdir  create one directory (its parent must exist, or be created earlier in the plan)
//   move   rename / move a file or directory
//   trash  move into <workspace>/_corbeille-agentcraft/<stamp>/... : nothing is ever deleted
//
// Every path stays inside the workspace; `.git` entries, repos registered with AgentCraft (and
// anything inside or around them), the AgentCraft checkout and its state are off limits. Git
// repositories and linked worktrees that move are re-linked afterwards with `git worktree repair`
// (a manual move breaks the two-way link between a main repo and its worktrees). Each applied plan
// leaves a journal (with the reverse moves) in <dataDir>/workspace/.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, isInsideOrEqual, writeJsonAtomic } from './util/fsx.js';
import { git } from './util/git.js';

export type WorkspaceOpInput =
  | { op: 'mkdir'; path: string; why?: string }
  | { op: 'move'; path: string; to: string; why?: string }
  | { op: 'trash'; path: string; why?: string };

export interface PlannedOp {
  op: 'mkdir' | 'move' | 'trash';
  /** mkdir: the new directory; move/trash: the source */
  src: string;
  /** move/trash: where it ends up */
  dst?: string;
  why?: string;
}

export interface GitLink {
  /** main worktree of the repository (where `git worktree repair` runs) */
  main: string;
  /** its linked worktrees */
  worktrees: string[];
}

export interface WorkspacePlan {
  root: string;
  trashDir: string;
  ops: PlannedOp[];
  /** repositories whose main checkout or linked worktrees move: re-linked after the plan */
  links: GitLink[];
}

export interface CheckResult {
  plan?: WorkspacePlan;
  errors: string[];
}

export interface ApplyResult {
  applied: PlannedOp[];
  failed?: { op: PlannedOp; error: string };
  repairs: Array<{ main: string; ok: boolean; output: string }>;
  journal: string;
}

export const TRASH_DIR = '_corbeille-agentcraft';
/** options of the decision that approves a plan (the mod shows them translated) */
export const WORKSPACE_OPTIONS = ['Apply', 'Reject'] as const;

const isWin = process.platform === 'win32';
const norm = (p: string) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? r.toLowerCase() : r;
};
const same = (a: string, b: string) => norm(a) === norm(b);
const inside = (child: string, parent: string) => isInsideOrEqual(child, parent);

/** The configured workspace a path or name designates (exact path, or inside one). */
export function findWorkspace(workspaces: string[], given: string): string | undefined {
  const abs = path.resolve(given);
  return workspaces.find((w) => same(w, abs)) ?? workspaces.find((w) => inside(abs, w));
}

type Kind = 'dir' | 'file' | null;

function diskKind(p: string): Kind {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** What exists at `p` after the first `n` planned operations (the disk, replayed backwards). */
function kindAfter(ops: PlannedOp[], n: number, p: string): Kind {
  let cur = p;
  for (let j = n - 1; j >= 0; j--) {
    const o = ops[j]!;
    if (o.op === 'mkdir') {
      if (same(cur, o.src)) return 'dir';
      continue;
    }
    const dst = o.dst!;
    if (inside(cur, dst)) {
      cur = path.join(o.src, path.relative(dst, cur));
      continue;
    }
    if (inside(cur, o.src)) return null;
  }
  return diskKind(cur);
}

/** Where `p` ends up after `ops` (moves and trashes carry everything under their source). */
export function mapPath(ops: PlannedOp[], p: string): string {
  let cur = p;
  for (const o of ops) {
    if (o.op !== 'mkdir' && inside(cur, o.src)) cur = path.join(o.dst!, path.relative(o.src, cur));
  }
  return cur;
}

function stamp(now: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}_${z(now.getHours())}${z(now.getMinutes())}${z(now.getSeconds())}`;
}

const SKIP_DIRS = new Set(['node_modules', '.gradle', 'build', 'dist', 'out', 'target', '.next', '.idea', '.venv', 'venv', '__pycache__']);

/** Git checkouts at or under `dir` (a checkout is not searched further), at most `depth` levels down. */
function findCheckouts(dir: string, depth: number, out: Array<{ path: string; linked: boolean }> = []): Array<{ path: string; linked: boolean }> {
  const dotGit = diskKind(path.join(dir, '.git'));
  if (dotGit) {
    out.push({ path: dir, linked: dotGit === 'file' });
    return out;
  }
  if (depth <= 0) return out;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && e.name !== TRASH_DIR) findCheckouts(path.join(dir, e.name), depth - 1, out);
  }
  return out;
}

/** Main worktree of the repository a checkout belongs to. */
async function mainOf(checkout: string): Promise<string | undefined> {
  const res = await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  if (res.code !== 0) return undefined;
  const common = res.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(path.resolve(common)) : undefined;
}

async function linkedWorktrees(main: string): Promise<string[]> {
  const res = await git(main, ['worktree', 'list', '--porcelain'], { allowFail: true });
  if (res.code !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice(9)))
    .filter((p) => !same(p, main));
}

/**
 * Validate a plan against the disk. `protectedPaths` (registered repos, AgentCraft's own checkout
 * and state) can be neither moved, nor be moved into, nor have anything inside them changed.
 */
export async function checkPlan(root: string, input: WorkspaceOpInput[], opts: { protectedPaths: string[]; now?: Date }): Promise<CheckResult> {
  const errors: string[] = [];
  const rootAbs = path.resolve(root);
  if (diskKind(rootAbs) !== 'dir') return { errors: [`workspace ${rootAbs} is not a directory`] };
  const trashDir = path.join(rootAbs, TRASH_DIR, stamp(opts.now ?? new Date()));
  const ops: PlannedOp[] = [];
  if (!input.length) errors.push('the plan has no operations');

  const resolve = (p: string) => (path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootAbs, p));
  const checkPath = (p: string, what: string): string | undefined => {
    if (!inside(p, rootAbs) || same(p, rootAbs)) return `${what} ${p} is not inside the workspace ${rootAbs}`;
    if (p.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git')) return `${what} ${p} is inside a .git directory`;
    for (const prot of opts.protectedPaths) {
      if (inside(p, prot) || inside(prot, p)) return `${what} ${p} touches ${prot}, which AgentCraft uses (a registered repo or AgentCraft itself): leave it where it is`;
    }
    return undefined;
  };

  input.forEach((raw, i) => {
    const n = `op ${i + 1} (${raw.op})`;
    const src = resolve(raw.path);
    const err = checkPath(src, `${n}: path`);
    if (err) return void errors.push(err);
    const why = raw.why?.trim() || undefined;
    if (raw.op === 'mkdir') {
      if (kindAfter(ops, ops.length, src)) return void errors.push(`${n}: ${src} already exists`);
      if (kindAfter(ops, ops.length, path.dirname(src)) !== 'dir') return void errors.push(`${n}: the parent of ${src} does not exist (add a mkdir for it first)`);
      ops.push({ op: 'mkdir', src, ...(why ? { why } : {}) });
      return;
    }
    if (!kindAfter(ops, ops.length, src)) return void errors.push(`${n}: ${src} does not exist${ops.some((o) => o.op !== 'mkdir' && inside(src, o.src)) ? ' any more (an earlier operation moved it)' : ''}`);
    let dst: string;
    if (raw.op === 'move') {
      if (!raw.to) return void errors.push(`${n}: "to" is missing`);
      dst = resolve(raw.to);
      const derr = checkPath(dst, `${n}: destination`);
      if (derr) return void errors.push(derr);
      if (inside(dst, src)) return void errors.push(`${n}: cannot move ${src} into itself`);
      if (kindAfter(ops, ops.length, dst)) return void errors.push(`${n}: ${dst} already exists`);
      if (kindAfter(ops, ops.length, path.dirname(dst)) !== 'dir') return void errors.push(`${n}: the destination folder ${path.dirname(dst)} does not exist (add a mkdir for it first)`);
      if (inside(dst, path.join(rootAbs, TRASH_DIR))) return void errors.push(`${n}: use a "trash" operation to put something in ${TRASH_DIR}`);
    } else if (raw.op === 'trash') {
      if (inside(src, path.join(rootAbs, TRASH_DIR))) return void errors.push(`${n}: ${src} is already in the trash`);
      dst = path.join(trashDir, path.relative(rootAbs, src));
    } else {
      return void errors.push(`${n}: unknown operation (use mkdir, move or trash)`);
    }
    ops.push({ op: raw.op, src, dst, ...(why ? { why } : {}) });
  });
  if (errors.length) return { errors };

  // git checkouts that move (or whose main repo / worktrees move) must be re-linked afterwards
  const mains = new Map<string, GitLink>();
  for (const o of ops) {
    if (o.op === 'mkdir') continue;
    const original = mapBack(ops, ops.indexOf(o), o.src);
    if (diskKind(original) !== 'dir') continue;
    for (const c of findCheckouts(original, 4)) {
      const main = c.linked ? await mainOf(c.path) : c.path;
      if (!main || mains.has(norm(main))) continue;
      mains.set(norm(main), { main, worktrees: await linkedWorktrees(main) });
    }
  }
  const links = [...mains.values()].filter((l) => l.worktrees.length > 0);
  return { plan: { root: rootAbs, trashDir, ops, links }, errors: [] };
}

/** The on-disk path that `p` (as seen just before operation `n`) comes from. */
function mapBack(ops: PlannedOp[], n: number, p: string): string {
  let cur = p;
  for (let j = n - 1; j >= 0; j--) {
    const o = ops[j]!;
    if (o.op !== 'mkdir' && inside(cur, o.dst!)) cur = path.join(o.src, path.relative(o.dst!, cur));
  }
  return cur;
}

/** One line per operation, paths relative to the workspace. */
export function describePlan(plan: WorkspacePlan): string[] {
  const rel = (p: string) => path.relative(plan.root, p) || '.';
  return plan.ops.map((o, i) => {
    const why = o.why ? `  (${o.why})` : '';
    if (o.op === 'mkdir') return `${i + 1}. mkdir ${rel(o.src)}${why}`;
    if (o.op === 'trash') return `${i + 1}. trash ${rel(o.src)}${why}`;
    return `${i + 1}. move ${rel(o.src)} -> ${rel(o.dst!)}${why}`;
  });
}

/** Git repositories whose links get repaired, as readable lines. */
export function describeLinks(plan: WorkspacePlan): string[] {
  const moved = (p: string) => !same(mapPath(plan.ops, p), p);
  return plan.links
    .filter((l) => moved(l.main) || l.worktrees.some(moved))
    .map((l) => `${l.main}${moved(l.main) ? ` -> ${mapPath(plan.ops, l.main)}` : ''}: git worktree repair (${l.worktrees.filter((w) => moved(w) || moved(l.main)).length} worktree(s))`);
}

function renameWithRetry(src: string, dst: string): void {
  // Windows: an editor, indexer or antivirus holding a handle makes rename fail briefly
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e;
      const until = Date.now() + 250 * (attempt + 1);
      while (Date.now() < until) {
        /* short synchronous wait between retries */
      }
    }
  }
}

/**
 * Apply a checked plan in order; stops at the first failure (what was applied stays applied and is
 * journaled). Moved git checkouts are re-linked either way.
 */
export async function applyPlan(plan: WorkspacePlan, journalDir: string, meta: Record<string, unknown> = {}): Promise<ApplyResult> {
  const applied: PlannedOp[] = [];
  let failed: ApplyResult['failed'];
  for (const o of plan.ops) {
    try {
      if (o.op === 'mkdir') fs.mkdirSync(o.src);
      else {
        if (o.op === 'trash') fs.mkdirSync(path.dirname(o.dst!), { recursive: true });
        renameWithRetry(o.src, o.dst!);
      }
      applied.push(o);
    } catch (e) {
      failed = { op: o, error: (e as Error).message };
      break;
    }
  }

  const repairs: ApplyResult['repairs'] = [];
  for (const l of plan.links) {
    const main = mapPath(applied, l.main);
    const wts = l.worktrees.map((w) => mapPath(applied, w));
    const changed = !same(main, l.main) || wts.some((w, i) => !same(w, l.worktrees[i]!));
    if (!changed || diskKind(main) !== 'dir') continue;
    const existing = wts.filter((w) => diskKind(w) === 'dir');
    const res = await git(main, ['worktree', 'repair', ...existing], { allowFail: true });
    repairs.push({ main, ok: res.code === 0, output: (res.stdout + res.stderr).trim() });
  }

  ensureDir(journalDir);
  const journal = path.join(journalDir, `${path.basename(plan.trashDir)}.json`);
  writeJsonAtomic(journal, {
    ...meta,
    root: plan.root,
    trashDir: plan.trashDir,
    applied,
    failed,
    repairs,
    // undo: the reverse moves, last first (mkdirs: remove the directory once it is empty)
    undo: [...applied].reverse().map((o) => (o.op === 'mkdir' ? { op: 'rmdir', path: o.src } : { op: 'move', path: o.dst, to: o.src })),
  });
  return { applied, ...(failed ? { failed } : {}), repairs, journal };
}
