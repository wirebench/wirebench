/** An HTTPS token service for tests: hands each RST to `answer` (sync or async), records what it was sent. */
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateServerCert, generateTestCa } from './test-certs.js';

export interface StsAnswer {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TestSts {
  readonly url: string;
  readonly caPem: string;
  readonly requests: { readonly headers: Record<string, string | string[] | undefined>; readonly body: string }[];
  close(): Promise<void>;
}

export async function startTestSts(answer: (body: string) => StsAnswer | Promise<StsAnswer>): Promise<TestSts> {
  const ca = generateTestCa();
  const cert = generateServerCert(ca, { sans: ['localhost', '127.0.0.1'] });
  const requests: TestSts['requests'] = [];
  const server = createServer({ cert: cert.certPem, key: cert.keyPem }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: request.headers, body });
      void Promise.resolve(answer(body))
        .catch((error: unknown): StsAnswer => ({ status: 500, body: String(error) }))
        .then((reply) => {
          response.writeHead(reply.status, { 'content-type': 'application/soap+xml; charset=utf-8', ...reply.headers });
          response.end(reply.body);
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${String(port)}/trust/13/usernamemixed`,
    caPem: ca.certPem,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
