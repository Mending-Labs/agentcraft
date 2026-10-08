// External MCP servers the user gives the team (config.json "mcp"), e.g. their own project tracker:
//
//   "mcp": { "seed": { "url": "https://seed.example.com/api/mcp", "bearerTokenEnvVar": "SEED_MCP_TOKEN",
//                      "lead": "write", "workers": "read" } }
//
// The token never goes into a file: it is read from the environment variable at each turn. Access
// per role: "write" = every tool of the server, "read" = only its read-only tools, "none" (default).
// Which tools are read-only comes from the server's own catalogue (tools/list, MCP annotation
// readOnlyHint), fetched once and cached; a tool the catalogue does not describe is judged by its
// name (get_, list_, search_, read_, find_...). Claude agents: the policy allows or refuses each call
// (policy.ts, PolicyContext.mcp). Codex agents: the server is added to the thread config, limited to
// its read-only tools (enabled_tools) for "read".
import type { Logger } from './context.js';

export type McpAccess = 'none' | 'read' | 'write';

export interface McpServerConfig {
  url: string;
  bearerTokenEnvVar?: string;
  lead: McpAccess;
  workers: McpAccess;
}

const READ_NAME = /^(get|list|search|read|find|fetch|show|query|describe|view|count|lookup|retrieve|whoami|ping)([_\-.A-Z]|$)/;

/** config.json "mcp": { name: { url, bearerTokenEnvVar?, lead?, workers? } } */
export function parseMcp(v: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!v || typeof v !== 'object') return out;
  const access = (a: unknown): McpAccess => (a === 'read' || a === 'write' ? a : 'none');
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name === 'agentcraft') throw new Error(`bad MCP server name "${name}" in config.json "mcp"`);
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) throw new Error(`MCP server "${name}" needs an http(s) "url"`);
    out[name] = {
      url: o.url,
      ...(typeof o.bearerTokenEnvVar === 'string' ? { bearerTokenEnvVar: o.bearerTokenEnvVar } : {}),
      lead: access(o.lead),
      workers: access(o.workers),
    };
  }
  return out;
}

export interface McpTool {
  name: string;
  readOnly?: boolean;
}

/** The servers' tool catalogues, fetched lazily (tools/list) to tell read-only tools apart. */
export class McpCatalog {
  private tools = new Map<string, McpTool[]>();
  private pending = new Map<string, Promise<void>>();

  constructor(
    readonly servers: Record<string, McpServerConfig>,
    private log: Logger,
    private fetchFn: typeof fetch = fetch,
  ) {}

  access(server: string, role: 'lead' | 'worker'): McpAccess {
    const s = this.servers[server];
    return !s ? 'none' : role === 'lead' ? s.lead : s.workers;
  }

  /** The servers a role may use (access read or write) that have their token. */
  forRole(role: 'lead' | 'worker'): Array<[string, McpServerConfig, string | undefined]> {
    const out: Array<[string, McpServerConfig, string | undefined]> = [];
    for (const [name, s] of Object.entries(this.servers)) {
      if (this.access(name, role) === 'none') continue;
      const token = s.bearerTokenEnvVar ? process.env[s.bearerTokenEnvVar] : undefined;
      if (s.bearerTokenEnvVar && !token) {
        this.log.warn(`MCP server ${name}: ${s.bearerTokenEnvVar} is not set, so the team does not get it (set it, then restart AgentCraft)`);
        continue;
      }
      out.push([name, s, token]);
    }
    return out;
  }

  /** Read-only tool? The catalogue's annotation when it has one, else the tool's name. */
  isReadOnly(server: string, tool: string): boolean {
    const t = this.tools.get(server)?.find((x) => x.name === tool);
    if (t?.readOnly !== undefined) return t.readOnly;
    return READ_NAME.test(tool);
  }

  /** The read-only tool names of a server (after load()); undefined while the catalogue is unknown. */
  readOnlyTools(server: string): string[] | undefined {
    const list = this.tools.get(server);
    return list?.filter((t) => this.isReadOnly(server, t.name)).map((t) => t.name);
  }

  /** Fetch the catalogues of every configured server once (errors are logged, never thrown). */
  async load(): Promise<void> {
    await Promise.all(Object.keys(this.servers).map((n) => this.loadOne(n)));
  }

  private loadOne(name: string): Promise<void> {
    if (this.tools.has(name)) return Promise.resolve();
    let p = this.pending.get(name);
    if (!p) {
      p = this.fetchTools(name)
        .then((tools) => {
          this.tools.set(name, tools);
          this.log.info(`MCP server ${name}: ${tools.length} tools (${tools.filter((t) => this.isReadOnly(name, t.name)).length} read-only)`);
        })
        .catch((e) => this.log.warn(`MCP server ${name}: could not list its tools (${(e as Error).message}); read-only tools are judged by name`))
        .finally(() => this.pending.delete(name));
      this.pending.set(name, p);
    }
    return p;
  }

  private async fetchTools(name: string): Promise<McpTool[]> {
    const s = this.servers[name]!;
    const token = s.bearerTokenEnvVar ? process.env[s.bearerTokenEnvVar] : undefined;
    if (s.bearerTokenEnvVar && !token) throw new Error(`${s.bearerTokenEnvVar} is not set`);
    let session: string | undefined;
    let id = 0;
    const call = async (method: string, params: unknown, notify = false): Promise<any> => {
      const res = await this.fetchFn(s.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      session = res.headers.get('mcp-session-id') ?? session;
      if (notify) return undefined;
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const text = await res.text();
      // a JSON body, or server-sent events whose data lines carry the reply
      const bodies = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
        : [text];
      for (const b of bodies) {
        try {
          const msg = JSON.parse(b);
          if (msg.id === id) {
            if (msg.error) throw new Error(`${method}: ${msg.error.message ?? 'error'}`);
            return msg.result;
          }
        } catch (e) {
          if ((e as Error).message.startsWith(method)) throw e;
        }
      }
      throw new Error(`${method}: no reply`);
    };
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentcraft-foreman', version: '0.1.0' } });
    await call('notifications/initialized', {}, true);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await call('tools/list', cursor ? { cursor } : {});
      for (const t of r?.tools ?? []) {
        const hint = t?.annotations?.readOnlyHint;
        tools.push({ name: String(t.name), ...(typeof hint === 'boolean' ? { readOnly: hint } : {}) });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }
}
