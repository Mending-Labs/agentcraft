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
//
// One token per project (Seed: a token gives access to one project): "secretPrefix" turns the entry
// into a template, and every secret named <prefix><PROJECT> (/secret set SEED_MCP_BANANA) becomes
// its own server "<name>_<project>" (seed_banana) with that token and the template's access.
import type { Logger } from './context.js';

export type McpAccess = 'none' | 'read' | 'write';

export interface McpServerConfig {
  url: string;
  bearerTokenEnvVar?: string;
  /** template: one server per secret named <secretPrefix><PROJECT> */
  secretPrefix?: string;
  /** set on a server made from a template: the project part of its secret's name */
  project?: string;
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
    if (o.secretPrefix !== undefined && (typeof o.secretPrefix !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.secretPrefix))) {
      throw new Error(`MCP server "${name}": "secretPrefix" must look like SEED_MCP_`);
    }
    out[name] = {
      url: o.url,
      ...(typeof o.bearerTokenEnvVar === 'string' ? { bearerTokenEnvVar: o.bearerTokenEnvVar } : {}),
      ...(typeof o.secretPrefix === 'string' ? { secretPrefix: o.secretPrefix } : {}),
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
    /** config.json "mcp" (templates included) */
    readonly config: Record<string, McpServerConfig>,
    private log: Logger,
    private fetchFn: typeof fetch = fetch,
    /** a stored secret by name (the vault); checked before the environment */
    private secret: (name: string) => string | undefined = () => undefined,
    /** names of the stored secrets (the vault), for the per-project templates */
    private secretNames: () => string[] = () => [],
  ) {
    this.captureEnv();
  }

  /** Tokens taken out of the Foreman's environment (see captureEnv). */
  private envTokens = new Map<string, string>();

  /** The servers: the plain entries, and one per project secret for each template. */
  get servers(): Record<string, McpServerConfig> {
    const out: Record<string, McpServerConfig> = {};
    for (const [name, s] of Object.entries(this.config)) {
      if (!s.secretPrefix) {
        out[name] = s;
        continue;
      }
      const prefix = s.secretPrefix;
      const names = new Set([...this.secretNames(), ...this.envTokens.keys()]);
      for (const secret of [...names].sort()) {
        if (!secret.toUpperCase().startsWith(prefix.toUpperCase()) || secret.length === prefix.length) continue;
        const project = secret.slice(prefix.length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!project) continue;
        const { secretPrefix: _template, ...rest } = s;
        out[`${name}_${project}`] = { ...rest, bearerTokenEnvVar: secret, project };
      }
    }
    return out;
  }

  /**
   * Move the token variables out of process.env into memory: nothing the Foreman starts (agents,
   * their tests, git) can inherit them any more.
   */
  private captureEnv(): void {
    const exact = new Set(Object.values(this.config).flatMap((s) => (s.bearerTokenEnvVar ? [s.bearerTokenEnvVar.toUpperCase()] : [])));
    const prefixes = Object.values(this.config).flatMap((s) => (s.secretPrefix ? [s.secretPrefix.toUpperCase()] : []));
    for (const k of Object.keys(process.env)) {
      const up = k.toUpperCase();
      if (!exact.has(up) && !prefixes.some((p) => up.startsWith(p))) continue;
      const val = process.env[k];
      if (val) this.envTokens.set(up, val);
      delete process.env[k];
    }
  }

  /**
   * A server's token: the vault's secret named like its bearerTokenEnvVar (whatever the case:
   * "gitlab" serves "Gitlab"), else that environment variable.
   */
  token(s: McpServerConfig): string | undefined {
    if (!s.bearerTokenEnvVar) return undefined;
    this.captureEnv();
    const want = s.bearerTokenEnvVar.toUpperCase();
    const stored = this.secretNames().find((n) => n.toUpperCase() === want) ?? s.bearerTokenEnvVar;
    return this.secret(stored) ?? this.envTokens.get(want);
  }

  /** Names of the token variables: kept out of every agent's environment. */
  tokenVars(): string[] {
    return Object.values(this.servers).flatMap((s) => (s.bearerTokenEnvVar ? [s.bearerTokenEnvVar] : []));
  }

  /** `env` without the token variables (an agent could otherwise read a token and bypass its access). */
  scrub(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const vars = new Set(this.tokenVars().map((v) => v.toUpperCase()));
    const prefixes = Object.values(this.config).flatMap((s) => (s.secretPrefix ? [s.secretPrefix.toUpperCase()] : []));
    if (!vars.size && !prefixes.length) return env;
    return Object.fromEntries(Object.entries(env).filter(([k]) => !vars.has(k.toUpperCase()) && !prefixes.some((p) => k.toUpperCase().startsWith(p))));
  }

  /** Environment patterns Codex must keep out of its shells (token names, template prefixes). */
  envExcludes(): string[] {
    const prefixes = Object.values(this.config).flatMap((s) => (s.secretPrefix ? [`${s.secretPrefix}*`] : []));
    return [...new Set([...this.tokenVars(), ...prefixes])];
  }

  /** Forget a server's catalogue (its token changed): the next load() fetches it again. */
  reset(): void {
    this.tools.clear();
  }

  access(server: string, role: 'lead' | 'worker'): McpAccess {
    const s = this.servers[server];
    return !s ? 'none' : role === 'lead' ? s.lead : s.workers;
  }

  /** The servers a role may use (access read or write) that have their token. */
  forRole(role: 'lead' | 'worker'): Array<[string, McpServerConfig, string | undefined]> {
    const out: Array<[string, McpServerConfig, string | undefined]> = [];
    for (const [name, s] of Object.entries(this.servers)) {
      if (this.access(name, role) === 'none') continue;
      const token = this.token(s);
      if (s.bearerTokenEnvVar && !token) {
        this.log.warn(`MCP server ${name}: no ${s.bearerTokenEnvVar} (in game: /secret set ${s.bearerTokenEnvVar}), so the team does not get it`);
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
    const token = this.token(s);
    if (s.bearerTokenEnvVar && !token) throw new Error(`no ${s.bearerTokenEnvVar}`);
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
