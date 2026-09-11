import { describe, expect, it } from 'vitest';
import {
  findEnvironment,
  removeEnvironment,
  resolveAuthEndpoint,
  resolveEndpoint,
  resolveScopes,
  upsertEnvironment,
} from '../../../src/project/environments.js';
import { createInterface, createProject, type Environment, type Project } from '../../../src/project/model.js';

function fixtureProject(): { project: Project; iface: ReturnType<typeof createInterface> } {
  let project = createProject('Demo', { id: 'proj-1' });
  const iface = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'calculator',
    definitionUrl: 'https://example.test/calc.wsdl',
    endpoints: [
      { id: 'ep-default', name: 'Default', url: 'https://default.test/soap', authMode: 'override' },
      { id: 'ep-alt', name: 'Alt', url: 'https://alt.test/soap', authMode: 'override' },
    ],
    defaultEndpointId: 'ep-default',
  });
  project = { ...project, interfaces: [iface], properties: { name: 'proj-name' } };
  return { project, iface };
}

const env: Environment = {
  id: 'env-1',
  name: 'QA',
  slug: 'qa',
  order: 0,
  endpoints: { calculator: 'https://qa.test/soap' },
  properties: { name: 'env-name' },
};

describe('findEnvironment', () => {
  it('finds by id', () => {
    const { project } = fixtureProject();
    const withEnv = { ...project, environments: [env] };
    expect(findEnvironment(withEnv, 'env-1')).toBe(env);
  });

  it('returns undefined for unknown id or no id', () => {
    const { project } = fixtureProject();
    const withEnv = { ...project, environments: [env] };
    expect(findEnvironment(withEnv, 'nope')).toBeUndefined();
    expect(findEnvironment(withEnv, undefined)).toBeUndefined();
  });
});

describe('resolveEndpoint precedence', () => {
  it('environment override wins over everything, including a custom request URL', () => {
    const { project, iface } = fixtureProject();
    const withEnv = { ...project, environments: [env] };
    const result = resolveEndpoint(withEnv, 'env-1', iface, { endpointUrl: 'https://custom.test/soap' });
    expect(result).toMatchObject({ url: 'https://qa.test/soap', source: 'environment' });
  });

  it('falls through to request-custom when no env or env has no override for the interface', () => {
    const { project, iface } = fixtureProject();
    const result = resolveEndpoint(project, undefined, iface, { endpointUrl: 'https://custom.test/soap' });
    expect(result).toMatchObject({ url: 'https://custom.test/soap', source: 'request-custom' });
  });

  it('unknown env id falls through as if there were no environment', () => {
    const { project, iface } = fixtureProject();
    const result = resolveEndpoint(project, 'does-not-exist', iface, { endpointUrl: 'https://custom.test/soap' });
    expect(result).toMatchObject({ url: 'https://custom.test/soap', source: 'request-custom' });
  });

  it('falls through to the request endpointId -> interface endpoint url', () => {
    const { project, iface } = fixtureProject();
    const result = resolveEndpoint(project, undefined, iface, { endpointId: 'ep-alt' });
    expect(result).toMatchObject({ url: 'https://alt.test/soap', source: 'request-endpoint' });
  });

  it('falls through to the interface default endpoint', () => {
    const { project, iface } = fixtureProject();
    const result = resolveEndpoint(project, undefined, iface, {});
    expect(result).toMatchObject({ url: 'https://default.test/soap', source: 'interface-default' });
  });

  it('falls through to the first interface endpoint when there is no default', () => {
    const { project, iface } = fixtureProject();
    const noDefaultIface: typeof iface = { ...iface };
    Reflect.deleteProperty(noDefaultIface, 'defaultEndpointId');
    const result = resolveEndpoint(project, undefined, noDefaultIface, {});
    expect(result).toMatchObject({ url: 'https://default.test/soap', source: 'interface-default' });
  });

  it('resolves to none when the interface has no endpoints at all', () => {
    const { project, iface } = fixtureProject();
    const empty: typeof iface = { ...iface, endpoints: [] };
    Reflect.deleteProperty(empty, 'defaultEndpointId');
    const result = resolveEndpoint(project, undefined, empty, {});
    expect(result).toEqual({ url: undefined, source: 'none' });
  });

  it('an unresolvable request endpointId falls through to the interface default', () => {
    const { project, iface } = fixtureProject();
    const result = resolveEndpoint(project, undefined, iface, { endpointId: 'not-real' });
    expect(result).toMatchObject({ url: 'https://default.test/soap', source: 'interface-default' });
  });
});

