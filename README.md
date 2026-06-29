<div align="center">

# ▚ Trellis

**A hierarchical, gating MCP proxy.**
Arrange your MCP servers into one gated hierarchy — a child only unlocks after its parent runs — then export a single MCP config for your IDE.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED.svg)](docker-compose.yml)
[![MCP](https://img.shields.io/badge/protocol-MCP-7c5cff.svg)](https://modelcontextprotocol.io)

</div>

---

## The problem

When you connect several MCP servers to an IDE, they land in a **flat list**. Two things follow:

1. **You can't control order.** The model decides which tool to call. If you want a context‑reducer, a cache, or a spec server to run *before* the others, there is no way to enforce it — the model will happily skip it.
2. **Tool sprawl.** Every server dumps its tools into one pool; selection accuracy drops as the list grows.

Trellis puts a **single gateway** in front of your servers. Your IDE sees one entry. Behind it, your servers are arranged into a **tree** — each server nested under the one that must run before it — and the gateway *enforces* that order in code, not by hoping the model behaves.

```
        ┌──────────── your IDE (one MCP entry) ────────────┐
        ▼                                                  ▼
   ┌────────────────────── Trellis gateway ──────────────────────┐
   │  the hierarchy is a TREE — a child unlocks after its parent:  │
   │                                                               │
   │   memory                                                      │
   │     └─ docs                                                   │
   │          ├─ design        ┐                                   │
   │          ├─ filesystem    │ siblings: the model's free choice │
   │          └─ github        ┘                                   │
   └───────────────────────────────────────────────────────────────┘
        each node is an upstream MCP server (stdio / http / sse),
        connected by Trellis as a client
```

---

## How the hierarchy works

You arrange servers into a **tree** (drag & drop — drop one server onto another to nest it underneath). The rules:

| Rule | Behaviour |
| --- | --- |
| **Nesting = order** | A server only runs after **every ancestor** (its parent, up to the root) has been used. A premature call is **rejected** with a message naming which parents to run first. |
| **Siblings = choice** | Servers under the same parent are unordered — the model picks among them, in any order. |
| **Completion** | A server is satisfied once it has produced a response. The same server called twice counts once (distinct servers). |
| **Reset** | When **every** server in the tree has responded, the whole thing resets so the next task re‑primes. (Optional idle reset as a safety net — see `IDLE_RESET_MS`.) |
| **Broken upstream** | A failing tool is retried `MAX_TOOL_RETRIES` times (default 3), then **skipped** — it counts as done so a branch can't deadlock. |

> **Why rejection‑gating and not "progressive disclosure"?** Hiding deeper nodes until their parents finish needs the client to honor `tools/list_changed`, which not every IDE does. Rejection‑gating uses only normal tool calls/responses, so it works on **every** MCP client. See [Design notes](#design-notes).

### Example

Hierarchy:

```
memory
└─ docs
   ├─ design
   ├─ filesystem
   └─ github
```

A run:

```
model → filesystem      ⛔ "filesystem is under: memory ▸ docs — use those first (next: memory)"
model → memory.*        ✓  unlocks docs
model → docs.*          ✓  unlocks design, filesystem, github
model → design.*        ✓
model → filesystem.*    ✓
model → github.*        ✓  every node done → tree RESET
```

---

## Quick start

```bash
git clone <your-fork-url> trellis && cd trellis
cp .env.example .env          # optional: tweak ports / retries
docker compose up --build
```

Open **http://localhost:8080** and:

1. **Paste** your IDE's `mcpServers` block (or click *Load example*) and hit **Parse servers**.
2. **Drag** servers into the hierarchy. Drop a server **onto another** to nest it underneath; drop on empty space for a top-level server. Anything you leave in **Ungated** stays always-available (outside the order).
3. **Save & generate** — you get a single MCP JSON.
4. **Paste** that JSON back into your IDE. Done.

---

## Wiring the output into your IDE

The exported config points your IDE at the gateway over **Streamable HTTP**:

```jsonc
{
  "mcpServers": {
    "my-hierarchy": {
      "type": "http",
      "url": "http://localhost:8080/mcp/<composition-id>"
    }
  }
}
```

- **Cursor / Claude Code / Windsurf** — paste into the respective MCP config; HTTP transport is supported natively.
- **VS Code (Copilot)** — the MCP block uses `servers` instead of `mcpServers`; rename the top key accordingly.
- **Clients that only speak stdio** — bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
  ```jsonc
  { "command": "npx", "args": ["-y", "mcp-remote", "http://localhost:8080/mcp/<id>"] }
  ```

---

## Configuration

All via environment variables (see [`.env.example`](.env.example)):

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port for UI + API + gateway. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Base URL embedded in the exported config. Change it if the IDE reaches Trellis at another host. |
| `MAX_TOOL_RETRIES` | `3` | Attempts before an upstream tool is skipped. |
| `IDLE_RESET_MS` | `0` (off) | Reset a session's progress after this much inactivity. Safety net for tasks that never traverse the whole tree. |
| `NAME_SEPARATOR` | `__` | Separator for namespaced tool names (`server__tool`). |
| `DATA_DIR` | `/data` | Where compositions are persisted (Docker volume). |

---

## Architecture

```
src/
├── index.ts              entry point
├── server.ts             Express: REST API + MCP HTTP endpoint + static UI
├── config.ts             env config
├── store.ts              file-backed composition persistence (/data)
├── types.ts              Composition / UpstreamServerDef
└── gateway/
    ├── tree-state.ts     ★ TreeTracker — ancestor-gating, completion, reset, skip
    ├── upstream.ts       UpstreamPool — connects to each MCP (stdio/http/sse)
    └── gateway.ts        builds a per-session MCP Server (list + call, namespaced)
public/                   drag-and-drop tree UI (vanilla JS, zero deps)
```

- **One gateway endpoint per composition:** `/mcp/<id>`.
- **Per‑session hierarchy state:** each IDE session gets its own `TreeTracker`; upstream connections are shared across sessions.
- **Namespacing:** upstream tools are exposed as `server__tool`, with an `[after: parent ▸ …]` prerequisite hint in the description to reduce wasted rejections.

---

## Design notes

A few honest engineering points (these are deliberate trade‑offs, not bugs):

- **Everything in the tree runs; everything outside it is free.** A server in the tree is used every task and its children force it to run first. A server you leave **out** of the tree becomes **ungated passthrough** — always available, outside the ordering, not counted toward completion/reset. So you only arrange the servers you actually want to order.
- **One parent per server (it's a tree, not a DAG).** "A and B must both precede C" isn't expressible yet — nest C under whichever is the real prerequisite. Multi-parent (DAG) is on the roadmap.
- **The gateway sees tool calls, not your prompt.** Routing/gating is based on which tool the model called, never the raw user message.
- **stdio upstreams run inside the container.** The image ships Node + `npx`, so node‑based MCP servers work out of the box. Servers needing other runtimes (e.g. `uvx`/Python) require extending the image or exposing them over HTTP. Secrets are passed through via each server's `env`.
- **Reset relies on the whole tree completing.** Tasks that only touch part of the tree won't auto‑reset; enable `IDLE_RESET_MS` if that matters for your workflow.
- **Concurrent IDE sessions share one upstream subprocess.** Fine for stateless servers; stateful stdio servers may need per‑session isolation (roadmap).

---

## Roadmap

- [ ] **Optional / OR branches** (a node that doesn't have to run)
- [ ] **Multi-parent (DAG)** — "A and B both precede C"
- [ ] Optional **progressive disclosure** mode where the client supports `tools/list_changed`
- [ ] Live **session inspector** (hierarchy progress, skips) in the UI
- [ ] Resource & prompt forwarding (today: tools)
- [ ] Per‑session upstream isolation for stateful stdio servers
- [ ] Auth on the gateway endpoint
- [ ] Publish a prebuilt image

---

## Contributing

Issues and PRs welcome — this is built to be a community project.

```bash
npm install
npm run dev        # tsx watch, hot reload on :8080
```

Good first issues: the roadmap items above, more IDE wiring recipes, and a richer server **registry** (`examples/registry.json`).

Please keep the core spec intact: **tree nesting = ancestor-gating · rejection‑gating · distinct‑server completion · reset on full tree · retry‑then‑skip.**

---

## License

[MIT](LICENSE) © Trellis contributors
