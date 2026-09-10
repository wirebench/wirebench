import { describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import {
  toWssIncomingConfig,
  toWssIncomingRef,
  toWssOutgoingConfig,
  toWssOutgoingRef,
} from '../../../src/project/wss-configs.js';
import type { WssRef } from '../../../src/project/model.js';
import type { WssOutgoingConfig } from '../../../src/wss/model.js';

const ref: WssRef = {
  id: 'w1',
  name: 'Gateway',
  file: 'wss/outgoing/w1.yaml',
  document: {
    id: 'w1',
    name: 'Gateway',
    actor: 'gw',
    mustUnderstand: true,
    defaultPasswordRef: 'secret:pw',
    entries: [
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      { kind: 'username-token', username: 'bob', passwordType: 'digest', addNonce: true, addCreated: true },
    ],
    futureField: 'kept',
  },
};

describe('toWssOutgoingConfig', () => {
  it('reads a stored configuration', () => {
    const config = toWssOutgoingConfig(ref);
    expect(config).toMatchObject({ id: 'w1', name: 'Gateway', actor: 'gw', mustUnderstand: true });
    expect(config.entries).toHaveLength(2);
  });

  it('defaults mustUnderstand and entries', () => {
    const config = toWssOutgoingConfig({ id: 'w2', name: 'Bare', document: { id: 'w2', name: 'Bare' } });
    expect(config.mustUnderstand).toBe(false);
    expect(config.entries).toEqual([]);
  });

  it('rejects a document that is not an outgoing configuration', () => {
    expect(() => toWssOutgoingConfig({ id: 'x', name: 'x', document: { name: 'x' } })).toThrow(ProjectError);
  });

  it('rejects a plaintext password on a username token', () => {
    expect(() =>
      toWssOutgoingConfig({
        id: 'x',
        name: 'x',
        document: {
          id: 'x',
          name: 'x',
          entries: [
            {
              kind: 'username-token',
              username: 'bob',
              password: 'nope',
              passwordType: 'text',
              addNonce: false,
              addCreated: false,
            },
          ],
        },
      }),
    ).toThrow(ProjectError);
  });
});

describe('toWssOutgoingRef', () => {
  it('round-trips, preserving unknown fields and dropping cleared ones', () => {
    const stored = toWssOutgoingConfig(ref);
    const withoutActor: WssOutgoingConfig = { ...stored, name: 'Renamed' };
    delete (withoutActor as { actor?: string }).actor;
    const updated = toWssOutgoingRef(withoutActor, ref);
    expect(updated.document['futureField']).toBe('kept');
    expect(updated.document['actor']).toBeUndefined();
    expect(updated.name).toBe('Renamed');
    expect(updated.file).toBe('wss/outgoing/w1.yaml');
    expect(toWssOutgoingConfig(updated).entries).toHaveLength(2);
  });
});

describe('incoming configurations', () => {
  it('round-trips', () => {
    const incoming = { id: 'i1', name: 'In', decryptKeystoreRef: 'k1' } as const;
    const stored = toWssIncomingRef(incoming);
    expect(toWssIncomingConfig(stored)).toEqual(incoming);
    const cleared = toWssIncomingRef({ id: 'i1', name: 'In' }, stored);
    expect(cleared.document['decryptKeystoreRef']).toBeUndefined();
  });

  it('rejects a document that is not an incoming configuration', () => {
    expect(() => toWssIncomingConfig({ id: 'x', name: 'x', document: {} })).toThrow(ProjectError);
  });
});
