import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as store from "./store.js";
import { config } from "./config.js";
import { Composition, TreeNode, UpstreamServerDef } from "./types.js";
import { UpstreamPool } from "./gateway/upstream.js";
import { TreeTracker } from "./gateway/tree-state.js";
import { buildGatewayServer } from "./gateway/gateway.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---- shared upstream pools (one per composition) ----
const pools = new Map<string, UpstreamPool>();
function poolFor(c: Composition): UpstreamPool {
  let p = pools.get(c.id);
  if (!p) {
    p = new UpstreamPool(c);
    pools.set(c.id, p);
  }
  return p;
}
function invalidatePool(id: string): void {
  const p = pools.get(id);
  if (p) {
    p.closeAll().catch(() => {});
    pools.delete(id);
  }
}

// ---- live MCP sessions (Streamable HTTP, stateful) ----
interface Session {
  transport: StreamableHTTPServerTransport;
  tracker: TreeTracker;
}
const sessions = new Map<string, Session>();

function gatewayUrl(id: string): string {
  return `${config.publicBaseUrl}/mcp/${id}`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The single MCP config the user pastes back into their IDE. */
function outputConfig(c: Composition) {
  return {
    mcpServers: {
      [slug(c.name) || "trellis"]: {
        type: "http",
        url: gatewayUrl(c.id),
      },
    },
  };
}

/** Convert a pasted IDE config (`mcpServers` / `servers`) into upstream defs. */
function parseMcpConfig(body: unknown): UpstreamServerDef[] {
  const b = body as Record<string, unknown>;
  const root = (b?.mcpServers ?? b?.servers ?? b) as Record<string, any>;
  if (!root || typeof root !== "object") {
    throw new Error("Expected an object with an 'mcpServers' (or 'servers') map.");
  }
  const out: UpstreamServerDef[] = [];
  for (const [name, raw] of Object.entries(root)) {
    const def: UpstreamServerDef = { id: randomUUID(), name, transport: "stdio" };
    if (raw?.url) {
      def.transport = raw.type === "sse" || raw.transport === "sse" ? "sse" : "http";
      def.url = raw.url;
      if (raw.headers) def.headers = raw.headers;
    } else if (raw?.command) {
      def.transport = "stdio";
      def.command = raw.command;
      def.args = raw.args ?? [];
      if (raw.env) def.env = raw.env;
    } else {
      throw new Error(`Server "${name}" has neither 'command' nor 'url'.`);
    }
    out.push(def);
  }
  if (!out.length) throw new Error("No servers found in the pasted config.");
  return out;
}

function normalizeTree(nodes: any[]): TreeNode[] {
  if (!Array.isArray(nodes)) throw new Error("Hierarchy must be an array of nodes.");
  return nodes.map((n) => {
    if (!n || typeof n.serverId !== "string") throw new Error("Invalid hierarchy node.");
    return { serverId: n.serverId, children: normalizeTree(n.children ?? []) };
  });
}

function collectTreeIds(nodes: TreeNode[], acc: string[], seen: Set<string>): void {
  for (const n of nodes) {
    if (seen.has(n.serverId)) {
      throw new Error(`Server id "${n.serverId}" appears more than once in the hierarchy.`);
    }
    seen.add(n.serverId);
    acc.push(n.serverId);
    collectTreeIds(n.children, acc, seen);
  }
}

function validateComposition(body: any): {
  id?: string;
  name: string;
  servers: UpstreamServerDef[];
  tree: TreeNode[];
} {
  if (!body?.name || typeof body.name !== "string") throw new Error("Missing 'name'.");
  const servers: UpstreamServerDef[] = body.servers ?? [];
  const tree: TreeNode[] = normalizeTree(body.tree ?? []);
  if (!servers.length) throw new Error("At least one server is required.");

  const names = new Set<string>();
  for (const s of servers) {
    if (s.name.includes(config.nameSeparator)) {
      throw new Error(`Server name "${s.name}" must not contain "${config.nameSeparator}".`);
    }
    if (names.has(s.name)) throw new Error(`Duplicate server name "${s.name}".`);
    names.add(s.name);
  }

  const ids = new Set(servers.map((s) => s.id));
  const placed: string[] = [];
  collectTreeIds(tree, placed, new Set<string>());
  for (const id of placed) {
    if (!ids.has(id)) throw new Error(`Hierarchy references unknown server id "${id}".`);
  }
  // Servers left out of the tree are allowed: they become ungated passthrough
  // (always available, outside the ordering, not part of completion/reset).
  return { id: body.id, name: body.name, servers, tree };
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // ----------------------- REST API -----------------------
  app.get("/api/health", (_req, res) => res.json({ ok: true, version: "0.1.0" }));

  app.get("/api/registry", async (_req, res) => {
    try {
      const data = await fs.readFile(path.join(ROOT, "examples", "registry.json"), "utf8");
      res.type("application/json").send(data);
    } catch {
      res.json({ servers: [] });
    }
  });

  app.post("/api/parse", (req, res) => {
    try {
      res.json({ servers: parseMcpConfig(req.body) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/compositions", async (_req, res) => res.json(await store.list()));

  app.get("/api/compositions/:id", async (req, res) => {
    const c = await store.get(req.params.id);
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(c);
  });

  app.post("/api/compositions", async (req, res) => {
    try {
      const comp = await store.save(validateComposition(req.body));
      invalidatePool(comp.id);
      res.json({ composition: comp, output: outputConfig(comp), gatewayUrl: gatewayUrl(comp.id) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete("/api/compositions/:id", async (req, res) => {
    await store.remove(req.params.id);
    invalidatePool(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/compositions/:id/output", async (req, res) => {
    const c = await store.get(req.params.id);
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(outputConfig(c));
  });

  // ----------------------- MCP endpoint -----------------------
  // Streamable HTTP, stateful: each IDE session gets its own TierTracker.
  app.post("/mcp/:id", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session; send 'initialize' first." },
        id: null,
      });
      return;
    }

    const comp = await store.get(req.params.id);
    if (!comp) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: `Composition "${req.params.id}" not found.` },
        id: null,
      });
      return;
    }

    const tracker = new TreeTracker(comp.tree, config.idleResetMs);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, tracker });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = buildGatewayServer(comp, poolFor(comp), tracker);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).send("Invalid or missing session id");
      return;
    }
    await session.transport.handleRequest(req, res);
  };
  app.get("/mcp/:id", sessionRequest); // server -> client SSE stream
  app.delete("/mcp/:id", sessionRequest); // explicit session teardown

  // ----------------------- static UI -----------------------
  app.use("/", express.static(path.join(ROOT, "public")));

  return app;
}
