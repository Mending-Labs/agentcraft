// A shared Foreman: members with personal tokens and roles, actions attributed to them, and each
// member's goals running on their own AI subscription.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SimBackend } from '../src/agents/sim/index.js';
import { accountProblem } from '../src/accounts.js';
import { silentLogger } from '../src/context.js';
import { ServerMessage, type ServerMessage as SM } from '../src/protocol.js';
import { SecretVault } from '../src/secrets.js';
import { ForemanServer } from '../src/server.js';
import { runAs } from '../src/user.js';
import { allowed, UserStore } from '../src/users.js';
import { demoRepo, makeForeman, rmrf, tempDir, until } from './helpers.js';

const CLAUDE_TOKEN = `sk-ant-oat01-${'a'.repeat(40)}`;
const CODEX_AUTH = JSON.stringify({ tokens: { id_token: 'x', access_token: 'y', refresh_token: 'z' } });

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmrf(d);
});

describe('members', () => {
  it('a token signs in as its member, only its hash is stored, a new token replaces the old one', () => {
    const home = tempDir();
    cleanup.push(home);
    const users = new UserStore(home);
    expect(users.enabled).toBe(false);
    const { token, member } = users.add('Astios', 'member');
    expect(member.id).toBe('astios');
    expect(fs.readFileSync(users.file, 'utf8')).not.toContain(token);
    expect(users.authenticate(token)?.name).toBe('Astios');
    expect(users.authenticate('acu_nope')).toBeUndefined();
    expect(users.authenticate(undefined)).toBeUndefined();
    const again = users.add('astios');
    expect(users.authenticate(token)).toBeUndefined();
    expect(users.authenticate(again.token)?.id).toBe('astios');
    expect(users.setRole('ASTIOS', 'viewer').role).toBe('viewer');
    expect(users.remove('Astios')).toBe(true);
    expect(users.enabled).toBe(false);
  });

  it('roles limit what a member may send', () => {
    expect(allowed('viewer', 'hello')).toBe(true);
    expect(allowed('viewer', 'goal.submit')).toBe(false);
    expect(allowed('member', 'decision.answer')).toBe(true);
    expect(allowed('member', 'secret.set')).toBe(false);
    expect(allowed('member', 'auto.set')).toBe(false);
    expect(allowed('member', 'account.set')).toBe(true);
    expect(allowed('admin', 'secret.set')).toBe(true);
  });
});

describe('the vault on a server (key file)', () => {
  const prev = process.env.AGENTCRAFT_VAULT;
  beforeEach(() => {
    process.env.AGENTCRAFT_VAULT = 'file';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTCRAFT_VAULT;
    else process.env.AGENTCRAFT_VAULT = prev;
  });

  it('encrypts at rest, decrypts after a restart, refuses a tampered value', async () => {
    const home = tempDir();
    cleanup.push(home);
    const v = new SecretVault(home);
    await v.set('SEED_MCP_CORE', 'tok-123');
    expect(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')).not.toContain('tok-123');
    expect(fs.existsSync(path.join(home, 'vault.key'))).toBe(true);
    const again = new SecretVault(home);
    expect(await again.unlock()).toEqual([]);
    expect(again.get('SEED_MCP_CORE')).toBe('tok-123');
    // the name is authenticated too: a value moved under another name does not decrypt
    const idx = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'));
    idx.OTHER = idx.SEED_MCP_CORE;
    fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify(idx));
    expect(await new SecretVault(home).unlock()).toEqual(['OTHER']);
  });
});

describe('AI subscriptions per member', () => {
  const prev = process.env.AGENTCRAFT_VAULT;
  beforeEach(() => {
    process.env.AGENTCRAFT_VAULT = 'file';
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTCRAFT_VAULT;
    else process.env.AGENTCRAFT_VAULT = prev;
  });

  it("a member's goal runs on their own subscription; the owner may use the host's login", async () => {
    const home = tempDir();
    cleanup.push(home);
    const h = makeForeman(home, ['--backend', 'claude', '--user-name', 'Quentin']);
    h.fm.users.add('Quentin', 'admin');
    h.fm.users.add('Astios', 'member');
    // single-user goals and the owner without links: the host's login
    expect(h.fm.accounts.forMember(undefined)).toBeUndefined();
    expect(h.fm.accounts.forMember('Quentin')).toBeUndefined();
    expect(h.fm.accounts.missing('Quentin', ['claude', 'codex'])).toEqual([]);
    // a member without links: their goals cannot run
    expect(h.fm.accounts.missing('Astios', ['codex', 'claude'])).toEqual(['codex', 'claude']);
    expect(accountProblem(h.fm.accounts.forMember('Astios'), 'claude')).toMatch(/Astios has not linked a Claude subscription/);
    await expect(h.fm.accounts.set('astios', 'claude', 'sk-ant-api03-not-a-subscription')).rejects.toThrow(/claude setup-token/);
    await expect(h.fm.accounts.set('astios', 'codex', '{"OPENAI_API_KEY":null}')).rejects.toThrow(/no ChatGPT login/);
    await h.fm.accounts.set('astios', 'claude', CLAUDE_TOKEN);
    await h.fm.accounts.set('astios', 'codex', CODEX_AUTH);
    const acc = h.fm.accounts.forMember('Astios')!;
    expect(acc.claudeToken).toBe(CLAUDE_TOKEN);
    expect(fs.readFileSync(path.join(acc.codexHome!, 'auth.json'), 'utf8')).toContain('"refresh_token": "z"');
    expect(accountProblem(acc, 'codex')).toBeUndefined();
    // the subscriptions never show among the vault's secrets
    expect(h.fm.secrets.names()).toEqual([]);
    expect(h.fm.accounts.linked('astios')).toEqual(['claude', 'codex']);
    expect(await h.fm.accounts.delete('astios', 'codex')).toBe(true);
    expect(h.fm.accounts.linked('astios')).toEqual(['claude']);
    // a goal set by Astios runs as Astios, on Astios' subscription
    const goal = runAs({ id: 'astios', name: 'Astios', role: 'member' }, () => h.fm.createGoal('Do it'));
    expect(goal.by).toBe('Astios');
    expect(h.fm.goalActor(goal.id)?.name).toBe('Astios');
    expect(h.fm.goalAccount(goal.id)?.claudeToken).toBe(CLAUDE_TOKEN);
    await h.fm.close();
  });
});

