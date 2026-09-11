/**
 * Pure reducers for the six WS-Security {@link ProjectChange} variants (three outgoing, three
 * incoming), split out of
 * `project-mutations.ts` exactly as the keystore ones are. Same contract: never mutates its
 * input, and validates ids up front so a stale renderer mirror surfaces as
 * `ProjectError('not-found')` rather than a silent no-op.
 */

import {
  DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
  generateId,
  ProjectError,
  toWssIncomingConfig,
  toWssIncomingRef,
  toWssOutgoingConfig,
  toWssOutgoingRef,
} from '@wirebench/engine';
import type { Project, WssEntry, WssIncomingConfig, WssOutgoingConfig, WssRef } from '@wirebench/engine';
import type { WssIncomingPatchWire, WssOutgoingPatchWire } from '../shared/wire-types.js';

function notFound(configId: string): never {
  throw new ProjectError('not-found', `No outgoing WS-Security configuration with id "${configId}"`, {
    details: { id: configId },
  });
}

function requireConfig(project: Project, configId: string): WssRef {
  return project.wss.outgoing.find((candidate) => candidate.id === configId) ?? notFound(configId);
}

function withOutgoing(project: Project, outgoing: readonly WssRef[]): Project {
  return { ...project, wss: { ...project.wss, outgoing } };
}

