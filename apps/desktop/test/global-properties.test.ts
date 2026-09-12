// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_PROPERTIES_FILE, GlobalProperties } from '../src/main/global-properties.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-globals-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileText(): string {
  return readFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'utf8');
}

describe('GlobalProperties', () => {
  it('starts empty when there is no file, and never writes one until asked', async () => {
    const globals = new GlobalProperties(dir);
    expect(await globals.load()).toEqual({ properties: {}, disabled: [] });
    expect(globals.get()).toEqual({ properties: {}, disabled: [] });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('round-trips properties through the YAML file', async () => {
    const globals = new GlobalProperties(dir);
    await globals.load();

    expect(await globals.set('token', 'abc')).toEqual({ properties: { token: 'abc' }, disabled: [] });
    await globals.set('user', 'ada');
    expect(globals.get()).toEqual({ properties: { token: 'abc', user: 'ada' }, disabled: [] });
    expect(fileText()).toContain('token: abc');
    expect(fileText()).toContain('version: 2');

    const reopened = new GlobalProperties(dir);
    expect(await reopened.load()).toEqual({ properties: { token: 'abc', user: 'ada' }, disabled: [] });
  });

  it('removes a property and replaces the whole map', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('a', '1');
    await globals.set('b', '2');

    expect(await globals.remove('a')).toEqual({ properties: { b: '2' }, disabled: [] });
    expect(await globals.remove('missing')).toEqual({ properties: { b: '2' }, disabled: [] });
    expect(await globals.replaceAll({ c: '3' })).toEqual({ properties: { c: '3' }, disabled: [] });
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: { c: '3' }, disabled: [] });
  });

  it('leaves no temp files behind (the write is atomic)', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('a', '1');
    expect(readdirSync(dir)).toEqual([GLOBAL_PROPERTIES_FILE]);
  });

  it('treats a malformed or unexpected file as empty rather than failing to start', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'properties: [not, a, map]\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: {}, disabled: [] });

    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), '\t: : :\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: {}, disabled: [] });
  });

  it('keeps only string values, so a YAML number cannot leak into a property scope', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'version: 1\nproperties:\n  port: 8080\n  who: ada\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: { who: 'ada' }, disabled: [] });
  });

  it('serialises concurrent writes so neither is lost to a stale read', async () => {
    const globals = new GlobalProperties(dir);

    const setA = globals.set('a', '1');
    const setB = globals.set('b', '2');
    await Promise.all([setA, setB]);

    expect(globals.get()).toEqual({ properties: { a: '1', b: '2' }, disabled: [] });
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: { a: '1', b: '2' }, disabled: [] });
  });

  it('reads a v1 file (no `disabled` key) as an empty disabled list', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'version: 1\nproperties:\n  token: abc\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: { token: 'abc' }, disabled: [] });
  });

  it('setEnabled toggles a name in the disabled list without touching its value', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('token', 'abc');

    expect(await globals.setEnabled('token', false)).toEqual({ properties: { token: 'abc' }, disabled: ['token'] });
    expect(fileText()).toContain('disabled:');
    expect(await new GlobalProperties(dir).load()).toEqual({ properties: { token: 'abc' }, disabled: ['token'] });

    expect(await globals.setEnabled('token', true)).toEqual({ properties: { token: 'abc' }, disabled: [] });
    expect(fileText()).not.toContain('disabled:');
  });

  it('drops a disabled name once its property is removed', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('token', 'abc');
    await globals.setEnabled('token', false);

    expect(await globals.remove('token')).toEqual({ properties: {}, disabled: [] });
    expect(fileText()).not.toContain('disabled:');
  });

  it('sorts and deduplicates the disabled list on write', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('b', '2');
    await globals.set('a', '1');
    await globals.setEnabled('b', false);
    await globals.setEnabled('a', false);

    expect(globals.get().disabled).toEqual(['a', 'b']);
  });
});
