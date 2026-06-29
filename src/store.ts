import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Composition } from "./types.js";
import { config } from "./config.js";

const dir = () => path.join(config.dataDir, "compositions");

export async function init(): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
}

export async function list(): Promise<Composition[]> {
  const files = await fs.readdir(dir()).catch(() => [] as string[]);
  const out: Composition[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir(), f), "utf8")));
    } catch {
      /* skip corrupt file */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function get(id: string): Promise<Composition | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function save(
  input: { id?: string; name: string; servers: Composition["servers"]; tree: Composition["tree"] }
): Promise<Composition> {
  const now = new Date().toISOString();
  const existing = input.id ? await get(input.id) : null;
  const comp: Composition = {
    id: input.id || randomUUID(),
    name: input.name,
    servers: input.servers,
    tree: input.tree,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(path.join(dir(), `${comp.id}.json`), JSON.stringify(comp, null, 2), "utf8");
  return comp;
}

export async function remove(id: string): Promise<void> {
  await fs.rm(path.join(dir(), `${id}.json`), { force: true });
}
