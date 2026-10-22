/** The layered script APIs (format 11): every API but the typed one is JavaScript, syntax-checked only. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { RestRequestSnapshot } from '#protocol-rest/rest/scripting';
import { checkOnce } from '#core/script/check/service';
import { isLayeredApi, scriptFileName, type ScriptApi } from '#core/script/model';
import { SCRIPT_LAYERS } from '#core/script/api/layers';
import { createScriptSandbox } from '#core/script/sandbox/host';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const LAYERED: readonly ScriptApi[] = ['postman', 'insomnia', 'bruno', 'hoppscotch', 'thunder-client'];
const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://shop.test/',
  headers: [],
  body: { kind: 'none' },
};

describe('the layered script APIs', () => {
  afterEach(() => {
    vi.doUnmock('#core/script/api/layers');
    vi.resetModules();
  });

  it('every layered api has a layer', () => {
    for (const api of LAYERED) if (isLayeredApi(api)) expect(SCRIPT_LAYERS[api]).toBeTypeOf('string');
  });

  it('isLayeredApi is false only for wirebench', () => {
    expect(isLayeredApi('wirebench')).toBe(false);
    for (const api of LAYERED) expect(isLayeredApi(api)).toBe(true);
  });

  it('a layered api file is .js', () => {
    expect(scriptFileName('x', 'pre', 'bruno')).toBe('x.pre.js');
    expect(scriptFileName('x', 'post', 'thunder-client')).toBe('x.post.js');
    expect(scriptFileName('x', 'pre', 'wirebench')).toBe('x.pre.ts');
  });

  // Each api builds a checker program; under coverage on a busy runner the six of them outlast 5 s.
  it('a layered api is syntax-checked only', { timeout: 30_000 }, () => {
    for (const api of LAYERED) {
      expect(checkOnce({ source: 'const n = 1; nothing.here(n.nope);', declarations: '', api })).toEqual([]);
      expect(checkOnce({ source: 'foo(', declarations: '', api })).toHaveLength(1);
    }
  });

  // Every layered API has a layer now, so the lookup is run against an empty table.
  it('a layered api with no layer fails with script-unsupported', async () => {
    vi.resetModules();
    vi.doMock('#core/script/api/layers', () => ({ SCRIPT_LAYERS: {} }));
    // After the reset, the registry slot is empty again until the composition loads (spec §3.3).
    await import('../../../src/protocols.js');
    const { runScript: runUnlayered } = await import('#core/script/run');
    const api: ScriptApi = 'thunder-client';
    const onSecretValue = vi.fn();
    const outcome = await runUnlayered({
      sandbox,
      phase: 'pre',
      api,
      source: 'log("hi");',
      filename: 'X.pre.js',
      request: REQUEST,
      vars: {},
      props: {},
      secrets: { key: 'hunter2' },
      onSecretValue,
      requestName: 'X',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.log.lines).toEqual([]);
    expect(onSecretValue).not.toHaveBeenCalled();
    if (!outcome.ok) {
      expect(outcome.error).toEqual({
        code: 'script-unsupported',
        message: `${api} scripts are not supported yet`,
      });
    }
  });
});
