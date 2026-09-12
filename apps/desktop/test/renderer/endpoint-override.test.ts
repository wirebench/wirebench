import { describe, expect, it } from 'vitest';
import { effectiveEndpointSource, resolveEndpointOverride } from '../../src/renderer/state/endpoint-override.js';

describe('resolveEndpointOverride', () => {
  it('prefers the linked project override over the workspace override', () => {
    expect(resolveEndpointOverride({ projectOverride: 'http://p', workspaceOverride: 'http://w' })).toEqual({
      url: 'http://p',
      source: 'project',
    });
  });

  it('falls back to the workspace override when there is no project override', () => {
    expect(resolveEndpointOverride({ workspaceOverride: 'http://w' })).toEqual({
      url: 'http://w',
      source: 'workspace',
    });
  });

  it('answers undefined when neither layer has an override', () => {
    expect(resolveEndpointOverride({})).toBeUndefined();
  });
});

describe('effectiveEndpointSource', () => {
  it('labels each layer that wins, falling through to the interface default and then none', () => {
    expect(
      effectiveEndpointSource({
        projectOverride: 'http://p',
        workspaceOverride: 'http://w',
        interfaceDefault: 'http://i',
      }),
    ).toBe('project');
    expect(effectiveEndpointSource({ workspaceOverride: 'http://w', interfaceDefault: 'http://i' })).toBe('workspace');
    expect(effectiveEndpointSource({ interfaceDefault: 'http://i' })).toBe('interface');
    expect(effectiveEndpointSource({})).toBe('none');
  });
});
