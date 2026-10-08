// Keeping the memory library readable: notes know their goal and kind, a goal has one plan, its
// summary archives the rest, older notes are attached to their goal, and a completed goal asks
// the lead for its summary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentTools, type ToolHooks } from '../src/agents/tools.js';
import type { Backend } from '../src/foreman.js';
import { kindOfTitle, Memory } from '../src/memory.js';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

const hooks: ToolHooks = { onReview() {}, onChangesRequested() {}, onTasksChanged() {}, onMergeRequested() {}, onWaiting() {} };

describe('kindOfTitle', () => {
  it('reads the kind a title announces, in English or French', () => {
    expect(kindOfTitle('Plan: tags')).toBe('plan');
    expect(kindOfTitle('Bilan : audit de o1')).toBe('summary');
    expect(kindOfTitle('Rapport t6 — preuves')).toBe('report');
    expect(kindOfTitle('t5 — Vérification accès Seed')).toBe('report');
    expect(kindOfTitle('Revue t7 : corrections')).toBe('review');
    expect(kindOfTitle('Décision : un jeton par projet')).toBe('decision');
    expect(kindOfTitle('Workspace plan: popo')).toBe('note');
  });
});

describe('the memory library', () => {
  let h: Harness;
  let home: string;
  beforeEach(() => {
    home = tempDir();
    h = makeForeman(home, ['--backend', 'claude']);
  });
  afterEach(async () => {
    await h.fm.close();
    rmrf(home);
  });

  it('keeps one plan per goal: a second plan replaces the first', () => {
    const m = h.fm.memory;
    m.write({ scope: 'shared', title: 'Plan: v1', body: 'a', author: 'marlow', goalId: 'g1' });
    const second = m.write({ scope: 'shared', title: 'Plan: v2 revu', body: 'b', author: 'marlow', goalId: 'g1' });
    const plans = m.list().filter((e) => e.kind === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: second.id, title: 'Plan: v2 revu', body: 'b', goalId: 'g1' });
    m.write({ scope: 'shared', title: 'Plan: other goal', body: 'c', author: 'marlow', goalId: 'g2' });
    expect(m.list().filter((e) => e.kind === 'plan')).toHaveLength(2);
  });

  it("a goal's summary archives its other notes, not other goals' notes, and survives a reload", () => {
    const m = h.fm.memory;
    m.write({ scope: 'shared', title: 'Plan: g1', body: 'p', author: 'marlow', goalId: 'g1' });
    m.write({ scope: 'shared', title: 'Rapport t1', body: 'r', author: 'kit', goalId: 'g1' });
    m.write({ scope: 'shared', title: 'Rapport t9', body: 'r', author: 'kit', goalId: 'g2' });
    const sum = m.write({ scope: 'shared', title: 'Bilan : g1', body: 's', author: 'marlow', goalId: 'g1' });
    expect(sum.kind).toBe('summary');
    const fresh = new Memory(h.fm.ctx, m.dir);
    const byTitle = (t: string) => fresh.list().find((e) => e.title === t)!;
    expect(byTitle('Plan: g1').archived).toBe(true);
    expect(byTitle('Rapport t1').archived).toBe(true);
    expect(byTitle('Bilan : g1').archived).toBeUndefined();
    expect(byTitle('Rapport t9').archived).toBeUndefined();
    expect(byTitle('Rapport t1')).toMatchObject({ goalId: 'g1', kind: 'report' });
  });

  it('write_memory attaches the note to the goal the agent works for', async () => {
    const g = h.fm.createGoal('do things');
    const t = h.fm.tasks.create({ title: 'x', assignee: 'kit', createdBy: 'marlow', goalId: g.id });
    h.fm.setAgent('kit', { taskId: t.id });
    const write = agentTools(h.fm, 'kit', 'worker', hooks).find((x) => x.name === 'write_memory')!;
    await write.handler({ title: 'Rapport t1', body: 'done' });
    expect(h.fm.memory.list().at(-1)).toMatchObject({ goalId: g.id, kind: 'report' });
  });

  it('attaches older notes to the goal they were written for', () => {
    const m = h.fm.memory;
    m.write({ scope: 'shared', title: 'Old note', body: 'x', author: 'kit' });
    const goals = [
      { id: 'g1', text: 'a', progress: 1, status: 'done' as const, createdAt: 1000, updatedAt: 2000 },
      { id: 'g2', text: 'b', progress: 1, status: 'done' as const, createdAt: 3000, updatedAt: 4000 },
    ];
    const feed = [{ ts: 3500, kind: 'memory' as const, text: 'Kit wrote memory: Old note' }];
    expect(m.backfillGoals(goals, feed)).toBe(1);
    expect(m.list().find((e) => e.title === 'Old note')!.goalId).toBe('g2');
    expect(m.backfillGoals(goals, feed)).toBe(0);
  });

  it('a completed goal tells the backend (the lead writes its summary)', async () => {
    const done: string[] = [];
    h.fm.backend = { name: 'claude', onGoalComplete: (g: { id: string }) => done.push(g.id) } as unknown as Backend;
    const g = h.fm.createGoal('ship it');
    h.fm.setGoal(g.id, { status: 'active' });
    const t = h.fm.tasks.create({ title: 'x', createdBy: 'marlow', goalId: g.id });
    h.fm.tasks.setStatus(t.id, 'done', { force: true });
    await until(() => done.includes(g.id), 5000);
  });
});
