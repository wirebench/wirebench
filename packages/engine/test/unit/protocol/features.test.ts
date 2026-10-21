import { describe, expect, it } from 'vitest';
import { createFeatureSet, resolveFeatures } from '../../../src/protocol/features.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';

function feature(id: string, extra: Partial<FeatureDescriptor> = {}): FeatureDescriptor {
  return { id, title: id.toUpperCase(), default: true, stage: 'stable', requires: [], ...extra };
}

describe('createFeatureSet', () => {
  it('turns a feature on or off by its default when no switch names it', () => {
    const set = createFeatureSet([feature('rest'), feature('beta', { default: false, stage: 'experimental' })]);
    expect(set.isEnabled('rest')).toBe(true);
    expect(set.whyDisabled('rest')).toBeUndefined();
    expect(set.isEnabled('beta')).toBe(false);
    expect(set.whyDisabled('beta')).toEqual({ by: 'switch' });
  });

  it('lets a switch override the default, both ways', () => {
    const set = createFeatureSet([feature('rest'), feature('beta', { default: false })], { rest: false, beta: true });
    expect(set.isEnabled('rest')).toBe(false);
    expect(set.whyDisabled('rest')).toEqual({ by: 'switch' });
    expect(set.isEnabled('beta')).toBe(true);
  });

  it('keeps a feature on while everything it requires is on', () => {
    const set = createFeatureSet([feature('rest'), feature('mocks', { requires: ['rest'] })]);
    expect(set.isEnabled('mocks')).toBe(true);
  });

  it('turns a feature off when one it requires is off, and names it', () => {
    const set = createFeatureSet(
      [feature('rest'), feature('mocks', { requires: ['rest'] }), feature('replay', { requires: ['mocks'] })],
      { rest: false },
    );
    expect(set.whyDisabled('mocks')).toEqual({ by: 'requires', feature: 'rest' });
    expect(set.whyDisabled('replay')).toEqual({ by: 'requires', feature: 'mocks' });
    expect(set.isEnabled('replay')).toBe(false);
  });

  it('says a switch before a requirement when both turn a feature off', () => {
    const set = createFeatureSet([feature('rest'), feature('mocks', { requires: ['rest'] })], {
      rest: false,
      mocks: false,
    });
    expect(set.whyDisabled('mocks')).toEqual({ by: 'switch' });
  });

  it('treats an id with no descriptor as off, and a feature requiring one as off too', () => {
    const set = createFeatureSet([feature('mocks', { requires: ['graphql'] })]);
    expect(set.isEnabled('graphql')).toBe(false);
    expect(set.whyDisabled('graphql')).toEqual({ by: 'unknown' });
    expect(set.whyDisabled('mocks')).toEqual({ by: 'requires', feature: 'graphql' });
  });

  it('ignores a switch for an id with no descriptor', () => {
    const set = createFeatureSet([feature('rest')], { graphql: true });
    expect(set.isEnabled('graphql')).toBe(false);
    expect(set.descriptors.map((descriptor) => descriptor.id)).toEqual(['rest']);
  });

  it('throws for a duplicate id', () => {
    expect(() => createFeatureSet([feature('rest'), feature('rest')])).toThrow(
      'createFeatureSet: duplicate feature "rest"',
    );
  });

  it('throws for a requires cycle, naming the path', () => {
    expect(() =>
      createFeatureSet([
        feature('a', { requires: ['b'] }),
        feature('b', { requires: ['c'] }),
        feature('c', { requires: ['a'] }),
      ]),
    ).toThrow('createFeatureSet: "requires" cycle: a -> b -> c -> a');
    expect(() => createFeatureSet([feature('self', { requires: ['self'] })])).toThrow('self -> self');
  });

  it('keeps the descriptors in the order given', () => {
    const set = createFeatureSet([feature('soap'), feature('rest'), feature('scripts')]);
    expect(set.descriptors.map((descriptor) => descriptor.id)).toEqual(['soap', 'rest', 'scripts']);
  });
});

describe('resolveFeatures', () => {
  const descriptors = [
    feature('rest'),
    feature('grpc'),
    feature('beta', { default: false, stage: 'experimental' }),
    feature('webhooks', { requires: ['rest'] }),
  ];

  it('gives every descriptor its default with no levels', () => {
    const { switches, states } = resolveFeatures(descriptors);
    expect(switches).toEqual({ rest: true, grpc: true, beta: false, webhooks: true });
    expect(states.map((state) => [state.id, state.enabled])).toEqual([
      ['rest', true],
      ['grpc', true],
      ['beta', false],
      ['webhooks', true],
    ]);
    expect(states.find((state) => state.id === 'beta')?.reason).toEqual({ by: 'default' });
    expect(states.find((state) => state.id === 'rest')?.reason).toBeUndefined();
  });

  it('lets the preference override the default, both ways, and says so', () => {
    const { states } = resolveFeatures(descriptors, { preference: { grpc: false, beta: true } });
    const grpc = states.find((state) => state.id === 'grpc')!;
    expect(grpc).toMatchObject({ enabled: false, preference: false, policy: false, reason: { by: 'preference' } });
    expect(states.find((state) => state.id === 'beta')).toMatchObject({ enabled: true, preference: true });
  });

  it('lets the policy win over a preference, and never turns anything on', () => {
    const { switches, states } = resolveFeatures(descriptors, {
      policy: ['grpc', 'beta'],
      preference: { grpc: true, beta: true },
    });
    expect(switches['grpc']).toBe(false);
    expect(switches['beta']).toBe(false);
    const grpc = states.find((state) => state.id === 'grpc')!;
    expect(grpc).toMatchObject({ enabled: false, preference: true, policy: true, reason: { by: 'policy' } });
  });

  it('turns a feature off through requires whatever its own levels said', () => {
    const { states } = resolveFeatures(descriptors, { policy: ['rest'], preference: { webhooks: true } });
    expect(states.find((state) => state.id === 'webhooks')).toMatchObject({
      enabled: false,
      preference: true,
      policy: false,
      reason: { by: 'requires', feature: 'rest' },
    });
  });

  it('ignores an id no descriptor has, at both levels', () => {
    const { switches, states } = resolveFeatures(descriptors, {
      policy: ['graphql'],
      preference: { plugin: false, constructor: false },
    });
    expect(Object.keys(switches)).toEqual(['rest', 'grpc', 'beta', 'webhooks']);
    expect(states).toHaveLength(4);
  });
});
