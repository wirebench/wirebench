import { createServer } from 'node:net';

/**
 * A port nothing is listening on. The configuration only accepts 1–65535 (port 0 is not a
 * sensible production setting), so the test asks the OS for a free port and passes it explicitly.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
