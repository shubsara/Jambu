/**
 * Process entry point.
 *
 * Run with `node --env-file=.env dist/server.js`. Configuration is validated
 * before the server binds, so a misconfigured process fails immediately
 * instead of serving requests it cannot fulfil.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    process.exit(1);
  }
}

await main();
