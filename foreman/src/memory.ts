// Memory: markdown files, shared + per-agent, under <profile>/memory.
//
//   memory/shared/<slug>.md
//   memory/agents/<agentId>/<slug>.md
//
// Each file starts with a tiny front matter block (title/author/updated, and goal/kind/archived for
// the library: notes are grouped by goal and typed). Files the user drops in or edits by hand are
// picked up too (title falls back to the first heading or the file name).
//
// Keeping the library small: a goal has ONE plan (writing another plan for the same goal replaces
// it), and when the goal's summary is written its other notes are archived (still readable under
// the Archives tab, no longer in the way).
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.js';
import type { FeedItem, Goal, MemoryEntry, MemoryKind } from './protocol.js';
import { ensureDir, writeFileAtomic } from './util/fsx.js';
import { slugify } from './util/text.js';

export class MemoryError extends Error {}

const KINDS: readonly MemoryKind[] = ['plan', 'report', 'review', 'summary', 'decision', 'note'];

/** The kind a title announces ("Plan: ...", "Rapport t3", "Revue t7", "Bilan : ...", "Décision ..."). */
export function kindOfTitle(title: string): MemoryKind {
  const t = title
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/^plan\b/.test(t)) return 'plan';
  if (/^(bilan|summary|synthese|conclusion)\b/.test(t)) return 'summary';
  if (/^(revue|review)\b/.test(t)) return 'review';
  if (/^(rapport|report)\b|^t\d+\b/.test(t)) return 'report';
  if (/^(decision|choix)\b/.test(t)) return 'decision';
  return 'note';
}

interface Parsed {
  title?: string;
  author?: string;
  updated?: number;
  goalId?: string;
  kind?: MemoryKind;
  archived?: boolean;
  body: string;
}

function parseFile(raw: string): Parsed {
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { body: text };
  const header = text.slice(4, end);
  // serialize() ends the file with exactly one newline after the body: strip that one, so a body
  // round-trips byte for byte across restarts
  const body = text.slice(end + 5).replace(/^\n/, '').replace(/\n$/, '');
  const out: Parsed = { body };
  for (const line of header.split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'title') out.title = v;
    else if (k === 'author') out.author = v;
    else if (k === 'updated' && v && /^\d+$/.test(v)) out.updated = Number(v);
    else if (k === 'goal' && v && /^[A-Za-z0-9_-]+$/.test(v)) out.goalId = v;
    else if (k === 'kind' && (KINDS as readonly string[]).includes(v ?? '')) out.kind = v as MemoryKind;
    else if (k === 'archived') out.archived = v === 'true';
  }
  return out;
}

function serialize(e: MemoryEntry): string {
  const title = e.title.replace(/\n/g, ' ');
  const extra = `${e.goalId ? `goal: ${e.goalId}\n` : ''}${e.kind ? `kind: ${e.kind}\n` : ''}${e.archived ? 'archived: true\n' : ''}`;
  return `---\ntitle: ${title}\nauthor: ${e.author ?? ''}\nupdated: ${e.updated}\n${extra}---\n${e.body}\n`;
}

export class Memory {
  readonly dir: string;
  private entries = new Map<string, MemoryEntry>();

  constructor(
    private ctx: Ctx,
    dir: string,
  ) {
    this.dir = ensureDir(dir);
    ensureDir(path.join(this.dir, 'shared'));
    ensureDir(path.join(this.dir, 'agents'));
    this.reload();
  }

  private fileFor(id: string): string {
    const [scope, slug] = this.splitId(id);
    return scope === 'shared' ? path.join(this.dir, 'shared', `${slug}.md`) : path.join(this.dir, 'agents', scope, `${slug}.md`);
  }

  private splitId(id: string): [string, string] {
    const i = id.indexOf('/');
    if (i <= 0) throw new MemoryError(`bad memory id ${id}`);
    const scope = id.slice(0, i);
    const slug = id.slice(i + 1);
    if (!/^[a-z0-9_-]+$/i.test(scope) || !/^[a-z0-9-]+$/.test(slug)) throw new MemoryError(`bad memory id ${id}`);
    return [scope, slug];
  }

