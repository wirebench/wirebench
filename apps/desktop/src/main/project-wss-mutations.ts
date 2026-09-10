/**
 * Pure reducers for the three outgoing WS-Security {@link ProjectChange} variants, split out of
 * `project-mutations.ts` exactly as the keystore ones are. Same contract: never mutates its
 * input, and validates ids up front so a stale renderer mirror surfaces as
 * `ProjectError('not-found')` rather than a silent no-op.
 */

import { generateId, ProjectError, toWssOutgoingConfig, toWssOutgoingRef } from '@wirebench/engine';
import type { Project, WssEntry, WssOutgoingConfig, WssRef } from '@wirebench/engine';
import type { WssOutgoingPatchWire } from '../shared/wire-types.js';

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
