import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedirectServer {
  readonly url: string;
  /** The `Authorization` header of every request it redirected. */
  readonly authorizations: (string | undefined)[];
  close(): Promise<void>;
}

/** Answers every request with a `status` redirect to `target()`, on its own origin. */
export async function startRedirectServer(target: () => string, status = 307): Promise<RedirectServer> {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      authorizations.push(request.headers.authorization);
      response.writeHead(status, { Location: target(), 'Content-Length': '0' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/old`,
    authorizations,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
