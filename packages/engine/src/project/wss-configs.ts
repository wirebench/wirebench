/**
 * The bridge between the project model's loose `WssRef` (which round-trips a
 * `wss/{outgoing,incoming}/<id>.yaml` document verbatim, so a field written by a later build
 * survives) and the typed configurations the WS-Security code takes — the same shape as
 * `project/keystores.ts` does for the keystore registry.
 */

import { ProjectError } from '../errors.js';
import { wssEntrySchema, wssIncomingFileSchema, wssOutgoingFileSchema } from './schema.js';
import type { WssRef } from './model.js';
import { DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS } from '../wss/model.js';
import type { WssEntry, WssIncomingConfig, WssOutgoingConfig } from '../wss/model.js';

/**
 * One stored entry as a typed {@link WssEntry}. An entry this build does not understand (a
 * signature written by a later build, say) is carried through verbatim rather than dropped;
 * applying it then fails loudly with `wss-entry-unsupported` instead of silently doing nothing.
 */
function toWssEntry(entry: Record<string, unknown>): WssEntry {
  const parsed = wssEntrySchema.safeParse(entry);
  if (parsed.success) {
    return parsed.data as WssEntry;
  }
  const kind = entry['kind'];
  return { ...entry, kind: typeof kind === 'string' ? kind : 'unknown' } as WssEntry;
}

/**
 * Reads one outgoing configuration out of its `WssRef`.
 *
 * @param ref the `Project.wss.outgoing` entry
 * @returns the typed configuration
 * @throws ProjectError `wss-config-invalid` when the stored document is not one
 */
export function toWssOutgoingConfig(ref: WssRef): WssOutgoingConfig {
  const parsed = wssOutgoingFileSchema.safeParse(ref.document);
  if (!parsed.success) {
    throw new ProjectError('wss-config-invalid', `Outgoing WS-Security configuration "${ref.name}" is invalid.`, {
      details: { id: ref.id, issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }
  const document = parsed.data;
  return {
    id: document.id,
    name: document.name,
    ...(document.defaultAlias !== undefined ? { defaultAlias: document.defaultAlias } : {}),
    ...(document.defaultPasswordRef !== undefined ? { defaultPasswordRef: document.defaultPasswordRef } : {}),
    ...(document.actor !== undefined ? { actor: document.actor } : {}),
    mustUnderstand: document.mustUnderstand ?? false,
    entries: (document.entries ?? []).map(toWssEntry),
  };
}

/**
 * The `WssRef` that stores `config`, preserving any unknown fields the existing document had.
 *
 * @param config the configuration to persist
 * @param existing the ref being replaced, when this is an update
 * @returns the ref to put into `Project.wss.outgoing`
 */
export function toWssOutgoingRef(config: WssOutgoingConfig, existing?: WssRef): WssRef {
  const document: Record<string, unknown> = { ...existing?.document };
  document['id'] = config.id;
  document['name'] = config.name;
  document['mustUnderstand'] = config.mustUnderstand;
  document['entries'] = config.entries;
  for (const [key, value] of [
    ['defaultAlias', config.defaultAlias],
    ['defaultPasswordRef', config.defaultPasswordRef],
    ['actor', config.actor],
  ] as const) {
    if (value === undefined) {
      delete document[key];
    } else {
      document[key] = value;
    }
  }
  return {
    id: config.id,
    name: config.name,
    ...(existing?.file !== undefined ? { file: existing.file } : {}),
    document,
  };
}

/**
 * Reads one incoming configuration out of its `WssRef`.
 *
 * @param ref the `Project.wss.incoming` entry
 * @returns the typed configuration
 * @throws ProjectError `wss-config-invalid` when the stored document is not one
 */
export function toWssIncomingConfig(ref: WssRef): WssIncomingConfig {
  const parsed = wssIncomingFileSchema.safeParse(ref.document);
  if (!parsed.success) {
    throw new ProjectError('wss-config-invalid', `Incoming WS-Security configuration "${ref.name}" is invalid.`, {
      details: { id: ref.id },
    });
  }
  const document = parsed.data;
  return {
    id: document.id,
    name: document.name,
    ...(document.decryptKeystoreRef !== undefined ? { decryptKeystoreRef: document.decryptKeystoreRef } : {}),
    ...(document.decryptAlias !== undefined ? { decryptAlias: document.decryptAlias } : {}),
    ...(document.decryptKeyPasswordRef !== undefined ? { decryptKeyPasswordRef: document.decryptKeyPasswordRef } : {}),
    ...(document.signatureKeystoreRef !== undefined ? { signatureKeystoreRef: document.signatureKeystoreRef } : {}),
    requireSignature: document.requireSignature ?? false,
    requireTimestamp: document.requireTimestamp ?? false,
    timestampSkewSeconds: document.timestampSkewSeconds ?? DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
    verifyChain: document.verifyChain ?? true,
  };
}

/**
 * The `WssRef` that stores `config`, preserving any unknown fields the existing document had.
 *
 * @param config the configuration to persist
 * @param existing the ref being replaced, when this is an update
 * @returns the ref to put into `Project.wss.incoming`
 */
export function toWssIncomingRef(config: WssIncomingConfig, existing?: WssRef): WssRef {
  const document: Record<string, unknown> = { ...existing?.document };
  document['id'] = config.id;
  document['name'] = config.name;
  document['requireSignature'] = config.requireSignature;
  document['requireTimestamp'] = config.requireTimestamp;
  document['timestampSkewSeconds'] = config.timestampSkewSeconds;
  document['verifyChain'] = config.verifyChain;
  for (const [key, value] of [
    ['decryptKeystoreRef', config.decryptKeystoreRef],
    ['decryptAlias', config.decryptAlias],
    ['decryptKeyPasswordRef', config.decryptKeyPasswordRef],
    ['signatureKeystoreRef', config.signatureKeystoreRef],
  ] as const) {
    if (value === undefined) {
      delete document[key];
    } else {
      document[key] = value;
    }
  }
  return {
    id: config.id,
    name: config.name,
    ...(existing?.file !== undefined ? { file: existing.file } : {}),
    document,
  };
}
