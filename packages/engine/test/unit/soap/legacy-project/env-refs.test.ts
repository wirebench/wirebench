import { describe, expect, it } from 'vitest';
import { expand } from '../../../../src/project/properties.js';
import { rewriteProjectRefsToEnv } from '../../../../src/soap/legacy-project/env-refs.js';
import type { LegacyEnvironment, LegacyInterface, LegacyProject } from '../../../../src/soap/legacy-project/model.js';

const BASE_INTERFACE: LegacyInterface = {
  name: 'Iface',
  soapVersion: '1.1',
  endpoints: [],
  operations: [],
};

const BASE_ENV: LegacyEnvironment = {
  name: 'Staging',
  properties: [{ name: 'host', value: 'staging.example.invalid' }],
  endpoints: [],
};

function project(overrides: Partial<LegacyProject>): LegacyProject {
  return {
    name: 'P',
    properties: [],
    interfaces: [],
    environments: [BASE_ENV],
    scripts: [],
    unmapped: [],
    ...overrides,
  };
}

describe('rewriteProjectRefsToEnv', () => {
  it('SC-1: rewrites ${#Project#host} to ${host} so it follows the active environment', () => {
    const call = {
      name: 'Call',
      envelope: '<a>${#Project#host}</a>',
      credentials: { hadPassword: false },
      useWsAddressing: false,
      assertions: 0,
      attachments: 0,
      wssRefs: [],
    };
    const iface: LegacyInterface = {
      ...BASE_INTERFACE,
      operations: [{ name: 'Op', bindingOperationName: 'Op', calls: [call] }],
    };
    const input = project({ interfaces: [iface] });
    const result = rewriteProjectRefsToEnv(input);
    const rewrittenCall = result.interfaces[0]!.operations[0]!.calls[0]!;
    expect(rewrittenCall.envelope).toBe('<a>${host}</a>');

    const expanded = expand(rewrittenCall.envelope!, {
      project: {},
      env: { host: 'staging.example.invalid' },
      global: {},
    });
    expect(expanded.text).toBe('<a>staging.example.invalid</a>');
  });

  it('SC-2: leaves other scopes and unknown names unchanged', () => {
    const call = {
      name: 'Call',
      envelope: '${#Project#other} ${#Env#host} ${#Global#host} ${#TestCase#host}',
      credentials: { hadPassword: false },
      useWsAddressing: false,
      assertions: 0,
      attachments: 0,
      wssRefs: [],
    };
    const iface: LegacyInterface = {
      ...BASE_INTERFACE,
      operations: [{ name: 'Op', bindingOperationName: 'Op', calls: [call] }],
    };
    const input = project({ interfaces: [iface] });
    const result = rewriteProjectRefsToEnv(input);
    expect(result.interfaces[0]!.operations[0]!.calls[0]!.envelope).toBe(
      '${#Project#other} ${#Env#host} ${#Global#host} ${#TestCase#host}',
    );
  });

  it('SC-3: rewrites call endpoint, credentials.username, interface endpoints, environment url/values, and project properties', () => {
    const call = {
      name: 'Call',
      endpoint: '${#Project#host}/svc',
      envelope: 'x',
      credentials: { hadPassword: false, username: '${#Project#host}-user' },
      useWsAddressing: false,
      assertions: 0,
      attachments: 0,
      wssRefs: [],
    };
    const iface: LegacyInterface = {
      ...BASE_INTERFACE,
      endpoints: ['${#Project#host}/svc'],
      operations: [{ name: 'Op', bindingOperationName: 'Op', calls: [call] }],
    };
    const env: LegacyEnvironment = {
      name: 'Staging',
      properties: [
        { name: 'host', value: 'staging.example.invalid' },
        { name: 'other', value: '${#Project#host}' },
      ],
      endpoints: [{ interfaceName: 'Iface', url: '${#Project#host}/svc' }],
    };
    const input = project({
      interfaces: [iface],
      environments: [env],
      properties: [{ name: 'p', value: '${#Project#host}' }],
    });
    const result = rewriteProjectRefsToEnv(input);
    const mappedCall = result.interfaces[0]!.operations[0]!.calls[0]!;
    expect(mappedCall.endpoint).toBe('${host}/svc');
    expect(mappedCall.credentials.username).toBe('${host}-user');
    expect(result.interfaces[0]!.endpoints).toEqual(['${host}/svc']);
    expect(result.environments[0]!.endpoints[0]!.url).toBe('${host}/svc');
    expect(result.environments[0]!.properties.find((p) => p.name === 'other')!.value).toBe('${host}');
    expect(result.properties[0]!.value).toBe('${host}');
    // The call endpoint and the interface endpoint still match, both rewritten identically.
    expect(mappedCall.endpoint).toBe(result.interfaces[0]!.endpoints[0]);
  });

  it('SC-5: a project with no environments imports byte-identical to before', () => {
    const call = {
      name: 'Call',
      envelope: '<a>${#Project#host}</a>',
      credentials: { hadPassword: false },
      useWsAddressing: false,
      assertions: 0,
      attachments: 0,
      wssRefs: [],
    };
    const iface: LegacyInterface = {
      ...BASE_INTERFACE,
      operations: [{ name: 'Op', bindingOperationName: 'Op', calls: [call] }],
    };
    const input = project({ interfaces: [iface], environments: [] });
    const result = rewriteProjectRefsToEnv(input);
    expect(result).toBe(input);
  });
});
