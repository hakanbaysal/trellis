// Trellis UI — vanilla JS, native HTML5 drag & drop, zero deps.
// Model: a FOREST. Each node = a server; nest servers underneath others.

const SAMPLE = {
  mcpServers: {
    memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    docs: { url: "http://localhost:9101/mcp", type: "http" },
    design: { url: "http://localhost:9102/sse", type: "sse" },
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"] },
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  },
};

/** @type {{servers:any[], forest:{serverId:string,children:any[]}[], unassigned:string[], id:string|null}} */
const state = { servers: [], forest: [], unassigned: [], id: null };

const $ = (id) => document.getElementById(id);
const serverById = (id) => state.servers.find((s) => s.id === id);

// ---------------- input / parse ----------------
$("sampleBtn").onclick = () => {
  $("input").value = JSON.stringify(SAMPLE, null, 2);
};

$("parseBtn").onclick = async () => {
  const err = $("parseError");
  err.hidden = true;
  let body;
  try {
    body = JSON.parse($("input").value);
  } catch (e) {
    return showError(err, "Invalid JSON: " + e.message);
  }
  try {
    const res = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "parse failed");
    state.servers = data.servers;
    state.unassigned = data.servers.map((s) => s.id);
    state.forest = [];
    state.id = null;
    if (!$("nameInput").value) $("nameInput").value = "my-hierarchy";
    render();
  } catch (e) {
    showError(err, e.message);
  }
};

// ---------------- forest operations ----------------
function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.serverId === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}
function removeNode(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].serverId === id) return nodes.splice(i, 1)[0];
    const found = removeNode(nodes[i].children, id);
    if (found) return found;
  }
  return null;
}
function subtreeIds(node, acc = []) {
  acc.push(node.serverId);
  node.children.forEach((c) => subtreeIds(c, acc));
  return acc;
}
/** Detach a server (with its subtree) from wherever it lives. */
function detach(id) {
  if (state.unassigned.includes(id)) {
    state.unassigned = state.unassigned.filter((x) => x !== id);
    return { serverId: id, children: [] };
  }
  return removeNode(state.forest, id);
}

function nestUnder(dragId, targetId) {
  if (dragId === targetId) return;
  const inForest = findNode(state.forest, dragId);
  if (inForest && subtreeIds(inForest).includes(targetId)) return; // no cycles
  const node = detach(dragId);
  if (!node) return;
  const target = findNode(state.forest, targetId);
  if (target) target.children.push(node);
  else state.forest.push(node); // target vanished -> root
  render();
}
function makeRoot(dragId) {
  const node = detach(dragId);
  if (!node) return;
  state.forest.push(node);
  render();
}
function unassign(dragId) {
  const node = detach(dragId);
  if (!node) return;
  subtreeIds(node).forEach((id) => {
    if (!state.unassigned.includes(id)) state.unassigned.push(id);
  });
  render();
}

// ---------------- drag & drop ----------------
let dragId = null;
function onDragStart(e) {
  dragId = e.target.dataset.id;
  e.target.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
  e.stopPropagation();
}
function onDragEnd(e) {
  e.target.classList.remove("dragging");
  dragId = null;
}
function allowDrop(el, onDrop, highlightEl) {
  const hl = highlightEl || el;
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hl.classList.add("over");
  });
  el.addEventListener("dragleave", (e) => {
    e.stopPropagation();
    hl.classList.remove("over");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hl.classList.remove("over");
    const id = e.dataTransfer.getData("text/plain") || dragId;
    if (id) onDrop(id);
  });
}

// ---------------- render ----------------
function chip(id) {
  const s = serverById(id);
  if (!s) return "";
  return `<span class="chip" draggable="true" data-id="${id}">
    <span class="dot ${s.transport}"></span>${escapeHtml(s.name)}
    <span class="t">${s.transport}</span>
  </span>`;
}

