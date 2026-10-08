// WebSocket server: ws://127.0.0.1:<port>. Clients send `hello` and get a `snapshot`, then every
// upsert. Multiple clients (the mod + CLI tools) are supported. Any browser origin (also `null`) and
// non-loopback Host headers are rejected, so a web page cannot drive your agents.
//
// A shared Foreman (members in users.json, see users.ts) listens on the host's network address
// instead, and every client - loopback ones too, since the agents run on that host - presents a
// member's token: `Authorization: Bearer acu_...` (or `?token=` for CLI tools). Each message is
// then handled as that member (runAs), within the member's role.
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from './context.js';
import type { Foreman } from './foreman.js';
import { parseClientMessage, PROTOCOL_VERSION, ServerMessage, type Outbound } from './protocol.js';
import { runAs } from './user.js';
import { actorOf, allowed, type Actor, type UserStore } from './users.js';

export interface ServerOptions {
  host: string;
  port: number;
  allowBrowserOrigins?: boolean;
  /** a shared Foreman's members: with any, every client must present a member's token */
  users?: UserStore;
  /** validate every outbound message against the schema (tests/dev) */
  validateOutbound?: boolean;
  log: Logger;
}

/** Host header values a local client sends (DNS rebinding sends the attacker's host name). */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Why a WebSocket upgrade is refused, or undefined to accept. The mod (Java HttpClient) and our
 * CLI tools send no Origin header; every browser does, and a sandboxed iframe, a data: URL or a
 * file:// page sends the literal `null`, so any Origin at all - `null` included - is a web page.
 * The Host must be a loopback name, so a DNS-rebinding page cannot reach us under its own name.
 */
export function refuseReason(req: IncomingMessage, allowBrowserOrigins = false, shared = false): string | undefined {
  const origin = req.headers.origin;
  if (origin !== undefined && !allowBrowserOrigins) return `browser origin ${origin || '(empty)'}`;
  // a shared Foreman is reached by its network name; the member token (which a page cannot
  // attach to a WebSocket) replaces the loopback check
  if (shared) return undefined;
  const host = req.headers.host ?? '';
  if (!allowBrowserOrigins && !LOOPBACK_HOST.test(host)) return `non-loopback Host header ${host || '(none)'}`;
  return undefined;
}

/** The token a client presents: `Authorization: Bearer <t>`, else `?token=<t>`. */
export function tokenOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  const m = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (m) return m[1];
  try {
    return new URL(req.url ?? '/', 'ws://x').searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

interface Client {
  /** shared Foreman: the member signed in on this connection */
  actor?: Actor;
  ws: WebSocket;
  id: number;
  hello: boolean;
  name: string;
  alive: boolean;
}

export class ForemanServer {
  private wss: WebSocketServer | undefined;
  private clients = new Set<Client>();
  private unsub: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private nextId = 1;
  private actors = new WeakMap<IncomingMessage, Actor>();
  port = 0;

  constructor(
    private foreman: Foreman,
    private opts: ServerOptions,
  ) {}

  /** called when a client connects or leaves (the Foreman updates who is online) */
  onPresence: (() => void) | undefined;

  /** Members with at least one open connection. */
  online(): string[] {
    return [...new Set([...this.clients].map((c) => c.actor?.id).filter((x): x is string => !!x))];
  }

  get clientCount(): number {
    return [...this.clients].filter((c) => c.hello).length;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.opts.host,
        port: this.opts.port,
        maxPayload: 4 * 1024 * 1024,
        verifyClient: (info: { origin?: string; req: IncomingMessage }) => {
          const shared = !!this.opts.users?.enabled;
          let why = refuseReason(info.req, !!this.opts.allowBrowserOrigins, shared);
          if (!why && shared) {
            const member = this.opts.users!.authenticate(tokenOf(info.req));
            if (member) this.actors.set(info.req, actorOf(member));
            else why = 'no valid member token';
          }
          if (!why) return true;
          this.opts.log.warn(`rejected WebSocket from ${info.req.socket.remoteAddress ?? '?'}: ${why}`);
          return false;
        },
      });
      this.wss = wss;
      wss.once('error', (e) => reject(e));
      wss.once('listening', () => {
        const addr = wss.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        wss.on('error', (e) => this.opts.log.error(`ws server: ${e.message}`));
        resolve(this.port);
      });
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.unsub = this.foreman.subscribe((m) => this.broadcast(m));
      this.heartbeat = setInterval(() => {
        for (const c of this.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }, 15_000);
      this.heartbeat.unref?.();
    });
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = { ws, id: this.nextId++, hello: false, name: `client${this.nextId - 1}`, alive: true };
    const actor = this.actors.get(req);
    if (actor) client.actor = actor;
    this.clients.add(client);
    this.opts.log.info(`client #${client.id} connected from ${req.socket.remoteAddress ?? '?'}${actor ? ` as ${actor.name} (${actor.role})` : ''}`);
    this.onPresence?.();
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) {
        this.send(client, { type: 'error', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        let re: string | undefined;
        try {
          const raw = JSON.parse(data.toString()) as { id?: unknown };
          if (typeof raw.id === 'string') re = raw.id;
        } catch {
          /* ignore */
        }
        this.send(client, { type: 'error', message: `bad message: ${parsed.error}`, ...(re ? { re } : {}) });
        if (re) this.send(client, { type: 'ack', re, ok: false, error: parsed.error });
        return;
      }
      const msg = parsed.msg;
      if (client.actor && !allowed(client.actor.role, msg.type)) {
        const error = `${client.actor.name} (${client.actor.role}) may not ${msg.type}`;
        this.send(client, { type: 'error', message: error, ...(msg.id ? { re: msg.id } : {}) });
        if (msg.id) this.send(client, { type: 'ack', re: msg.id, ok: false, error });
        return;
      }
      if (msg.type === 'hello') {
        client.hello = true;
        client.name = `${msg.client ?? 'client'}#${client.id} (${msg.modVersion})${client.actor ? ` ${client.actor.name}` : ''}`;
        this.opts.log.info(`hello from ${client.name}`);
      } else if (!client.hello) {
        // be lenient: treat the first intent as an implicit hello so tools can fire-and-forget
        client.hello = true;
      }
      void runAs(client.actor, () => this.foreman.handle(msg, (out) => this.send(client, out)));
    });
    ws.on('close', () => {
      this.clients.delete(client);
      this.onPresence?.();
      this.opts.log.info(`client #${client.id} disconnected`);
    });
    ws.on('error', (e) => this.opts.log.warn(`client #${client.id}: ${e.message}`));
  }

  private serialize(m: Outbound): string | undefined {
    const full = { v: PROTOCOL_VERSION, ...m };
    if (this.opts.validateOutbound) {
      const r = ServerMessage.safeParse(full);
      if (!r.success) {
        this.opts.log.error(`outbound ${m.type} violates protocol: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        throw new Error(`outbound ${m.type} violates protocol`);
      }
    }
    return JSON.stringify(full);
  }

  private send(c: Client, m: Outbound): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const s = this.serialize(m);
    if (s) c.ws.send(s);
  }

  broadcast(m: Outbound): void {
    let s: string | undefined;
    for (const c of this.clients) {
      if (!c.hello || c.ws.readyState !== c.ws.OPEN) continue;
      s ??= this.serialize(m);
      if (s) c.ws.send(s);
    }
  }

  async stop(): Promise<void> {
    this.unsub?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) {
      try {
        c.ws.close(1001, 'foreman shutting down');
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
      setTimeout(() => {
        for (const c of this.clients) c.ws.terminate();
        resolve();
      }, 1000).unref?.();
    });
  }
}