interface Client {
  ws: WebSocket;
  msgs: SM[];
  send(o: Record<string, unknown>): void;
}

function connect(port: number, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const c: Client = { ws, msgs: [], send: (o) => ws.send(JSON.stringify({ v: 1, ...o })) };
    ws.on('message', (d) => {
      const r = ServerMessage.safeParse(JSON.parse(d.toString()));
      if (r.success) c.msgs.push(r.data);
    });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe('a shared Foreman over WebSocket', () => {
  it('needs a member token, attributes goals, messages and answers, and enforces roles', async () => {
    const home = tempDir();
    const repoPath = await demoRepo();
    cleanup.push(home, path.dirname(repoPath));
    const h = makeForeman(home, ['--backend', 'sim', '--repo', repoPath, '--speed', '1000', '--no-ambient', '--user-name', 'Quentin']);
    const deo = h.fm.users.add('Deo', 'member').token;
    const nerfs = h.fm.users.add('Nerfs', 'viewer').token;
    const server = new ForemanServer(h.fm, { host: '127.0.0.1', port: 0, validateOutbound: true, log: silentLogger, users: h.fm.users });
    server.onPresence = () => h.fm.setOnline(server.online());
    const port = await server.start();
    await h.fm.start(new SimBackend(h.fm, h.cfg.sim));
    try {
      await expect(connect(port)).rejects.toThrow(/401/);
      await expect(connect(port, 'acu_wrong')).rejects.toThrow(/401/);

      const d = await connect(port, deo);
      d.send({ type: 'hello', modVersion: 'test', protocol: 1, client: 'test' });
      await until(() => d.msgs.some((m) => m.type === 'snapshot'));
      const snap = d.msgs.find((m) => m.type === 'snapshot')!;
      expect(snap.type === 'snapshot' && snap.you).toEqual({ name: 'Deo', role: 'member' });
      await until(() => h.fm.status.members?.find((m) => m.name === 'Deo')?.online === true);

      d.send({ type: 'goal.submit', id: 'g', text: 'Add #tags to pocket-notes' });
      await until(() => d.msgs.some((m) => m.type === 'ack' && m.re === 'g'));
      expect(h.fm.goals().at(-1)!.by).toBe('Deo');
      expect(h.fm.store.data.feed.some((f) => f.kind === 'goal' && /from Deo/.test(f.text))).toBe(true);

      d.send({ type: 'user.message', id: 'm', to: 'marlow', text: 'salut' });
      await until(() => d.msgs.some((m) => m.type === 'ack' && m.re === 'm'));
      expect(h.fm.store.data.messages.find((m) => m.from === 'user')).toMatchObject({ from: 'user', by: 'Deo', text: 'salut' });

      // a member may not touch the vault; a viewer may only watch
      d.send({ type: 'secret.set', id: 's', name: 'X', value: 'y' });
      await until(() => d.msgs.some((m) => m.type === 'ack' && m.re === 's'));
      const sAck = d.msgs.find((m) => m.type === 'ack' && m.re === 's')!;
      expect(sAck.type === 'ack' && !sAck.ok && sAck.error).toMatch(/Deo \(member\) may not secret\.set/);

      const n = await connect(port, nerfs);
      n.send({ type: 'goal.submit', id: 'g2', text: 'Something else' });
      await until(() => n.msgs.some((m) => m.type === 'ack' && m.re === 'g2'));
      const gAck = n.msgs.find((m) => m.type === 'ack' && m.re === 'g2')!;
      expect(gAck.type === 'ack' && gAck.ok).toBe(false);

      // the first decision of the scenario, answered by Deo
      await until(() => h.fm.decisions.open().length > 0, 60_000);
      const dec = h.fm.decisions.open()[0]!;
      d.send({ type: 'decision.answer', id: 'a', decisionId: dec.id, option: 0, text: dec.kind === 'question' ? 'ok' : undefined });
      await until(() => d.msgs.some((m) => m.type === 'ack' && m.re === 'a'));
      expect(h.fm.decisions.get(dec.id)!.answer?.by).toBe('Deo');
      expect(h.fm.store.data.feed.some((f) => f.kind === 'decision' && /^Deo answered/.test(f.text))).toBe(true);

      d.ws.close();
      n.ws.close();
      await until(() => h.fm.status.members?.every((m) => !m.online) === true);
    } finally {
      await server.stop();
      await h.fm.close();
    }
  }, 120_000);
});
