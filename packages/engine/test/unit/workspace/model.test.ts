import { describe, expect, it } from 'vitest';
import { createWorkspace, createWorkspaceEnvironment, WORKSPACE_FORMAT_VERSION } from '../../../src/workspace/model.js';

describe('createWorkspace', () => {
  it('builds an empty workspace with defaults from the injected id/now', () => {
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const workspace = createWorkspace('Demo', { newId: () => 'WID', now });

    expect(workspace).toEqual({
      formatVersion: WORKSPACE_FORMAT_VERSION,
      id: 'WID',
      name: 'Demo',
      createdAt: '2026-01-01T00:00:00.000Z',
      properties: {},
      projects: [],
      environments: [],
    });
  });

  it('honours an explicit id option over the injected generator', () => {
    const workspace = createWorkspace('Demo', {
      id: 'EXPLICIT',
      newId: () => 'FROM-GENERATOR',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(workspace.id).toBe('EXPLICIT');
  });

  it('defaults now to the real clock and id to generateId when no options are given', () => {
    const before = Date.now();
    const workspace = createWorkspace('Demo');
    const after = Date.now();

    expect(typeof workspace.id).toBe('string');
    expect(workspace.id.length).toBeGreaterThan(0);
    const createdAtMs = new Date(workspace.createdAt).getTime();
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });
});

describe('createWorkspaceEnvironment', () => {
  it('slugs through uniqueSlug, defaults order to taken.size, uses the injected id', () => {
    const taken = new Set(['dev', 'staging']);
    const env = createWorkspaceEnvironment('Prod', taken, { newId: () => 'ENV-ID' });

    expect(env).toEqual({
      id: 'ENV-ID',
      name: 'Prod',
      slug: 'Prod',
      order: 2,
      properties: {},
      endpoints: {},
    });
  });

  it('appends a -N suffix on a case-insensitive slug collision', () => {
    const taken = new Set(['dev']);
    const env = createWorkspaceEnvironment('Dev', taken, { newId: () => 'ENV-ID' });
    expect(env.slug).toBe('Dev-2');
  });

  it('honours an explicit order option over taken.size', () => {
    const taken = new Set(['dev', 'staging']);
    const env = createWorkspaceEnvironment('Prod', taken, { newId: () => 'ENV-ID', order: 0 });
    expect(env.order).toBe(0);
  });

  it('honours an explicit id option', () => {
    const env = createWorkspaceEnvironment('Prod', new Set(), { id: 'EXPLICIT' });
    expect(env.id).toBe('EXPLICIT');
  });

  it('defaults order to 0 and generates an id when taken is empty and no options are given', () => {
    const env = createWorkspaceEnvironment('Dev', new Set());
    expect(env.order).toBe(0);
    expect(typeof env.id).toBe('string');
    expect(env.id.length).toBeGreaterThan(0);
  });
});
