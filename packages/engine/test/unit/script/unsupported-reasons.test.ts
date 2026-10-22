/**
 * A call a layer refuses says why: the reason fits the kind of call (sending, cookies, files,
 * modules, waiting, settings, ...), with a plain default for the rest.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { LayeredApi } from '../../../src/script/model.js';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

const REQUEST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://shop.test/a',
  headers: [],
  body: { kind: 'none' },
};
const RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [],
  text: '',
  durationMs: 1,
};

const messageOf = async (api: LayeredApi, phase: 'pre' | 'post', source: string): Promise<string | undefined> => {
  const outcome = await runScript({
    sandbox,
    phase,
    api,
    source,
    filename: `A.${phase}.js`,
    request: REQUEST,
    ...(phase === 'post' ? { response: RESPONSE } : {}),
    vars: {},
    props: {},
    secrets: {},
    requestName: 'A',
  });
  return outcome.ok ? undefined : outcome.error.message;
};

describe('the reason an unsupported call gives', () => {
  it.each([
    [
      'postman',
      'pre',
      'pm.sendRequest("https://x.test")',
      'pm.sendRequest is not supported: a script cannot send requests',
    ],
    ['postman', 'pre', 'pm.cookies.jar()', 'pm.cookies.jar is not supported: a script cannot keep cookies'],
    ['postman', 'pre', 'require("lodash")', 'require is not supported: a script cannot load modules'],
    ['bruno', 'pre', 'bru.sleep(5)', 'bru.sleep is not supported: a script cannot wait'],
    ['bruno', 'pre', 'req.setTimeout(5)', "req.setTimeout is not supported: set this in the request's Settings"],
    [
      'bruno',
      'pre',
      'bru.getProcessEnv("HOME")',
      "bru.getProcessEnv is not supported: a script cannot read the machine's environment",
    ],
    ['thunder-client', 'pre', 'tc.readFile("a.txt")', 'tc.readFile is not supported: a script cannot read files'],
    [
      'thunder-client',
      'post',
      'tc.chartHTML("<p/>")',
      'tc.chartHTML is not supported: a script cannot show visual output',
    ],
    [
      'hoppscotch',
      'pre',
      'hopp.env.setInitial("a", "1")',
      'hopp.env.setInitial is not supported: a script cannot change initial values',
    ],
    ['bruno', 'pre', 'req.setHeaders({})', 'req.setHeaders is not supported: Wirebench scripts cannot do this'],
  ] as const)('%s %s: %s', async (api, phase, source, message) => {
    expect(await messageOf(api, phase, source)).toBe(message);
  });
});
