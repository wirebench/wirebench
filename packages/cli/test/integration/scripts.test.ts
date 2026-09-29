/**
 * `wirebench run` with scripts (#63): a log-in request's post-response script sets the token and
 * cookie the next request sends, none of it appears in any output, the script's log and tests
 * reach the reports, and a type error stops the run before anything is sent.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, LOGIN_TOKEN, SESSION_COOKIE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;
const temps: string[] = [];

beforeAll(async () => {
  demo = await startDemoServer();
});

afterAll(async () => {
  await demo.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  demo.requests.length = 0;
  demo.cartCalls.length = 0;
});

const SHOP_API = 'baseUrl: ${baseUrl}\nid: SHOP0001\nkind: rest\nname: shop\norder: 9\n';

const LOGIN = [
  'auth:',
  '  type: inherit',
  'body:',
  '  kind: none',
  'id: SHOP0002',
  'kind: rest',
  'method: POST',
  'name: login',
  'order: 0',
  'url: /login',
  'scripts:',
  '  post: login.post.ts',
  '',
].join('\n');

const LOGIN_SCRIPT = [
  'const body = response.json() as { token: string };',
  "vars.set('token', body.token, { secret: true });",
  "vars.set('sid', /sid=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? '');",
  "log('logged in with', body.token);",
  "test('logged in', () => expect(response.status).toBe(200));",
  '',
].join('\n');

const CART = [
  'auth:',
  '  type: inherit',
  'body:',
  '  kind: none',
  'headers:',
  '  - name: Authorization',
  '    value: Bearer ${#Sequence#token}',
  '  - name: Cookie',
  '    value: sid=${#Sequence#sid}',
  'assertions:',
  '  - type: status',
  '    equals: 201',
  'id: SHOP0003',
  'kind: rest',
  'method: POST',
  'name: cart',
  'order: 1',
  'url: /carts',
  '',
].join('\n');

async function shopProject(loginScript: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-cli-scripts-'));
  temps.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  await mkdir(join(dir, 'apis/shop/requests'), { recursive: true });
  await writeFile(join(dir, 'apis/shop/api.yaml'), SHOP_API);
  await writeFile(join(dir, 'apis/shop/requests/login.request.yaml'), LOGIN);
  await writeFile(join(dir, 'apis/shop/requests/login.post.ts'), loginScript);
  await writeFile(join(dir, 'apis/shop/requests/cart.request.yaml'), CART);
  return dir;
}

const run = (dir: string, ...rest: string[]): ReturnType<typeof runCli> =>
  runCli(['run', dir, '-e', 'local', '--var', `baseUrl=${demo.url}`, ...rest]);

describe('wirebench run with scripts', () => {
  it("carries a script's values to the next request, and never prints the token", async () => {
    const dir = await shopProject(LOGIN_SCRIPT);
    const { code, stdout, stderr } = await run(dir, 'shop/login', 'shop/cart', '-v');
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(demo.cartCalls).toEqual([{ authorization: `Bearer ${LOGIN_TOKEN}`, cookie: `sid=${SESSION_COOKIE}` }]);
    expect(stdout).toContain('✓ logged in');
    expect(stdout).toMatch(/log: logged in with \S+/);
    expect(stdout).toContain('2 passed');
    expect(stdout).not.toContain(LOGIN_TOKEN);
  });

  it('writes script tests and the masked log into the json report', async () => {
    const dir = await shopProject(LOGIN_SCRIPT);
    const report = join(dir, '..', `${String(Date.now())}-scripts.json`);
    temps.push(report);
    const { code } = await run(dir, 'shop/login', 'shop/cart', '--reporter', `json=${report}`);
    expect(code).toBe(0);
    const text = await readFile(report, 'utf8');
    expect(text).not.toContain(LOGIN_TOKEN);
    const json = JSON.parse(text) as {
      requests: { assertions: { type: string; label: string }[]; scriptLog?: string[]; unasserted: boolean }[];
    };
    expect(json.requests[0]?.assertions).toEqual([{ type: 'script', label: 'logged in', outcome: 'passed' }]);
    expect(json.requests[0]?.unasserted).toBe(false);
    expect(json.requests[0]?.scriptLog).toHaveLength(1);
  });

  it('stops before any send on a type error, naming the file, line and column', async () => {
    const dir = await shopProject('const body = response.json() as { token: string };\nlog(body.tokn);\n');
    const { code, stderr } = await run(dir, 'shop/login', 'shop/cart');
    expect(code).toBe(2);
    expect(stderr).toContain('script-type-error');
    expect(stderr).toContain('login.post.ts:2:10');
    expect(demo.requests).toEqual([]);
  });

  it('refuses a request whose script file is missing', async () => {
    const dir = await shopProject(LOGIN_SCRIPT);
    await rm(join(dir, 'apis/shop/requests/login.post.ts'));
    const { code, stderr } = await run(dir, 'shop/login');
    expect(code).toBe(2);
    expect(stderr).toContain('script-file-missing');
    expect(demo.requests).toEqual([]);
  });
});
