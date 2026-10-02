import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createConfig } from './config.js';

export async function startServer(): Promise<void> {
  const config = createConfig();
  const app = await createApp({ config, startWorker: true });
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    if (closing) return closing;
    app.backend.stop();
    const timeout = setTimeout(() => { process.exitCode = 1; }, 5_000);
    timeout.unref();
    closing = app.close().finally(() => clearTimeout(timeout));
    return closing;
  };
  const onSignal = () => { void shutdown(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await app.listen({ host: config.host, port: config.port });
    process.stdout.write(`Redmine Workspace is listening on ${config.host}:${config.port} (${config.mode} mode).\n`);
  } catch {
    app.backend.stop();
    await app.close();
    process.stderr.write('Redmine Workspace failed to start. Check the local server configuration.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startServer().catch(() => {
    process.stderr.write('Redmine Workspace could not initialize. Check the local server configuration.\n');
    process.exitCode = 1;
  });
}
