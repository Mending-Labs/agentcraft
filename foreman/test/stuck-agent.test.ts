// An agent left blocked or in error on a task the lead then cancels goes back to the lounge
// (it used to keep showing "blocked" on a task that no longer exists).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeForeman, rmrf, tempDir, until, type Harness } from './helpers.js';

describe('agents stuck on a closed task', () => {
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

  it('a blocked agent is released when its task is cancelled', async () => {
    const t = h.fm.tasks.create({ title: 'Something', assignee: 'kit', createdBy: 'marlow' });
    h.fm.setAgent('kit', { state: 'error', station: 'desk', activity: `${t.id}: session ended`, taskId: t.id });
    h.fm.tasks.setStatus(t.id, 'cancelled', { force: true });
    await until(() => h.fm.agent('kit')!.state === 'idle');
    expect(h.fm.agent('kit')!.taskId).toBeUndefined();
  });

  it('a working agent is left to its turn', async () => {
    const t = h.fm.tasks.create({ title: 'Something', assignee: 'kit', createdBy: 'marlow' });
    h.fm.setAgent('kit', { state: 'editing', station: 'desk', activity: 'editing', taskId: t.id });
    h.fm.tasks.setStatus(t.id, 'cancelled', { force: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.fm.agent('kit')!.state).toBe('editing');
  });
});
