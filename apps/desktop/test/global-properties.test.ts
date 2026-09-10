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
    expect(await globals.load()).toEqual({});
    expect(globals.get()).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });

  it('round-trips properties through the YAML file', async () => {
    const globals = new GlobalProperties(dir);
    await globals.load();

    expect(await globals.set('token', 'abc')).toEqual({ token: 'abc' });
    await globals.set('user', 'ada');
    expect(globals.get()).toEqual({ token: 'abc', user: 'ada' });
    expect(fileText()).toContain('token: abc');

    const reopened = new GlobalProperties(dir);
    expect(await reopened.load()).toEqual({ token: 'abc', user: 'ada' });
  });

  it('removes a property and replaces the whole map', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('a', '1');
    await globals.set('b', '2');

    expect(await globals.remove('a')).toEqual({ b: '2' });
    expect(await globals.remove('missing')).toEqual({ b: '2' });
    expect(await globals.replaceAll({ c: '3' })).toEqual({ c: '3' });
    expect(await new GlobalProperties(dir).load()).toEqual({ c: '3' });
  });

  it('leaves no temp files behind (the write is atomic)', async () => {
    const globals = new GlobalProperties(dir);
    await globals.set('a', '1');
    expect(readdirSync(dir)).toEqual([GLOBAL_PROPERTIES_FILE]);
  });

  it('treats a malformed or unexpected file as empty rather than failing to start', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'properties: [not, a, map]\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({});

    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), '\t: : :\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({});
  });

  it('keeps only string values, so a YAML number cannot leak into a property scope', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'version: 1\nproperties:\n  port: 8080\n  who: ada\n', 'utf8');
    expect(await new GlobalProperties(dir).load()).toEqual({ who: 'ada' });
  });

  it('serialises concurrent writes so neither is lost to a stale read', async () => {
    const globals = new GlobalProperties(dir);

    const setA = globals.set('a', '1');
    const setB = globals.set('b', '2');
    await Promise.all([setA, setB]);

    expect(globals.get()).toEqual({ a: '1', b: '2' });
    expect(await new GlobalProperties(dir).load()).toEqual({ a: '1', b: '2' });
  });
});
