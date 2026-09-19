import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestSoapServer } from '@wirebench/engine/test-helpers';
import type { TestSoapServer } from '@wirebench/engine/test-helpers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;
let soap: TestSoapServer;
const temps: string[] = [];

beforeAll(async () => {
  demo = await startDemoServer();
  soap = await startTestSoapServer();
});

afterAll(async () => {
  await demo.close();
  await soap.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  demo.requests.length = 0;
  demo.secureAuth.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-reports-'));
  temps.push(dir);
  return dir;
}

const vars = (): string[] => ['--var', `baseUrl=${demo.url}`];

describe('junit and json report files', () => {
  it('writes both into a directory that did not exist and still prints the cli report', async () => {
    const dir = await tempDir();
    const junitFile = join(dir, 'out', 'r.xml');
    const jsonFile = join(dir, 'out', 'r.json');
    const htmlFile = join(dir, 'out', 'r.html');
    const { code, stdout } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      ...vars(),
      '--reporter',
      `junit=${junitFile}`,
      '--reporter',
      `json=${jsonFile}`,
      '--reporter',
      `html=${htmlFile}`,
      '--reporter',
      'cli',
      'demo/ok',
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain('✓ demo/ok');
    expect(stdout).toContain('1 passed');

    const junit = await readFile(junitFile, 'utf8');
    expect(junit).toContain('<testsuites');
    expect(junit).toContain('demo/ok'.split('/').pop() as string);

    const json = JSON.parse(await readFile(jsonFile, 'utf8')) as { formatVersion: number };
    expect(json.formatVersion).toBe(1);

    const html = await readFile(htmlFile, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('demo/ok');
  });

  it('still writes both reports on a failing run', async () => {
    const dir = await tempDir();
    const junitFile = join(dir, 'out', 'r.xml');
    const jsonFile = join(dir, 'out', 'r.json');
    const { code } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      ...vars(),
      '--reporter',
      `junit=${junitFile}`,
      '--reporter',
      `json=${jsonFile}`,
      'demo/broken',
    ]);
    expect(code).toBe(1);
    expect(await readFile(junitFile, 'utf8')).toContain('failures="1"');
    const json = JSON.parse(await readFile(jsonFile, 'utf8')) as { requests: readonly { outcome: string }[] };
    expect(json.requests[0]?.outcome).toBe('failed');
  });

  it("exits 2, naming the path, when a report's parent is a regular file", async () => {
    const dir = await tempDir();
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const badFile = join(blocker, 'r.xml');
    const { code, stderr } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      ...vars(),
      '--reporter',
      `junit=${badFile}`,
      'demo/ok',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain(badFile);
  });

  it('never lets the password, or its Basic form, reach either report file', async () => {
    const dir = await tempDir();
    const junitFile = join(dir, 'out', 'r.xml');
    const jsonFile = join(dir, 'out', 'r.json');
    const htmlFile = join(dir, 'out', 'r.html');
    const password = 'wrong-pass-long';
    const { code } = await runCli(
      [
        'run',
        FIXTURE,
        '-e',
        'local',
        ...vars(),
        '--reporter',
        `junit=${junitFile}`,
        '--reporter',
        `json=${jsonFile}`,
        '--reporter',
        `html=${htmlFile}`,
        'demo/secure',
      ],
      { WIREBENCH_SECRET_DEMO_PASSWORD: password },
    );
    expect(code).toBe(1);
    const basic = `Basic ${Buffer.from(`svc:${password}`).toString('base64')}`;
    const junit = await readFile(junitFile, 'utf8');
    const json = await readFile(jsonFile, 'utf8');
    const html = await readFile(htmlFile, 'utf8');
    for (const content of [junit, json, html]) {
      expect(content).not.toContain(password);
      expect(content).not.toContain(basic);
    }
  });

  it('never lets an escaped form of a secret reach a report, stdout or stderr', async () => {
    const dir = await tempDir();
    const junitFile = join(dir, 'r.xml');
    const jsonFile = join(dir, 'r.json');
    const htmlFile = join(dir, 'r.html');
    // Every character some encoding rewrites: `&` `<` `"` `'` for XML, `"` and `\\` for JSON, the
    // space for a form body.
    const secret = `p&ss<1 "q'\\x long`;
    const { code, stdout, stderr } = await runCli(
      [
        'run',
        FIXTURE,
        '-e',
        'local',
        ...vars(),
        '--var',
        `soapUrl=${soap.url}/soap`,
        '--verbose',
        '--reporter',
        `junit=${junitFile}`,
        '--reporter',
        `json=${jsonFile}`,
        '--reporter',
        `html=${htmlFile}`,
        '--reporter',
        'cli',
        // The WS-Security username token writes the secret into the SOAP request body as XML text
        // (and the test server echoes the envelope back); `/echo` writes it back in a JSON string,
        // with entities and form-encoded. Both requests fail an assertion, so both exchanges land
        // in every report.
        'Echo/Echo/Secured hello',
        'demo/echo',
      ],
      { WIREBENCH_SECRET_SEC_WSS: secret, WIREBENCH_SECRET_DEMO_PASSWORD: secret },
    );
    expect(code).toBe(1);
    // The secret really travelled, in the escaped forms this test is about.
    const envelope = soap.requests.at(-1)?.body.toString('utf8') ?? '';
    expect(envelope).toContain(`p&amp;ss&lt;1 "q'\\x long`);
    const entities = 'p&amp;ss&lt;1 &quot;q&apos;\\x long';
    const forms = [
      secret,
      `p&amp;ss&lt;1 "q'\\x long`,
      entities,
      JSON.stringify(secret).slice(1, -1),
      new URLSearchParams({ v: secret }).toString().slice(2),
      encodeURIComponent(secret),
    ];
    const outputs = {
      junit: await readFile(junitFile, 'utf8'),
      json: await readFile(jsonFile, 'utf8'),
      html: await readFile(htmlFile, 'utf8'),
      stdout,
      stderr,
    };
    // The exchanges are there — masked, not missing.
    expect(outputs.stdout).toContain('/echo');
    for (const [name, content] of Object.entries(outputs)) {
      for (const form of forms) {
        expect(content.includes(form), `${name} contains ${form}`).toBe(false);
      }
    }
  });
});
