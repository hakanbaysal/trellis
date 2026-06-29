import { TreeNode } from "../types.js";

/**
 * Per-session hierarchy state machine. This is the heart of Trellis.
 *
 * Rules (locked spec, tree edition):
 *  - A server may only run once every ANCESTOR (parent → root) has responded
 *    (rejection-based gating). Roots have no ancestors, so they're always open.
 *  - Siblings (same parent) are unordered; the model picks among them.
 *  - "Responded" = a real success OR a final skip (set by the caller after
 *    MAX_TOOL_RETRIES) so one broken upstream can't deadlock a branch.
 *  - When EVERY node in the forest has responded, the whole tracker resets so the
 *    next task re-primes (AND over the tree).
 */

export interface GateChainLink {
  serverId: string;
  done: boolean;
}

export interface GateResult {
  blocked: boolean;
  /** Ancestor chain, root → parent, each flagged done/pending. */
  chain?: GateChainLink[];
}

export class TreeTracker {
  private parent = new Map<string, string | null>();
  private responded = new Set<string>();
  private total = 0;
  private lastActivity = Date.now();

  constructor(forest: TreeNode[], private idleResetMs = 0) {
    const walk = (nodes: TreeNode[], par: string | null) => {
      for (const n of nodes) {
        this.parent.set(n.serverId, par);
        this.total++;
        walk(n.children ?? [], n.serverId);
      }
    };
    walk(forest, null);
  }

  private touch(): void {
    if (this.idleResetMs > 0 && Date.now() - this.lastActivity > this.idleResetMs) {
      this.reset();
    }
    this.lastActivity = Date.now();
  }

  /** Ancestors of `serverId`, ordered root → parent. */
  private ancestors(serverId: string): string[] {
    const chain: string[] = [];
    let p = this.parent.get(serverId) ?? null;
    while (p) {
      chain.push(p);
      p = this.parent.get(p) ?? null;
    }
    return chain.reverse();
  }

  /** Is `serverId` allowed to run right now? */
  checkGate(serverId: string): GateResult {
    this.touch();
    if (!this.parent.has(serverId)) return { blocked: false }; // unknown server -> pass
    const chain = this.ancestors(serverId).map((id) => ({
      serverId: id,
      done: this.responded.has(id),
    }));
    const blocked = chain.some((c) => !c.done);
    return blocked ? { blocked: true, chain } : { blocked: false };
  }

  /** Record that `serverId` responded (real success OR a final skip). */
  markResponded(serverId: string): void {
    if (!this.parent.has(serverId)) return;
    this.responded.add(serverId);
    if (this.responded.size >= this.total) this.reset(); // whole tree done -> re-prime
  }

  reset(): void {
    this.responded = new Set();
  }

  isComplete(): boolean {
    return this.responded.size >= this.total;
  }

  snapshot() {
    return [...this.parent.keys()].map((id) => ({
      serverId: id,
      parent: this.parent.get(id) ?? null,
      responded: this.responded.has(id),
    }));
  }
}
