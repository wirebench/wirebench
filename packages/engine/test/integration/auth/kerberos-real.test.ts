import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sendWithAuth } from '../../../src/http/auth/apply.js';
import { kerberosToken } from '../../../src/http/auth/kerberos-token.js';
import { describeKerberos } from '../../helpers/kerberos-gate.js';

interface ServerContext {
  step(token: string): Promise<string>;
  readonly username: string;
}
const load = () =>
  createRequire(import.meta.url)('kerberos') as { initializeServer(service: string): Promise<ServerContext> };

describeKerberos('Kerberos against a real KDC', () => {
  let server: Server | undefined;
  let url = '';
  const users: string[] = [];

  beforeAll(async () => {
    execFileSync('kinit', ['-kt', process.env['WIREBENCH_KRB_CLIENT_KEYTAB'] ?? '', 'alice@WIREBENCH.TEST']);
    const kerberos = load();
    server = createServer((request, response) => {
      const header = request.headers.authorization;
      if (header?.startsWith('Negotiate ') !== true) {
        response.writeHead(401, { 'WWW-Authenticate': 'Negotiate' }).end();
        return;
      }
      void kerberos.initializeServer('HTTP@localhost').then(
        async (context) => {
          const reply = await context.step(header.slice('Negotiate '.length));
          users.push(context.username);
          response.writeHead(200, { 'WWW-Authenticate': `Negotiate ${reply}` }).end('ok');
        },
        () => response.writeHead(401).end(),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, 'localhost', resolve));
    url = `http://localhost:${(server.address() as AddressInfo).port}/svc`;
  });

  afterAll(() => {
    server?.close();
  });

  const get = () => ({ url, method: 'GET' as const, headers: {}, timeoutMs: 10_000, followRedirects: false });

  it('authenticates with the signed-in ticket and verifies the server (SC-K1)', async () => {
    const result = await sendWithAuth(get(), { type: 'kerberos' });
    expect(result.http.status).toBe(200);
    expect(result.auth).toMatchObject({ scheme: 'kerberos', challenged: true, attempts: 2, spn: 'HTTP@localhost' });
    expect(users.at(-1)).toBe('alice@WIREBENCH.TEST');
  });

  it('makes a token a real acceptor accepts (the #41 seam, SC-K10)', async () => {
    const token = await kerberosToken('HTTP@localhost', {});
    const context = await load().initializeServer('HTTP@localhost');
    await context.step(Buffer.from(token).toString('base64'));
    expect(context.username).toBe('alice@WIREBENCH.TEST');
  });

  it('names an SPN the KDC does not know', async () => {
    // Dotless, so it maps to the default realm and the KDC answers "not found in Kerberos database".
    await expect(sendWithAuth(get(), { type: 'kerberos', spn: 'HTTP/nowhere' })).rejects.toMatchObject({
      code: 'kerberos-unknown-spn',
    });
  });

  // Must stay last: it destroys the ticket every test above relies on.
  it('says there is no ticket after kdestroy', async () => {
    execFileSync('kdestroy');
    await expect(sendWithAuth(get(), { type: 'kerberos' })).rejects.toMatchObject({ code: 'kerberos-no-credentials' });
  });
});
