/**
 * Plugins end to end through the built CLI (phase 7 spec §6, ADR-0031): installed into a home folder
 * of the test's own, then used by `run --reporter` and `import`. HOME, XDG_CONFIG_HOME and APPDATA
 * all point into it, so the desktop's userData resolves there on every OS.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

const MAIN = `
export const importers = {
  acme: {
    detect(input) { return input.text.startsWith('ACME COLLECTION') ? 'definite' : null; },
    import() {
      return { apis: [{ name: 'Acme API', items: [{ kind: 'request', name: 'Ping', method: 'GET', url: 'https://api.example.test/ping' }] }] };
    },
  },
};
export const reporters = {
  summary: { render(report) { return 'total ' + report.summary.total + ', passed ' + report.summary.passed + '\\n'; } },
};
`;

const MANIFEST = {
  manifestVersion: 1,
  id: 'acme',
  name: 'Acme formats',
  version: '1.0.0',
  api: 1,
  main: 'main.js',
  contributes: {
    importers: [{ id: 'acme', title: 'Acme collection', extensions: ['.acme'] }],
    reporters: [{ id: 'summary', title: 'Acme summary', extension: '.txt' }],
  },
};

let demo: DemoServer;
let root: string;
let env: Record<string, string>;

beforeAll(async () => {
  demo = await startDemoServer();
  root = await mkdtemp(join(tmpdir(), 'wirebench-cli-plugins-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData') };
  const source = join(root, 'acme');
  await mkdir(source);
  await writeFile(join(source, 'wirebench-plugin.json'), JSON.stringify(MANIFEST));
  await writeFile(join(source, 'main.js'), MAIN);
});

afterAll(async () => {
  await demo.close();
  await rm(root, { recursive: true, force: true });
});

describe('wirebench plugin', () => {
  it('refuses to install without --yes when not in a terminal, and writes nothing', async () => {
    const { code, stderr } = await runCli(['plugin', 'install', join(root, 'acme')], env);
    expect(code).toBe(2);
    expect(stderr).toContain('reporter        acme/summary  Acme summary');
    expect(stderr).toContain('pass --yes');
    expect((await runCli(['plugin', 'list'], env)).stdout).toBe('No plugins are installed.\n');
  });

  it('installs with --yes and lists it', async () => {
    const installed = await runCli(['plugin', 'install', join(root, 'acme'), '--yes'], env);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain('Installed acme 1.0.0');
    const listed = await runCli(['plugin', 'list'], env);
    expect(listed.stdout).toMatch(/^acme 1\.0\.0 {2}Acme formats {2}installed /);
  });

  it('writes a report with the plugin’s reporter, and names the plugin on stderr', async () => {
    const out = join(root, 'report.txt');
    const { code, stderr } = await runCli(
      ['run', FIXTURE, '-e', 'local', '--var', `baseUrl=${demo.url}`, '--reporter', `acme/summary=${out}`, 'demo/ok'],
      env,
    );
    expect(code).toBe(0);
    expect(stderr).toContain('plugin: acme 1.0.0');
    expect(await readFile(out, 'utf8')).toBe('total 1, passed 1\n');
  });

  it('imports a file no built-in format claims through the plugin’s importer', async () => {
    const project = join(root, 'project');
    await cp(FIXTURE, project, { recursive: true });
    const file = join(root, 'thing.acme');
    await writeFile(file, 'ACME COLLECTION v1\n');
    const { code, stdout, stderr } = await runCli(['import', file, '--project', project, '--json'], env);
    expect(stderr).toContain('plugin: acme 1.0.0');
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      format: 'plugin:acme/acme',
      added: [{ kind: 'rest', name: 'Acme API', requests: 1 }],
    });
  });

  it('loads nothing with --no-plugins or plugins=off, so the reporter is unknown', async () => {
    for (const off of [['--no-plugins'], ['--features', 'plugins=off']]) {
      const { code, stderr } = await runCli(
        [
          'run',
          FIXTURE,
          '-e',
          'local',
          '--var',
          `baseUrl=${demo.url}`,
          '--reporter',
          `acme/summary=${join(root, 'x.txt')}`,
          ...off,
          'demo/ok',
        ],
        env,
      );
      expect(code).toBe(2);
      expect(stderr).not.toContain('plugin: acme');
    }
  });

  it('skips a plugin changed after install, and removes one', async () => {
    const userData =
      process.platform === 'darwin'
        ? join(env['HOME'] ?? '', 'Library', 'Application Support', 'Wirebench')
        : process.platform === 'win32'
          ? join(env['APPDATA'] ?? '', 'Wirebench')
          : join(env['XDG_CONFIG_HOME'] ?? '', 'Wirebench');
    await writeFile(join(userData, 'plugins', 'acme', 'main.js'), `${MAIN}\n// tampered`);
    expect((await runCli(['plugin', 'list'], env)).stdout).toContain('acme  skipped (plugin-modified)');
    expect((await runCli(['plugin', 'remove', 'acme'], env)).code).toBe(0);
    expect((await runCli(['plugin', 'list'], env)).stdout).toBe('No plugins are installed.\n');
    expect((await runCli(['plugin', 'remove', 'acme'], env)).code).toBe(2);
  });
});
