// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HeldChanges } from '../../src/main/sync/held-changes.js';

describe('HeldChanges', () => {
  it('passes everything through while not holding', () => {
    const held = new HeldChanges();
    expect(held.offerWorkspace(['workspace.yaml'])).toBe(false);
    expect(held.offerProject('p1', ['wirebench.yaml'])).toBe(false);
    expect(held.setHolding(false)).toBeUndefined();
  });

  it('buffers per key while holding, unions paths, and drains once on release', () => {
    const held = new HeldChanges();
    expect(held.setHolding(true)).toBeUndefined();
    expect(held.offerWorkspace(['environments/dev.yaml'])).toBe(true);
    expect(held.offerWorkspace(['environments/dev.yaml', 'workspace.yaml'])).toBe(true);
    expect(held.offerProject('p1', ['a.yaml'])).toBe(true);
    expect(held.offerProject('p1', ['b.yaml', 'a.yaml'])).toBe(true);
    expect(held.offerProject('p2', ['c.yaml'])).toBe(true);

    // Staying held drains nothing.
    expect(held.setHolding(true)).toBeUndefined();

    const batch = held.setHolding(false);
    expect(batch?.workspacePaths).toEqual(['environments/dev.yaml', 'workspace.yaml']);
    expect([...(batch?.projects.entries() ?? [])]).toEqual([
      ['p1', ['a.yaml', 'b.yaml']],
      ['p2', ['c.yaml']],
    ]);
    expect(held.setHolding(false)).toBeUndefined();
    expect(held.offerWorkspace(['workspace.yaml'])).toBe(false);
  });

  it('releasing with nothing buffered yields no batch', () => {
    const held = new HeldChanges();
    held.setHolding(true);
    expect(held.setHolding(false)).toBeUndefined();
  });

  it('forget() drops paths a pull already applied, and empty keys with them', () => {
    const held = new HeldChanges();
    held.setHolding(true);
    held.offerWorkspace(['environments/dev.yaml', 'workspace.yaml']);
    held.offerProject('p1', ['a.yaml']);
    held.offerProject('p2', ['c.yaml', 'd.yaml']);

    held.forget(
      ['environments/dev.yaml'],
      new Map([
        ['p1', ['a.yaml']],
        ['p2', ['c.yaml']],
      ]),
    );

    const batch = held.setHolding(false);
    expect(batch?.workspacePaths).toEqual(['workspace.yaml']);
    expect([...(batch?.projects.entries() ?? [])]).toEqual([['p2', ['d.yaml']]]);
  });

  it('clear() drops everything and stops holding', () => {
    const held = new HeldChanges();
    held.setHolding(true);
    held.offerWorkspace(['workspace.yaml']);
    held.clear();
    expect(held.offerWorkspace(['workspace.yaml'])).toBe(false);
    expect(held.setHolding(false)).toBeUndefined();
  });
});
