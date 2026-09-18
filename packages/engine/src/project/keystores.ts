/**
 * The bridge between the project model's loose `WssRef` (which round-trips the raw
 * `wss/keystores.yaml` entry verbatim, so an unknown field written by a later build survives)
 * and the typed `KeystoreDef` the keystore loaders take.
 */

import { ProjectError } from '../errors.js';
import { keystoreEntrySchema } from './schema.js';
import type { WssRef } from './model.js';
import type { KeystoreDef } from '../wss/keystore/model.js';

/**
 * Reads one keystore registry entry out of its `WssRef`.
 *
 * @param ref the `Project.wss.keystores` entry
 * @returns the typed definition
 * @throws ProjectError `keystore-entry-invalid` when the stored document is not a keystore entry
 */
export function toKeystoreDef(ref: WssRef): KeystoreDef {
  const parsed = keystoreEntrySchema.safeParse(ref.document);
  if (!parsed.success) {
    throw new ProjectError('keystore-entry-invalid', `Keystore "${ref.name}" is missing a path or type.`, {
      details: { id: ref.id },
    });
  }
  const entry = parsed.data;
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    type: entry.type,
    ...(entry.passwordSecretRef !== undefined ? { passwordSecretRef: entry.passwordSecretRef } : {}),
    ...(entry.passwordEnv !== undefined ? { passwordEnv: entry.passwordEnv } : {}),
    ...(entry.defaultAlias !== undefined ? { defaultAlias: entry.defaultAlias } : {}),
  };
}

/**
 * The `WssRef` that stores `def` in `wss/keystores.yaml`, preserving any unknown fields the
 * existing entry carried.
 *
 * @param def the definition to persist
 * @param existing the entry being replaced, when this is an update
 * @returns the ref to put into `Project.wss.keystores`
 */
export function toKeystoreRef(def: KeystoreDef, existing?: WssRef): WssRef {
  const document: Record<string, unknown> = { ...existing?.document };
  document['id'] = def.id;
  document['name'] = def.name;
  document['path'] = def.path;
  document['type'] = def.type;
  if (def.passwordSecretRef === undefined) {
    delete document['passwordSecretRef'];
  } else {
    document['passwordSecretRef'] = def.passwordSecretRef;
  }
  if (def.passwordEnv === undefined) {
    delete document['passwordEnv'];
  } else {
    document['passwordEnv'] = def.passwordEnv;
  }
  if (def.defaultAlias === undefined) {
    delete document['defaultAlias'];
  } else {
    document['defaultAlias'] = def.defaultAlias;
  }
  return { id: def.id, name: def.name, document };
}
