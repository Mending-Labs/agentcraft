// External MCP servers given to the team (config "mcp"): per-role access, the server's catalogue
// telling read-only tools apart, and the policy enforcing "read" for Claude agents.
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/context.js';
import { McpCatalog, parseMcp } from '../src/mcp.js';
import { classifyToolUse } from '../src/policy.js';

const SEED = { seed: { url: 'https://seed.example/api/mcp', bearerTokenEnvVar: 'AC_TEST_SEED_TOKEN', lead: 'write', workers: 'read' } };

/** A fake streamable-HTTP MCP server: replies as server-sent events, checks the bearer token. */
function fakeServer(tools: unknown[]) {
  const seen: Array<{ method: string; auth: string | null }> = [];
  const fn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    seen.push({ method: body.method, auth: headers.authorization ?? null });
    if (headers.authorization !== 'Bearer s3cret') return new Response('', { status: 401 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'seed' } } : { tools };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, {
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
    });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

afterEach(() => {
  delete process.env.AC_TEST_SEED_TOKEN;
});

describe('config "mcp"', () => {
  it('parses servers and access per role (none by default)', () => {
    expect(parseMcp(SEED).seed).toEqual(SEED.seed);
    expect(parseMcp({ x: { url: 'https://x' } }).x).toMatchObject({ lead: 'none', workers: 'none' });
    expect(() => parseMcp({ x: { url: 'ftp://x' } })).toThrow(/http/);
    expect(() => parseMcp({ agentcraft: { url: 'https://x' } })).toThrow(/name/);
  });
});

describe('McpCatalog', () => {
  it('reads the catalogue: annotations first, then tool names', async () => {
    process.env.AC_TEST_SEED_TOKEN = 's3cret';
    const { fn, seen } = fakeServer([
      { name: 'get_goal', annotations: { readOnlyHint: true } },
      { name: 'list_projects' },
      { name: 'update_goal', annotations: { readOnlyHint: false } },
      { name: 'get_or_create_tag', annotations: { readOnlyHint: false } },
      { name: 'archive_goal' },
    ]);
    const cat = new McpCatalog(parseMcp(SEED), silentLogger, fn);
    await cat.load();
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(cat.readOnlyTools('seed')).toEqual(['get_goal', 'list_projects']);
    expect(cat.isReadOnly('seed', 'get_or_create_tag')).toBe(false); // the annotation wins over the name
    expect(cat.isReadOnly('seed', 'search_tasks')).toBe(true); // not in the catalogue: by name
    expect(cat.isReadOnly('seed', 'delete_task')).toBe(false);
  });

  it('gives a role only the servers it may use, and only with their token', () => {
    const cat = new McpCatalog(parseMcp(SEED), silentLogger, fakeServer([]).fn);
    expect(cat.forRole('lead')).toEqual([]); // no token in the environment
    process.env.AC_TEST_SEED_TOKEN = 's3cret';
    expect(cat.forRole('lead').map(([n, , t]) => [n, t])).toEqual([['seed', 's3cret']]);
    const leadOnly = new McpCatalog(parseMcp({ seed: { ...SEED.seed, workers: 'none' } }), silentLogger);
    expect(leadOnly.forRole('worker')).toEqual([]);
  });

  it('survives a server it cannot reach: names decide', async () => {
    process.env.AC_TEST_SEED_TOKEN = 'wrong';
    const cat = new McpCatalog(parseMcp(SEED), silentLogger, fakeServer([]).fn);
    await cat.load();
    expect(cat.readOnlyTools('seed')).toBeUndefined();
    expect(cat.isReadOnly('seed', 'list_goals')).toBe(true);
    expect(cat.isReadOnly('seed', 'create_goal')).toBe(false);
  });
});

describe('policy for MCP servers given to the team', () => {
  const cat = new McpCatalog(parseMcp(SEED), silentLogger);
  const ctx = (role: 'lead' | 'worker') => ({ role, cwd: process.cwd(), mcp: { access: (s: string) => cat.access(s, role), isReadOnly: (s: string, t: string) => cat.isReadOnly(s, t) } });

  it('lead with write access: every tool', () => {
    expect(classifyToolUse('mcp__seed__update_goal', {}, ctx('lead')).action).toBe('allow');
  });

  it('workers with read access: read tools only, writes refused with a pointer to the lead', () => {
    expect(classifyToolUse('mcp__seed__get_goal', {}, ctx('worker')).action).toBe('allow');
    const v = classifyToolUse('mcp__seed__update_goal', {}, ctx('worker'));
    expect(v.action).toBe('deny');
    expect(v.action === 'deny' && v.reason).toMatch(/only read.*lead/);
  });

  it('a server nobody configured still asks', () => {
    expect(classifyToolUse('mcp__other__get_x', {}, ctx('worker')).action).toBe('ask');
  });
});
