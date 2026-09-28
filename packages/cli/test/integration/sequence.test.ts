/**
 * `wirebench run --sequence`: a login step's token and cookie reach the next step through transfers,
 * the token never appears in any output, and a sequence that cannot run, or that would let a response
 * choose where a request goes, is refused.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIXTURE, LOGIN_TOKEN, SESSION_COOKIE, hashTree, runCli, startDemoServer } from './helpers.js';
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

function request(id: string, name: string, url: string, extra = ''): string {
  return `auth:\n  type: inherit\nbody:\n  kind: none\nid: ${id}\nkind: rest\nmethod: POST\nname: ${name}\norder: 0\nurl: ${url}\n${extra}`;
}

const CART_HEADERS = [
  'headers:',
  '  - name: Authorization',
  '    value: Bearer ${#Sequence#token}',
  '  - name: Cookie',
  '    value: sid=${#Sequence#sid}',
  'assertions:',
  '  - type: status',
  '    equals: 201',
  '',
].join('\n');

const LOGIN_STEP = [
  '  - id: STEP0001',
  '    name: Log in',
  '    request: SHOP0002',
  '    transfers:',
  '      - name: token',
  '        from: body',
  '        language: jsonpath',
  '        expression: $.token',
  '        secret: true',
  '      - name: sid',
  '        from: cookie',
  '        cookie: sid',
  '      - name: elsewhere',
  '        from: body',
  '        language: jsonpath',
  '        expression: $.elsewhere',
  '    assertions:',
  '      - type: header',
  '        header: set-cookie',
  '        exists: true',
].join('\n');

function sequence(id: string, name: string, steps: string): string {
  return `kind: sequence\nversion: 1\nid: ${id}\nname: ${name}\norder: 0\nsteps:\n${steps}\n`;
}

/** The runner fixture plus a `shop` API and its sequences, in a folder of its own. */
async function shopProject(sequences: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-cli-seq-'));
  temps.push(dir);
  await cp(FIXTURE, dir, { recursive: true });
  await mkdir(join(dir, 'apis/shop/requests'), { recursive: true });
  await writeFile(join(dir, 'apis/shop/api.yaml'), SHOP_API);
  await writeFile(join(dir, 'apis/shop/requests/login.request.yaml'), request('SHOP0002', 'login', '/login'));
  await writeFile(
    join(dir, 'apis/shop/requests/cart.request.yaml'),
    request('SHOP0003', 'cart', '/carts', CART_HEADERS),
  );
  await writeFile(
    join(dir, 'apis/shop/requests/elsewhere.request.yaml'),
    request('SHOP0004', 'elsewhere', '${#Sequence#elsewhere}/carts'),
  );
  await mkdir(join(dir, 'sequences'), { recursive: true });
  for (const [slug, text] of Object.entries(sequences)) {
    await writeFile(join(dir, 'sequences', `${slug}.sequence.yaml`), text);
  }
  return dir;
}

const CHECKOUT = sequence(
  'SEQ0001',
  'checkout',
  `${LOGIN_STEP}\n  - id: STEP0002\n    name: Create cart\n    request: SHOP0003\n    transfers:\n      - name: cart\n        from: body\n        language: jsonpath\n        expression: $.id`,
);

const run = (dir: string, ...rest: string[]): ReturnType<typeof runCli> =>
  runCli(['run', dir, '-e', 'local', '--var', `baseUrl=${demo.url}`, ...rest]);

