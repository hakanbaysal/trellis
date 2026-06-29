import { createApp } from "./server.js";
import * as store from "./store.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  await store.init();
  const app = createApp();
  app.listen(config.port, () => {
    /* eslint-disable no-console */
    console.log(`Trellis v0.1.0 listening on :${config.port}`);
    console.log(`  UI:   ${config.publicBaseUrl}/`);
    console.log(`  MCP:  ${config.publicBaseUrl}/mcp/<compositionId>`);
    console.log(`  data: ${config.dataDir}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