  /** Re-scan the memory directory (picks up hand-edited files). */
  reload(): void {
    this.entries.clear();
    const load = (scope: string, d: string) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.md')) continue;
        const slug = f.slice(0, -3);
        if (!/^[a-z0-9-]+$/.test(slug)) continue;
        const full = path.join(d, f);
        const p = parseFile(fs.readFileSync(full, 'utf8'));
        const heading = /^#\s+(.+)$/m.exec(p.body)?.[1];
        const title = p.title || heading || slug;
        const e: MemoryEntry = {
          id: `${scope}/${slug}`,
          scope,
          title,
          body: p.body,
          updated: p.updated ?? Math.floor(fs.statSync(full).mtimeMs),
          kind: p.kind ?? kindOfTitle(title),
        };
        if (p.author) e.author = p.author;
        if (p.goalId) e.goalId = p.goalId;
        if (p.archived) e.archived = true;
        this.entries.set(e.id, e);
      }
    };
    load('shared', path.join(this.dir, 'shared'));
    const agentsDir = path.join(this.dir, 'agents');
    for (const a of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []) {
      if (/^[a-z0-9_-]+$/i.test(a)) load(a, path.join(agentsDir, a));
    }
  }

  list(): MemoryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.updated - b.updated);
  }

  get(id: string): MemoryEntry | undefined {
    return this.entries.get(id);
  }

  /** Entries visible to an agent: shared + its own. */
  visibleTo(agentId: string): MemoryEntry[] {
    return this.list().filter((e) => e.scope === 'shared' || e.scope === agentId);
  }

  search(query: string, agentId?: string): MemoryEntry[] {
    const q = query.toLowerCase();
    const pool = agentId ? this.visibleTo(agentId) : this.list();
    return pool.filter((e) => e.title.toLowerCase().includes(q) || e.body.toLowerCase().includes(q));
  }

  /** A goal's notes (archived ones included). */
  forGoal(goalId: string): MemoryEntry[] {
    return this.list().filter((e) => e.goalId === goalId);
  }

  /**
   * Write (create or replace/append) an entry. `scope` is "shared" or an agent id.
   * `slug` defaults to slugify(title). `kind` defaults to what the title announces. A plan for a
   * goal that already has one replaces it (one plan per goal); a summary archives the goal's
   * other notes.
   */
  write(input: {
    scope: string;
    title: string;
    body: string;
    author: string;
    slug?: string;
    mode?: 'replace' | 'append';
    goalId?: string;
    kind?: MemoryKind;
  }): MemoryEntry {
    const scope = input.scope;
    if (!/^[a-z0-9_-]+$/i.test(scope)) throw new MemoryError(`bad memory scope ${scope}`);
    const kind = input.kind ?? kindOfTitle(input.title);
    let id = `${scope}/${input.slug ? slugify(input.slug, 48) : slugify(input.title, 48)}`;
    if (kind === 'plan' && input.goalId) {
      const plan = this.list().find((e) => e.goalId === input.goalId && e.kind === 'plan' && e.scope === scope && !e.archived);
      if (plan) id = plan.id;
    }
    const prev = this.entries.get(id);
    const body = input.mode === 'append' && prev ? `${prev.body.replace(/\n+$/, '')}\n\n${input.body}` : input.body;
    const slug = id.slice(id.indexOf('/') + 1);
    const e: MemoryEntry = { id, scope, title: input.title.trim() || slug, body, updated: this.ctx.now(), author: input.author, kind };
    const goalId = input.goalId ?? prev?.goalId;
    if (goalId) e.goalId = goalId;
    this.save(e);
    if (kind === 'summary' && goalId) {
      for (const other of this.forGoal(goalId)) if (other.id !== id && !other.archived) this.save({ ...other, archived: true });
    }
    return e;
  }

  private save(e: MemoryEntry): void {
    writeFileAtomic(this.fileFor(e.id), serialize(e));
    this.entries.set(e.id, e);
    this.ctx.emit({ type: 'memory.upsert', entry: e });
  }

  /**
   * Notes written before goals were recorded: attach each to the goal it was written for (the
   * feed's "wrote memory: <title>" line, else its date: the latest goal created before it).
   */
  backfillGoals(goals: Goal[], feed: FeedItem[]): number {
    let n = 0;
    const byTime = [...goals].sort((a, b) => a.createdAt - b.createdAt);
    for (const e of this.list()) {
      if (e.goalId || !byTime.length) continue;
      const written = feed.find((f) => f.kind === 'memory' && f.text.endsWith(`: ${e.title}`))?.ts ?? e.updated;
      const goal = byTime.filter((g) => g.createdAt <= written).pop();
      if (!goal) continue;
      this.save({ ...e, goalId: goal.id });
      n++;
    }
    return n;
  }
}
