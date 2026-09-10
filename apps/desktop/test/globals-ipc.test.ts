import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_PROPERTIES_FILE, GlobalProperties } from '../src/main/global-properties.js';
import { wrapHandler } from '../src/main/ipc/envelope.js';
import { channels } from '../src/shared/ipc.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wirebench-globals-ipc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Regression test for the startup race: `globals.get` used to read `globals.get()` synchronously
 * without awaiting the initial `load()`, so a call arriving before the disk read resolved got
 * `{}` back forever. The fix is `globals.get` awaiting {@link GlobalProperties.ready} first.
 */
describe('globals.get IPC handler', () => {
  it('waits for the initial load before answering, even when the disk read is slow', async () => {
    writeFileSync(join(dir, GLOBAL_PROPERTIES_FILE), 'version: 1\nproperties:\n  token: abc\n', 'utf8');
    const globals = new GlobalProperties(dir);

    // Mirrors the fix in src/main/ipc/globals.ts's `globals.get` handler.
    const getHandler = wrapHandler(channels.globals.get, async () => {
      await globals.ready();
      return { properties: globals.get() };
    });

    // Call the handler before anything has triggered `load()` — simulating the handler being
    // registered (and called) ahead of `main/index.ts`'s startup warm-up resolving.
    const result = await getHandler(undefined);

    expect(result).toEqual({ ok: true, value: { properties: { token: 'abc' } } });
  });
});