describe('resolveAuthEndpoint', () => {
  it("uses the request's own endpoint when set", () => {
    const { iface } = fixtureProject();
    expect(resolveAuthEndpoint(iface, { endpointId: 'ep-alt' })).toBe(iface.endpoints[1]);
  });

  it("falls back to the interface's default endpoint when the request has none", () => {
    const { iface } = fixtureProject();
    expect(resolveAuthEndpoint(iface, {})).toBe(iface.endpoints[0]);
  });

  it('falls back to the first endpoint when there is no default', () => {
    const { iface } = fixtureProject();
    const noDefault: typeof iface = { ...iface };
    Reflect.deleteProperty(noDefault, 'defaultEndpointId');
    expect(resolveAuthEndpoint(noDefault, {})).toBe(noDefault.endpoints[0]);
  });

  it('an unresolvable request endpointId falls through to the interface default', () => {
    const { iface } = fixtureProject();
    expect(resolveAuthEndpoint(iface, { endpointId: 'not-real' })).toBe(iface.endpoints[0]);
  });

  it('returns undefined when the interface has no endpoints', () => {
    const { iface } = fixtureProject();
    const empty: typeof iface = { ...iface, endpoints: [] };
    Reflect.deleteProperty(empty, 'defaultEndpointId');
    expect(resolveAuthEndpoint(empty, {})).toBeUndefined();
  });
});

describe('resolveScopes', () => {
  it('returns env properties as the env scope when an environment is active', () => {
    const { project } = fixtureProject();
    const withEnv = { ...project, environments: [env] };
    const scopes = resolveScopes(withEnv, 'env-1', { g: 'gv' });
    expect(scopes).toEqual({ project: { name: 'proj-name' }, global: { g: 'gv' }, env: { name: 'env-name' } });
  });

  it('omits env entirely when there is no active environment', () => {
    const { project } = fixtureProject();
    const scopes = resolveScopes(project, undefined, { g: 'gv' });
    expect(scopes).toEqual({ project: { name: 'proj-name' }, global: { g: 'gv' } });
    expect('env' in scopes).toBe(false);
  });

  it('passes through a system map when given', () => {
    const { project } = fixtureProject();
    const scopes = resolveScopes(project, undefined, {}, { FOO: 'bar' });
    expect(scopes.system).toEqual({ FOO: 'bar' });
  });
});

describe('upsertEnvironment / removeEnvironment', () => {
  it('appends a new environment', () => {
    const { project } = fixtureProject();
    const updated = upsertEnvironment(project, env);
    expect(updated.environments).toEqual([env]);
  });

  it('replaces an environment with the same id in place', () => {
    const { project } = fixtureProject();
    const withEnv = { ...project, environments: [env] };
    const replaced: Environment = { ...env, name: 'QA2' };
    const updated = upsertEnvironment(withEnv, replaced);
    expect(updated.environments).toEqual([replaced]);
  });

  it('keeps the other environments in order when removing one', () => {
    const { project } = fixtureProject();
    const envB: Environment = { ...env, id: 'env-2', name: 'Prod', slug: 'prod', order: 1 };
    const withEnvs = { ...project, environments: [env, envB] };
    const updated = removeEnvironment(withEnvs, 'env-1');
    expect(updated.environments).toEqual([envB]);
  });
});
