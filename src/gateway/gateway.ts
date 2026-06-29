import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Composition, TreeNode } from "../types.js";
import { config } from "../config.js";
import { UpstreamPool } from "./upstream.js";
import { GateChainLink, TreeTracker } from "./tree-state.js";

const SEP = config.nameSeparator;

export function qualify(serverName: string, tool: string): string {
  return `${serverName}${SEP}${tool}`;
}

export function unqualify(name: string): { server: string; tool: string } | null {
  const i = name.indexOf(SEP);
  if (i < 0) return null;
  return { server: name.slice(0, i), tool: name.slice(i + SEP.length) };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** serverId -> ancestor server names, root → parent. */
function ancestorNames(comp: Composition): Map<string, string[]> {
  const nameById = new Map(comp.servers.map((s) => [s.id, s.name]));
  const map = new Map<string, string[]>();
  const walk = (nodes: TreeNode[], path: string[]) => {
    for (const n of nodes) {
      map.set(n.serverId, path);
      walk(n.children ?? [], [...path, nameById.get(n.serverId) ?? n.serverId]);
    }
  };
  walk(comp.tree, []);
  return map;
}

function gateMessage(comp: Composition, chain: GateChainLink[], requested: string): string {
  const nameById = new Map(comp.servers.map((s) => [s.id, s.name]));
  const nameOf = (id: string) => nameById.get(id) ?? id;
  const path = chain.map((c) => `${c.done ? "✓" : "•"} ${nameOf(c.serverId)}`).join("  →  ");
  const pending = chain.filter((c) => !c.done).map((c) => nameOf(c.serverId));
  return [
    `⛔ Hierarchy gate blocked "${requested}".`,
    ``,
    `"${requested}" is nested below:  ${path}`,
    `Use a tool from each parent that isn't done yet — in order: ${pending.join(", ")}.`,
    ``,
    `Then retry "${requested}".`,
  ].join("\n");
}

/**
 * Build a per-session MCP Server that fronts an entire composition. `tracker`
 * holds this session's hierarchy progress; `pool` is shared across sessions.
 */
export function buildGatewayServer(
  composition: Composition,
  pool: UpstreamPool,
  tracker: TreeTracker
): Server {
  const server = new Server(
    { name: `trellis/${composition.name}`, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const idByName = new Map(composition.servers.map((s) => [s.name, s.id]));
  const ancestors = ancestorNames(composition);

  // Expose every upstream tool, namespaced, with a prerequisite hint so the model
  // can avoid wasted gate rejections.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: unknown[] = [];
    for (const def of composition.servers) {
      let upstreamTools;
      try {
        upstreamTools = await pool.get(def.id).listTools();
      } catch {
        continue; // unreachable upstream is omitted from the list
      }
      const inTree = ancestors.has(def.id);
      const path = ancestors.get(def.id) ?? [];
      const hint = !inTree ? `[ungated]` : path.length ? `[after: ${path.join(" ▸ ")}]` : `[root]`;
      for (const ut of upstreamTools) {
        tools.push({
          name: qualify(def.name, ut.name),
          description: `${hint} ${def.name}: ${ut.description ?? ""}`.trim(),
          inputSchema: ut.inputSchema ?? { type: "object" },
        });
      }
    }
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const parsed = unqualify(req.params.name);
    if (!parsed) return textResult(`Unknown tool "${req.params.name}".`, true);

    const serverId = idByName.get(parsed.server);
    if (!serverId) return textResult(`Unknown upstream server "${parsed.server}".`, true);

    // --- GATING ---
    const gate = tracker.checkGate(serverId);
    if (gate.blocked) {
      return textResult(gateMessage(composition, gate.chain!, req.params.name), true);
    }

    // --- CALL with retry, then skip-on-failure so a branch cannot deadlock ---
    const conn = pool.get(serverId);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= config.maxToolRetries; attempt++) {
      try {
        const result = await conn.callTool(parsed.tool, req.params.arguments);
        tracker.markResponded(serverId);
        return result;
      } catch (err) {
        lastErr = err;
      }
    }
    tracker.markResponded(serverId); // skip: counts toward completion
    return textResult(
      `Upstream "${parsed.server}" failed after ${config.maxToolRetries} attempts and was SKIPPED ` +
        `so its children can proceed. Last error: ${String((lastErr as Error)?.message ?? lastErr)}`,
      true
    );
  });

  return server;
}
