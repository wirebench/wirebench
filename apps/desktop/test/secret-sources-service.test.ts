import { parseLocalSecretSources, parseSecretSources, secretSourcesHash } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { containsRecordedSecret, recordSecretValue, redactSecretText, redactSecretValues } from '../src/main/redact.js';
import { SecretSourcesService, type SecretSourcesSnapshot } from '../src/main/secret-sources-service.js';

const shared = parseSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } }).sources;
const hash = secretSourcesHash(shared);

function make(snapshot: SecretSourcesSnapshot | undefined, stdout = 'pw', cacheSeconds: () => number = () => 300) {
  let current = snapshot;
  const run = vi.fn(() => Promise.resolve({ stdout, stderr: '', exitCode: 0 }));
  const values: string[] = [];
  const service = new SecretSourcesService({
    snapshot: () => current,
    cacheSeconds,
    onValue: (value) => values.push(value),
    mask: (text) => text,
    platform: 'linux',
    env: {},
    find: (tool) => Promise.resolve(`/bin/${tool}`),
    run,
  });
  return {
    service,
    run,
    values,
    set: (next: SecretSourcesSnapshot | undefined) => {
      current = next;
    },
  };
}

const approved = (): SecretSourcesSnapshot => ({ shared, local: undefined, approvedHash: hash });

describe('SecretSourcesService', () => {
  it('answers an approved mapping and passes everything else on', async () => {
    const { service, values } = make(approved());
    // `next` knows every name, the mapped one too: a mapped name must still never fall through to it.
    const get = service.wrap(() => Promise.resolve('store'));
    expect(await get('secret:db')).toBe('pw');
    expect(await get('secret:other')).toBe('store');
    expect(values).toEqual(['pw']);
  });

  it('passes everything on when no workspace is open', async () => {
    const { service, run } = make(undefined);
    expect(await service.wrap(() => Promise.resolve('store'))('secret:db')).toBe('store');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps one cache across getters', async () => {
    const { service, run } = make(approved());
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache when nothing changed, and refetches the same source after a local override change', async () => {
    const { service, run, set } = make(approved());
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
    // An override that maps the name to the very same source: only the override changed.
    set({ shared, local: parseLocalSecretSources({ db: shared['db'] }).sources, approvedHash: hash });
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refetches the same source after an approval change', async () => {
    const { service, run, set } = make(approved());
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    set({ shared, local: undefined, approvedHash: 'ff'.repeat(32) });
    service.noteChange();
    await expect(service.wrap(() => Promise.resolve(undefined))('secret:db')).rejects.toMatchObject({
      code: 'secret-source-untrusted',
    });
    set(approved());
    service.noteChange();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reads the cacheSeconds preference on each call', async () => {
    let seconds = 0;
    const { service, run } = make(approved(), 'pw', () => seconds);
    const get = service.wrap(() => Promise.resolve(undefined));
    await get('secret:db');
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
    seconds = 300;
    await get('secret:db');
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('clear() drops cached values', async () => {
    const { service, run } = make(approved());
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    service.clear();
    await service.wrap(() => Promise.resolve(undefined))('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('tests a name without returning its value', async () => {
    const { service } = make(approved());
    expect(await service.test('db')).toEqual({ ok: true, length: 2 });
    expect(await service.test('nope')).toMatchObject({ ok: false, code: 'secret-source-unmapped' });
  });

  it('reports an untrusted mapping through test', async () => {
    const { service } = make({ shared, local: undefined, approvedHash: undefined });
    expect(await service.test('db')).toMatchObject({ ok: false, code: 'secret-source-untrusted' });
  });

  it('records a resolved value so the desktop masker hides it', async () => {
    const value = 'zq9-desktop-masking-value-7731';
    const service = new SecretSourcesService({
      snapshot: approved,
      cacheSeconds: () => 300,
      onValue: recordSecretValue,
      mask: redactSecretText,
      platform: 'linux',
      env: {},
      find: (tool) => Promise.resolve(`/bin/${tool}`),
      run: () => Promise.resolve({ stdout: value, stderr: '', exitCode: 0 }),
    });
    expect(await service.wrap(() => Promise.resolve(undefined))('secret:db')).toBe(value);
    expect(containsRecordedSecret(value)).toBe(true);
    expect(redactSecretValues(`Authorization: ${value}`)).not.toContain(value);
  });
});
