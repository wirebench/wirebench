/** The layered script APIs (format 11): every API but the typed one is JavaScript, syntax-checked only. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { RestRequestSnapshot } from '../../../src/rest/scripting.js';
import { checkOnce } from '../../../src/script/check/service.js';
import { isLayeredApi, scriptFileName, type ScriptApi } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';

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
  it('isLayeredApi is false only for wirebench', () => {
    expect(isLayeredApi('wirebench')).toBe(false);
    for (const api of LAYERED) expect(isLayeredApi(api)).toBe(true);
  });

  it('a layered api file is .js', () => {
    expect(scriptFileName('x', 'pre', 'bruno')).toBe('x.pre.js');
    expect(scriptFileName('x', 'post', 'thunder-client')).toBe('x.post.js');
    expect(scriptFileName('x', 'pre', 'wirebench')).toBe('x.pre.ts');
  });

  it('a layered api is syntax-checked only', () => {
    for (const api of LAYERED) {
      expect(checkOnce({ source: 'const n = 1; nothing.here(n.nope);', declarations: '', api })).toEqual([]);
      expect(checkOnce({ source: 'foo(', declarations: '', api })).toHaveLength(1);
    }
  });

  it('a layered api with no layer fails with script-unsupported', async () => {
    const onSecretValue = vi.fn();
    const outcome = await runScript({
      sandbox,
      phase: 'pre',
      api: 'hoppscotch',
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
        message: 'hoppscotch scripts are not supported yet',
      });
    }
  });
});
