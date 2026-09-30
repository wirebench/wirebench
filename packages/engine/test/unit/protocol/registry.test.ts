import { describe, expect, it } from 'vitest';
import { ProjectError, WirebenchError } from '../../../src/errors.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';
import type { ProtocolModule } from '../../../src/protocol/module.js';
import { createProtocolRegistry, featureDisabled } from '../../../src/protocol/registry.js';

function module(kind: string, feature: Partial<FeatureDescriptor> = {}): ProtocolModule {
  return {
    kind,
    feature: { id: kind, title: kind.toUpperCase(), default: true, stage: 'stable', requires: [], ...feature },
  };
}

const SCRIPTS: FeatureDescriptor = { id: 'scripts', title: 'Scripts', default: true, stage: 'stable', requires: [] };

/** The error `run` throws, for assertions on its class, code and details. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Nothing was thrown');
}

describe('createProtocolRegistry', () => {
  it('holds the enabled modules in registration order', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest'), module('grpc')], {
      switches: { rest: false },
    });
    expect(registry.modules.map((m) => m.kind)).toEqual(['soap', 'grpc']);
  });

  it('builds its feature set from the modules and the extra features', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest')], { features: [SCRIPTS] });
    expect(registry.features.descriptors.map((descriptor) => descriptor.id)).toEqual(['soap', 'rest', 'scripts']);
    expect(registry.features.isEnabled('scripts')).toBe(true);
  });

  it('answers status, find and require for an enabled kind', () => {
    const soap = module('soap');
    const registry = createProtocolRegistry([soap]);
    expect(registry.status('soap')).toBe('enabled');
    expect(registry.find('soap')).toBe(soap);
    expect(registry.require('soap')).toBe(soap);
  });

  it('answers disabled for a kind switched off, and require throws feature-disabled', () => {
    const registry = createProtocolRegistry([module('soap'), module('grpc')], { switches: { grpc: false } });
    expect(registry.status('grpc')).toBe('disabled');
    expect(registry.find('grpc')).toBeUndefined();
    const error = thrownBy(() => registry.require('grpc'));
    expect(error).toBeInstanceOf(WirebenchError);
    expect(error).toMatchObject({
      code: 'feature-disabled',
      message: 'GRPC is switched off',
      details: { feature: 'grpc' },
    });
  });

  it('names the required feature when that is what is off', () => {
    const registry = createProtocolRegistry([module('rest'), module('graphql', { requires: ['rest'] })], {
      switches: { rest: false },
    });
    expect(registry.status('graphql')).toBe('disabled');
    expect(thrownBy(() => registry.require('graphql'))).toMatchObject({
      code: 'feature-disabled',
      message: 'GRAPHQL is off because "rest" is off',
      details: { feature: 'graphql', requires: 'rest' },
    });
  });

  it('answers unknown for a kind with no module, and require throws project-kind-not-supported', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest')]);
    expect(registry.status('graphql')).toBe('unknown');
    expect(registry.find('graphql')).toBeUndefined();
    const error = thrownBy(() => registry.require('graphql'));
    expect(error).toBeInstanceOf(ProjectError);
    expect(error).toMatchObject({
      code: 'project-kind-not-supported',
      message: 'This build has no "graphql" protocol',
      details: { kind: 'graphql', supported: ['soap', 'rest'] },
    });
  });

  it('does not take a feature that is not a protocol for a kind', () => {
    const registry = createProtocolRegistry([module('soap')], { features: [SCRIPTS] });
    expect(registry.status('scripts')).toBe('unknown');
  });

  it('throws for two modules of one kind', () => {
    expect(() => createProtocolRegistry([module('rest'), module('rest')])).toThrow(
      'createProtocolRegistry: two modules for "rest"',
    );
  });

  it('throws what the feature set throws', () => {
    expect(() => createProtocolRegistry([module('rest')], { features: [{ ...SCRIPTS, id: 'rest' }] })).toThrow(
      'createFeatureSet: duplicate feature "rest"',
    );
  });
});

describe('featureDisabled', () => {
  it('falls back to the id for a feature with no descriptor', () => {
    const registry = createProtocolRegistry([module('soap')]);
    expect(featureDisabled(registry.features, 'scripts')).toMatchObject({
      code: 'feature-disabled',
      message: 'scripts is switched off',
      details: { feature: 'scripts' },
    });
  });
});