describe('wirebench run --sequence', () => {
  it('carries a token and a cookie from the login step to the next', async () => {
    const dir = await shopProject({ checkout: CHECKOUT });
    const before = await hashTree(dir);
    const { code, stdout, stderr } = await run(dir, '--sequence', 'checkout', '-v');
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(demo.cartCalls).toEqual([{ authorization: `Bearer ${LOGIN_TOKEN}`, cookie: `sid=${SESSION_COOKIE}` }]);
    expect(stdout).toContain('✓ checkout/1. Log in');
    expect(stdout).toContain('✓ checkout/2. Create cart');
    expect(stdout).toContain('→ token = (secret)');
    expect(stdout).toContain('→ cart = cart-42');
    expect(stdout).toContain('2 passed');
    expect(stdout).not.toContain(LOGIN_TOKEN);
    // Like any run, a sequence run writes nothing to the project.
    expect(await hashTree(dir)).toEqual(before);
  });

  it('writes the sequence and its transfers into the json report, with no secret value anywhere', async () => {
    const dir = await shopProject({ checkout: CHECKOUT });
    const report = join(dir, '..', `${Date.now()}-report.json`);
    temps.push(report);
    const junit = join(dir, '..', `${Date.now()}-report.xml`);
    temps.push(junit);
    const { code } = await run(
      dir,
      '--sequence',
      'sequences/checkout.sequence.yaml',
      '--reporter',
      `json=${report}`,
      '--reporter',
      `junit=${junit}`,
    );
    expect(code).toBe(0);
    const text = await readFile(report, 'utf8');
    expect(text).not.toContain(LOGIN_TOKEN);
    const json = JSON.parse(text) as { requests: { sequence?: unknown; transfers?: unknown[]; group: string }[] };
    expect(json.requests.map((r) => r.group)).toEqual(['checkout', 'checkout']);
    expect(json.requests[0]?.sequence).toEqual({ id: 'SEQ0001', name: 'checkout', stepId: 'STEP0001' });
    expect(json.requests[0]?.transfers).toEqual([
      { name: 'token', outcome: 'set', secret: true },
      { name: 'sid', outcome: 'set', secret: false, value: SESSION_COOKIE },
      { name: 'elsewhere', outcome: 'set', secret: false, value: 'http://127.0.0.1:1' },
    ]);
    const xml = await readFile(junit, 'utf8');
    expect(xml).toContain('name="checkout"');
    expect(xml).not.toContain(LOGIN_TOKEN);
  });

  it('fails a step on its assertion and skips the rest', async () => {
    const failing = sequence(
      'SEQ0002',
      'strict login',
      '  - id: STEP0010\n    request: SHOP0002\n    assertions:\n      - type: status\n        equals: 204\n  - id: STEP0011\n    request: SHOP0003',
    );
    const dir = await shopProject({ 'strict-login': failing });
    const { code, stdout } = await run(dir, '--sequence', 'strict login');
    expect(code).toBe(1);
    expect(stdout).toContain('expected 204');
    expect(stdout).toContain('1 failed');
    expect(stdout).toContain('1 skipped');
    expect(demo.requests).toEqual(['/login']);
  });

  it('errors a step whose sequence values were never set, without sending it', async () => {
    const early = sequence('SEQ0005', 'no login', '  - id: STEP0012\n    request: SHOP0003');
    const dir = await shopProject({ 'no-login': early });
    const { code, stdout } = await run(dir, '--sequence', 'no login');
    expect(code).toBe(3);
    expect(stdout).toContain('unresolved-properties');
    expect(demo.requests).toEqual([]);
  });

  it('refuses a step whose destination a response would choose, before sending it', async () => {
    const redirected = sequence('SEQ0003', 'redirected', `${LOGIN_STEP}\n  - id: STEP0020\n    request: SHOP0004`);
    const dir = await shopProject({ redirected });
    const { code, stdout } = await run(dir, '--sequence', 'redirected');
    expect(code).toBe(3);
    expect(stdout).toContain('sequence-origin-from-response');
    expect(demo.requests).toEqual(['/login']);
  });

  it('refuses a sequence with a step whose request is gone, naming the step', async () => {
    const broken = sequence('SEQ0004', 'broken', '  - id: STEP0030\n    name: Pay\n    request: GONE0001');
    const dir = await shopProject({ broken });
    const { code, stderr } = await run(dir, '--sequence', 'broken');
    expect(code).toBe(2);
    expect(stderr).toContain('"broken" step 1 (Pay)');
    expect(demo.requests).toEqual([]);
  });

  it('refuses an unknown sequence, and a sequence together with selectors', async () => {
    const dir = await shopProject({ checkout: CHECKOUT });
    const unknown = await run(dir, '--sequence', 'nope');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('--sequence matched nothing: nope; sequences: checkout');
    const mixed = await run(dir, 'demo/ok', '--sequence', 'checkout');
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain('--sequence cannot be combined with request selectors');
  });

  it('lists the secrets a sequence needs', async () => {
    const dir = await shopProject({ checkout: CHECKOUT });
    const { code, stdout } = await runCli(['secrets', 'list', dir, '--sequence', 'checkout', '-e', 'local']);
    expect(code).toBe(0);
    expect(stdout).toContain('No secrets needed.');
  });
});