/** The default name of the nth configuration: "Outgoing WSS", "Outgoing WSS 2", … */
function defaultName(project: Project): string {
  const taken = new Set(project.wss.outgoing.map((ref) => ref.name));
  const base = 'Outgoing WSS';
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${String(index)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Creates an empty outgoing configuration. The file it will be saved to is fixed here — by id,
 * not by name — so renaming one never orphans (or overwrites) a file.
 *
 * @param project the open project
 * @param input an optional name; the default is derived from the existing ones
 * @returns the new project and the id of the configuration created
 */
export function addWssOutgoing(
  project: Project,
  input: { readonly name?: string },
): { project: Project; configId: string } {
  const name = input.name?.trim();
  const config: WssOutgoingConfig = {
    id: generateId(),
    name: name !== undefined && name.length > 0 ? name : defaultName(project),
    mustUnderstand: false,
    entries: [],
  };
  const ref: WssRef = { ...toWssOutgoingRef(config), file: `wss/outgoing/${config.id}.yaml` };
  return { project: withOutgoing(project, [...project.wss.outgoing, ref]), configId: config.id };
}

/** Applies a patch to one configuration; `null` clears an optional field, `entries` replaces the list. */
export function updateWssOutgoing(project: Project, configId: string, patch: WssOutgoingPatchWire): Project {
  const existing = requireConfig(project, configId);
  const current = toWssOutgoingConfig(existing);
  const name = patch.name?.trim();
  const optional = (
    key: 'defaultAlias' | 'defaultPasswordRef' | 'actor',
  ): Partial<Pick<WssOutgoingConfig, 'defaultAlias' | 'defaultPasswordRef' | 'actor'>> => {
    const patched = patch[key];
    const value = patched === undefined ? current[key] : patched;
    return value === null || value === undefined || value === '' ? {} : { [key]: value };
  };
  const next: WssOutgoingConfig = {
    id: current.id,
    name: name !== undefined && name.length > 0 ? name : current.name,
    ...optional('defaultAlias'),
    ...optional('defaultPasswordRef'),
    ...optional('actor'),
    mustUnderstand: patch.mustUnderstand ?? current.mustUnderstand,
    entries: (patch.entries as readonly WssEntry[] | undefined) ?? current.entries,
  };
  const ref = toWssOutgoingRef(next, existing);
  return withOutgoing(
    project,
    project.wss.outgoing.map((candidate) => (candidate.id === configId ? ref : candidate)),
  );
}

/**
 * Removes a configuration, and clears `wssOutgoingRef` on every request that selected it — a
 * request left holding a dangling id would fail its next send instead of simply going out
 * without a security header.
 */
export function removeWssOutgoing(project: Project, configId: string): Project {
  requireConfig(project, configId);
  const interfaces = project.interfaces.map((iface) => ({
    ...iface,
    operations: iface.operations.map((operation) => ({
      ...operation,
      requests: operation.requests.map((request) => {
        if (request.wssOutgoingRef !== configId) {
          return request;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
        const { wssOutgoingRef: dropped, ...rest } = request;
        return rest;
      }),
    })),
  }));
  return withOutgoing(
    { ...project, interfaces },
    project.wss.outgoing.filter((candidate) => candidate.id !== configId),
  );
}

/* -------------------------------------------------------------------------- *
 * Incoming configurations — the same three reducers, against `project.wss.incoming`.
 * -------------------------------------------------------------------------- */

function notFoundIncoming(configId: string): never {
  throw new ProjectError('not-found', `No incoming WS-Security configuration with id "${configId}"`, {
    details: { id: configId },
  });
}

function requireIncoming(project: Project, configId: string): WssRef {
  return project.wss.incoming.find((candidate) => candidate.id === configId) ?? notFoundIncoming(configId);
}

function withIncoming(project: Project, incoming: readonly WssRef[]): Project {
  return { ...project, wss: { ...project.wss, incoming } };
}

/** The default name of the nth incoming configuration: "Incoming WSS", "Incoming WSS 2", … */
function defaultIncomingName(project: Project): string {
  const taken = new Set(project.wss.incoming.map((ref) => ref.name));
  const base = 'Incoming WSS';
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${String(index)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * Creates an incoming configuration with this build's defaults (verify chains, tolerate five
 * minutes of skew, require nothing). Its file is fixed by id, as the outgoing one's is.
 *
 * @param project the open project
 * @param input an optional name; the default is derived from the existing ones
 * @returns the new project and the id of the configuration created
 */
export function addWssIncoming(
  project: Project,
  input: { readonly name?: string },
): { project: Project; configId: string } {
  const name = input.name?.trim();
  const config: WssIncomingConfig = {
    id: generateId(),
    name: name !== undefined && name.length > 0 ? name : defaultIncomingName(project),
    requireSignature: false,
    requireTimestamp: false,
    timestampSkewSeconds: DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS,
    verifyChain: true,
  };
  const ref: WssRef = { ...toWssIncomingRef(config), file: `wss/incoming/${config.id}.yaml` };
  return { project: withIncoming(project, [...project.wss.incoming, ref]), configId: config.id };
}

/** Applies a patch to one incoming configuration; `null` (or `''`) clears an optional field. */
export function updateWssIncoming(project: Project, configId: string, patch: WssIncomingPatchWire): Project {
  const existing = requireIncoming(project, configId);
  const current = toWssIncomingConfig(existing);
  const name = patch.name?.trim();
  const optional = (
    key: 'decryptKeystoreRef' | 'decryptAlias' | 'decryptKeyPasswordRef' | 'signatureKeystoreRef',
  ): Partial<WssIncomingConfig> => {
    const patched = patch[key];
    const value = patched === undefined ? current[key] : patched;
    return value === null || value === undefined || value === '' ? {} : { [key]: value };
  };
  const next: WssIncomingConfig = {
    id: current.id,
    name: name !== undefined && name.length > 0 ? name : current.name,
    ...optional('decryptKeystoreRef'),
    ...optional('decryptAlias'),
    ...optional('decryptKeyPasswordRef'),
    ...optional('signatureKeystoreRef'),
    requireSignature: patch.requireSignature ?? current.requireSignature,
    requireTimestamp: patch.requireTimestamp ?? current.requireTimestamp,
    timestampSkewSeconds: patch.timestampSkewSeconds ?? current.timestampSkewSeconds,
    verifyChain: patch.verifyChain ?? current.verifyChain,
  };
  const ref = toWssIncomingRef(next, existing);
  return withIncoming(
    project,
    project.wss.incoming.map((candidate) => (candidate.id === configId ? ref : candidate)),
  );
}

/**
 * Removes an incoming configuration, and clears `wssIncomingRef` on every request that
 * selected it — the same reason the outgoing one does: a dangling id would fail the next send
 * rather than simply stop verifying.
 */
export function removeWssIncoming(project: Project, configId: string): Project {
  requireIncoming(project, configId);
  const interfaces = project.interfaces.map((iface) => ({
    ...iface,
    operations: iface.operations.map((operation) => ({
      ...operation,
      requests: operation.requests.map((request) => {
        if (request.wssIncomingRef !== configId) {
          return request;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
        const { wssIncomingRef: dropped, ...rest } = request;
        return rest;
      }),
    })),
  }));
  return withIncoming(
    { ...project, interfaces },
    project.wss.incoming.filter((candidate) => candidate.id !== configId),
  );
}
