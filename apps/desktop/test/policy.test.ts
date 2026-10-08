import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import { applyPolicy, loadPolicy, parsePolicy, policyFilePath } from '../src/main/policy.js';
import { PREFERENCES_FILE, PreferencesService, rememberPickedCaBundle } from '../src/main/preferences.js';

describe('policyFilePath', () => {
  it('uses a system location per OS', () => {
    const base = { env: {}, isPackaged: true };
    expect(policyFilePath({ ...base, platform: 'darwin' })).toBe('/Library/Application Support/Wirebench/policy.yaml');
    expect(policyFilePath({ ...base, platform: 'linux' })).toBe('/etc/wirebench/policy.yaml');
    expect(policyFilePath({ ...base, platform: 'win32', env: { ProgramData: 'D:\\ProgramData' } })).toBe(
      'D:\\ProgramData\\Wirebench\\policy.yaml',
    );
    expect(policyFilePath({ ...base, platform: 'win32' })).toBe('C:\\ProgramData\\Wirebench\\policy.yaml');
  });

  it('honours WIREBENCH_POLICY_FILE only in an unpackaged build', () => {
    const env = { WIREBENCH_POLICY_FILE: '/tmp/p.yaml' };
    expect(policyFilePath({ platform: 'linux', env, isPackaged: false })).toBe('/tmp/p.yaml');
    expect(policyFilePath({ platform: 'linux', env, isPackaged: true })).toBe('/etc/wirebench/policy.yaml');
  });
});

describe('parsePolicy', () => {
  it('locks every lockable key the file sets', () => {
    const policy = parsePolicy('/p', {
      version: 1,
      proxy: { mode: 'manual', host: 'proxy.corp.test', port: 8080, excludes: ['localhost'] },
      ssl: { minVersion: 'TLSv1.3', caBundlePath: '/etc/ssl/corp.pem' },
      updates: { checkOnLaunch: false },
    });
    expect(policy.error).toBeUndefined();
    expect(policy.ignored).toEqual([]);
    expect(policy.locked).toEqual([
      'proxy.mode',
      'proxy.host',
      'proxy.port',
      'proxy.excludes',
      'ssl.minVersion',
      'ssl.caBundlePath',
      'updates.checkOnLaunch',
    ]);
  });

  it('ignores sections and keys that cannot be locked, and invalid values', () => {
    const policy = parsePolicy('/p', {
      editor: { fontSize: 20 },
      proxy: { mode: 'sometimes', passwordRef: 'ref', host: 'h' },
      ssl: { caBundlePath: 'relative/ca.pem', caBundlePickedByMain: true },
      updates: 'no',
    });
    expect(policy.locked).toEqual(['proxy.host']);
    expect(policy.ignored).toEqual([
      'editor',
      'proxy.mode',
      'proxy.passwordRef',
      'ssl.caBundlePath',
      'ssl.caBundlePickedByMain',
      'updates',
    ]);
  });

  it('treats an empty document as no policy and a non-mapping as an error', () => {
    expect(parsePolicy('/p', null)).toEqual({ path: '/p', patch: {}, locked: [], ignored: [] });
    expect(parsePolicy('/p', ['a']).error).toMatch(/not a YAML mapping/);
  });
});

describe('loadPolicy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-policy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields no policy and no error when the file is missing', async () => {
    const policy = await loadPolicy(join(dir, 'policy.yaml'));
    expect(policy.locked).toEqual([]);
    expect(policy.error).toBeUndefined();
  });

  it('reports a file that is not valid YAML and locks nothing', async () => {
    writeFileSync(join(dir, 'policy.yaml'), '{{{ nope', 'utf8');
    const policy = await loadPolicy(join(dir, 'policy.yaml'));
    expect(policy.locked).toEqual([]);
    expect(policy.error).toMatch(/not valid YAML/);
  });
});

describe('applyPolicy', () => {
  it('marks a policy CA bundle as picked by main, so it is trusted without a pick', () => {
    const effective = applyPolicy(DEFAULT_PREFERENCES, parsePolicy('/p', { ssl: { caBundlePath: '/etc/ca.pem' } }));
    expect(effective.ssl).toMatchObject({ caBundlePath: '/etc/ca.pem', caBundlePickedByMain: true });
    const picks: string[] = [];
    rememberPickedCaBundle(effective, { rememberRead: (path) => picks.push(path) });
    expect(picks).toEqual(['/etc/ca.pem']);
  });
});

describe('PreferencesService with a policy', () => {
  let dir: string;
  let policyFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-policy-prefs-'));
    policyFile = join(dir, 'policy.yaml');
    writeFileSync(
      policyFile,
      'proxy:\n  mode: manual\n  host: proxy.corp.test\nupdates:\n  checkOnLaunch: false\n',
      'utf8',
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lays the policy over the user preferences', async () => {
    writeFileSync(join(dir, PREFERENCES_FILE), 'proxy:\n  mode: none\n  port: 3128\nupdates:\n  checkOnLaunch: true\n');
    const service = new PreferencesService(dir, { policyFile });
    const preferences = await service.ready();
    expect(preferences.proxy).toMatchObject({ mode: 'manual', host: 'proxy.corp.test', port: 3128 });
    expect(preferences.updates.checkOnLaunch).toBe(false);
    expect(service.isLocked('proxy.mode')).toBe(true);
    expect(service.isLocked('proxy.port')).toBe(false);
    expect(service.policy().path).toBe(policyFile);
  });

  it('refuses an update to a locked key and changes nothing', async () => {
    const service = new PreferencesService(dir, { policyFile });
    await expect(service.update({ proxy: { mode: 'none', port: 1 } })).rejects.toMatchObject({
      code: 'preference-locked',
      details: { keys: ['proxy.mode'] },
    });
    expect(service.get().proxy.port).toBeUndefined();
  });

  it('writes only the user values, never the locked ones', async () => {
    const service = new PreferencesService(dir, { policyFile });
    const next = await service.update({ proxy: { port: 8080 } });
    expect(next.proxy).toMatchObject({ mode: 'manual', port: 8080 });
    const written = parseYaml(readFileSync(join(dir, PREFERENCES_FILE), 'utf8')) as {
      proxy: { mode: string; host?: string; port: number };
    };
    expect(written.proxy).toMatchObject({ mode: 'none', port: 8080 });
    expect(written.proxy.host).toBeUndefined();
  });

  it('keeps locked values in force through a reset', async () => {
    const service = new PreferencesService(dir, { policyFile });
    await service.update({ proxy: { port: 8080 } });
    const reset = await service.reset('proxy');
    expect(reset.proxy).toMatchObject({ mode: 'manual', host: 'proxy.corp.test' });
    expect(reset.proxy.port).toBeUndefined();
  });
});
