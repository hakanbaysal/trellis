export type TransportType = "stdio" | "http" | "sse";

/**
 * One upstream MCP server that Trellis proxies to.
 * Mirrors a single entry from an IDE's `mcpServers` block.
 */
export interface UpstreamServerDef {
  /** Stable internal id (referenced by the hierarchy tree + routing). */
  id: string;
  /** Namespace prefix exposed to the model, e.g. tools become `<name>__<tool>`. */
  name: string;
  transport: TransportType;

  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // http / sse
  url?: string;
  headers?: Record<string, string>;
}

/**
 * A node in the hierarchy tree. Each node is a server; `children` are servers
 * nested directly underneath it.
 */
export interface TreeNode {
  serverId: string;
  children: TreeNode[];
}

/**
 * A saved hierarchy, stored as a FOREST (one or more root servers).
 *
 * Semantics:
 *  - A server may only run once every ANCESTOR (its parent chain up to a root)
 *    has responded — enforced by rejection-gating.
 *  - Siblings (servers under the same parent) are the model's free choice.
 *  - When every node in the forest has responded, the whole thing resets so the
 *    next task re-primes (AND over the tree).
 */
export interface Composition {
  id: string;
  name: string;
  servers: UpstreamServerDef[];
  tree: TreeNode[];
  createdAt: string;
  updatedAt: string;
}
