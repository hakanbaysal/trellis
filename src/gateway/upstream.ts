import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Composition, UpstreamServerDef } from "../types.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/**
 * A lazily-connected client to a single upstream MCP server. Connections are
 * shared across IDE sessions (one subprocess / one HTTP client per server),
 * while hierarchy state stays per-session.
 */
class UpstreamConnection {
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;

  constructor(public def: UpstreamServerDef) {}

  private async connect(): Promise<Client> {
    if (!this.connectPromise) {
      // Build a FRESH client + transport per connect attempt. A Client that
      // failed to connect stays bound to its (dead) transport, so reusing it
      // would make every retry fail with "Already connected to a transport"
      // and mask the real first-attempt error.
      this.connectPromise = (async () => {
        const client = new Client(
          { name: `trellis-proxy/${this.def.name}`, version: "0.1.0" },
          { capabilities: {} }
        );
        await client.connect(this.makeTransport());
        this.client = client;
        return client;
      })().catch((err) => {
        // allow a later retry to build a brand-new client + transport
        this.connectPromise = null;
        this.client = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  private makeTransport() {
    const d = this.def;
    if (d.transport === "stdio") {
      if (!d.command) throw new Error(`stdio upstream '${d.name}' is missing 'command'`);
      return new StdioClientTransport({
        command: d.command,
        args: d.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(d.env ?? {}) },
      });
    }
    if (!d.url) throw new Error(`upstream '${d.name}' is missing 'url'`);
    if (d.transport === "sse") {
      return new SSEClientTransport(new URL(d.url), {
        requestInit: { headers: d.headers ?? {} },
      });
    }
    return new StreamableHTTPClientTransport(new URL(d.url), {
      requestInit: { headers: d.headers ?? {} },
    });
  }

  async listTools(): Promise<UpstreamTool[]> {
    const client = await this.connect();
    const res = await client.listTools();
    return res.tools as UpstreamTool[];
  }

  async callTool(name: string, args: unknown) {
    const client = await this.connect();
    return client.callTool({ name, arguments: (args as Record<string, unknown>) ?? {} });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** One pool of upstream connections per composition. */
export class UpstreamPool {
  private conns = new Map<string, UpstreamConnection>();

  constructor(composition: Composition) {
    for (const s of composition.servers) {
      this.conns.set(s.id, new UpstreamConnection(s));
    }
  }

  get(id: string): UpstreamConnection {
    const c = this.conns.get(id);
    if (!c) throw new Error(`unknown upstream server id '${id}'`);
    return c;
  }

  all(): UpstreamConnection[] {
    return [...this.conns.values()];
  }

  async closeAll(): Promise<void> {
    for (const c of this.conns.values()) await c.close();
  }
}
