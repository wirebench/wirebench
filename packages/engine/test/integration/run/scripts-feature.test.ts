/**
 * The `scripts` feature in a run (spec §5.3, §9): a request with active scripts is refused, not
 * sent, when the feature is off or its protocol has no scripting facet; a request whose own scripts
 * are switched off is sent either way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ProtocolModule, ProtocolRun } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import type { ProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../../src/protocols.js';
import type { RunContext } from '../../../src/run/context.js';
import { checkRunScripts, runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { echoProtocol, echoRun, echoScripting, echoStorage } from '../../helpers/echo-protocol.js';
import type { EchoApi, EchoRequest, EchoSelected } from '../../helpers/echo-protocol.js';

const sandbox = createScriptSandbox();
const dir = mkdtempSync(join(tmpdir(), 'wb-scripts-feature-'));

afterAll(async () => {
  await sandbox.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** How many requests reached the protocol's `open`. */
let sends = 0;
beforeEach(() => {
  sends = 0;
});

const counted: ProtocolRun<EchoSelected> = {
  ...echoRun,
  open: (selected, scope, host, options) => {
    sends += 1;
    return echoRun.open(selected, scope, host, options);
  },
};
const scriptable = defineProtocol({
  kind: 'echo',
  feature: echoProtocol.feature,
  storage: echoStorage,
  run: counted,
  scripting: echoScripting,
});
const scriptless = defineProtocol({ kind: 'echo', feature: echoProtocol.feature, storage: echoStorage, run: counted });

const registryOf = (echo: ProtocolModule, switches: Readonly<Record<string, boolean>> = {}): ProtocolRegistry =>
  createProtocolRegistry([...BUILTIN_PROTOCOLS, echo], { features: [SCRIPTS_FEATURE], switches });

const ACTIVE: RequestScripts = {
  api: 'wirebench',
  enabled: true,
  secrets: [],
  post: { text: "test('ran', () => expect(response.text).toBe('ping'));\n" },
};
const SWITCHED_OFF: RequestScripts = { ...ACTIVE, enabled: false };

function project(scripts: RequestScripts | undefined): Project {
  const request: EchoRequest = {
    id: 'echo-ping',
    name: 'Ping',
    slug: 'ping',
    text: 'ping',
    ...(scripts !== undefined ? { scripts } : {}),
  };
  const api: EchoApi = { kind: 'echo', id: 'echo-1', name: 'Echo', slug: 'echo', order: 0, requests: [request] };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-scripts-feature',
    name: 'Scripts feature',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
    sequences: [],
    extraContainers: { echo: [api] },
  } as unknown as Project;
}

function setup(scripts: RequestScripts | undefined, registry: ProtocolRegistry) {
  const p = project(scripts);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    // No checker: these tests are about what is refused before a script is looked at.
    scripting: new RequestScripting({ sandbox, registry }),
    registry,
  };
  return { selected: selectRequests(p, [], registry).selected, context };
}

async function run(scripts: RequestScripts | undefined, registry: ProtocolRegistry) {
  const { selected, context } = setup(scripts, registry);
  return (await runRequests(selected, context)).requests[0];
}

describe('the scripts feature in a run', () => {
  it('on: a request with active scripts runs them', { timeout: 30_000 }, async () => {
    const result = await run(ACTIVE, registryOf(scriptable));
    expect(result).toMatchObject({ outcome: 'passed', assertions: [{ label: 'ran', outcome: 'passed' }] });
    expect(result?.scriptsOff).toBeUndefined();
    expect(sends).toBe(1);
  });

  it('off: a request with active scripts errors with feature-disabled and is not sent', async () => {
    const result = await run(ACTIVE, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({
      outcome: 'errored',
      error: { code: 'feature-disabled', details: { feature: 'scripts' } },
    });
    expect(sends).toBe(0);
  });

  it('off: a request whose own scripts are switched off is sent, and says so', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true });
    expect(sends).toBe(1);
  });

  it('off: a request with no scripts is sent', async () => {
    const result = await run(undefined, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({ outcome: 'passed' });
    expect(result?.scriptsOff).toBeUndefined();
    expect(sends).toBe(1);
  });

  it('on: a request whose own scripts are switched off is sent without them, and says so', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptable));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true, assertions: [] });
    expect(sends).toBe(1);
  });
});

describe('a protocol with no scripting facet', () => {
  it('refuses a request with active scripts with script-unsupported, and does not send it', async () => {
    const result = await run(ACTIVE, registryOf(scriptless));
    expect(result).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-unsupported', details: { path: 'Echo/Ping', protocol: 'echo' } },
    });
    expect(sends).toBe(0);
  });

  it('sends a request whose scripts are switched off', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptless));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true });
    expect(sends).toBe(1);
  });
});

describe('checkRunScripts', () => {
  it('reports feature-disabled for a request with active scripts when the feature is off', async () => {
    const { selected, context } = setup(ACTIVE, registryOf(scriptable, { scripts: false }));
    const errors = await checkRunScripts(selected, context);
    expect(errors.map((error) => error.code)).toEqual(['feature-disabled']);
  });

  it('reports script-unsupported for a protocol with no scripting facet', async () => {
    const { selected, context } = setup(ACTIVE, registryOf(scriptless));
    const errors = await checkRunScripts(selected, context);
    expect(errors.map((error) => error.code)).toEqual(['script-unsupported']);
  });

  it('reports nothing for switched-off scripts, or when the feature is on', async () => {
    const off = setup(SWITCHED_OFF, registryOf(scriptable, { scripts: false }));
    expect(await checkRunScripts(off.selected, off.context)).toEqual([]);
    const on = setup(ACTIVE, registryOf(scriptable));
    expect(await checkRunScripts(on.selected, on.context)).toEqual([]);
  });
});