function nodeHtml(node) {
  return `<div class="node" data-id="${node.serverId}">
    <div class="node-row" data-node="${node.serverId}">
      ${chip(node.serverId)}
      <span class="nest-hint">▸ drop here to nest under this</span>
    </div>
    <div class="children">${node.children.map(nodeHtml).join("")}</div>
  </div>`;
}

function render() {
  const un = $("unassigned");
  un.innerHTML = state.unassigned.length
    ? state.unassigned.map(chip).join("")
    : `<span class="empty">None — every server is in the hierarchy.</span>`;

  const roots = $("roots");
  roots.innerHTML = state.forest.length
    ? state.forest.map(nodeHtml).join("")
    : `<span class="empty">Drag servers here. Drop one onto another to nest it underneath.</span>`;

  // chips
  document.querySelectorAll(".chip").forEach((c) => {
    c.addEventListener("dragstart", onDragStart);
    c.addEventListener("dragend", onDragEnd);
  });
  // per-node drop targets (nest under)
  document.querySelectorAll(".node-row").forEach((row) => {
    allowDrop(row, (id) => nestUnder(id, row.dataset.node), row);
  });
}

// zone drop targets (set up once)
allowDrop($("roots"), makeRoot);
allowDrop($("unassigned"), unassign);

// ---------------- save ----------------
$("saveBtn").onclick = async () => {
  const err = $("saveError");
  err.hidden = true;
  const name = $("nameInput").value.trim();
  if (!name) return showError(err, "Please give the hierarchy a name.");
  if (!state.servers.length) return showError(err, "Parse some servers first.");
  // Servers left in "Ungated" are fine — they become always-available passthrough.

  try {
    const res = await fetch("/api/compositions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.id, name, servers: state.servers, tree: state.forest }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "save failed");
    state.id = data.composition.id;
    $("output").hidden = false;
    $("outputJson").textContent = JSON.stringify(data.output, null, 2);
    $("gatewayUrl").textContent = data.gatewayUrl;
    $("output").scrollIntoView({ behavior: "smooth" });
    loadSaved();
  } catch (e) {
    showError(err, e.message);
  }
};

$("copyBtn").onclick = async () => {
  await navigator.clipboard.writeText($("outputJson").textContent);
  $("copyBtn").textContent = "Copied ✓";
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1500);
};

// ---------------- saved list ----------------
async function loadSaved() {
  const res = await fetch("/api/compositions");
  const list = await res.json();
  const ul = $("savedList");
  if (!list.length) {
    ul.innerHTML = `<span class="empty">No saved hierarchies yet.</span>`;
    return;
  }
  ul.innerHTML = list
    .map(
      (c) => `<li>
        <div><strong>${escapeHtml(c.name)}</strong>
          <div class="meta">${c.servers.length} servers</div></div>
        <div class="acts">
          <button data-load="${c.id}">Load</button>
          <button data-rm="${c.id}">Delete</button>
        </div>
      </li>`
    )
    .join("");
  ul.querySelectorAll("[data-load]").forEach((b) => (b.onclick = () => loadComposition(b.dataset.load)));
  ul.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => deleteComposition(b.dataset.rm)));
}

async function loadComposition(id) {
  const res = await fetch("/api/compositions/" + id);
  const c = await res.json();
  state.servers = c.servers;
  state.forest = c.tree || [];
  const placed = new Set();
  state.forest.forEach((n) => subtreeIds(n).forEach((x) => placed.add(x)));
  state.unassigned = c.servers.map((s) => s.id).filter((x) => !placed.has(x));
  state.id = c.id;
  $("nameInput").value = c.name;
  $("input").value = "";
  render();
}

async function deleteComposition(id) {
  if (!confirm("Delete this hierarchy?")) return;
  await fetch("/api/compositions/" + id, { method: "DELETE" });
  if (state.id === id) state.id = null;
  loadSaved();
}

// ---------------- utils ----------------
function showError(el, msg) {
  el.textContent = msg;
  el.hidden = false;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

render();
loadSaved();
