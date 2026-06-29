function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const port = num("PORT", 8080);

export const config = {
  port,
  dataDir: process.env.DATA_DIR || "/data",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,

  /** How many times a single upstream tool call is retried before it is SKIPPED. */
  maxToolRetries: num("MAX_TOOL_RETRIES", 3),

  /**
   * If > 0, the per-session progress resets when no tool call has been seen for
   * this many ms. Safety net for tasks that never traverse the whole tree (which
   * is what normally triggers a reset). 0 = disabled.
   */
  idleResetMs: num("IDLE_RESET_MS", 0),

  /** Separator between server namespace and tool name. */
  nameSeparator: process.env.NAME_SEPARATOR || "__",
};
