/**
 * Pure reducers for the three keystore {@link ProjectChange} variants, split out of
 * `project-mutations.ts` the way the environment ones are. Same contract: never mutates its
 * input, and validates ids up front so a stale renderer mirror surfaces as
 * `ProjectError('not-found')` rather than a silent no-op.
 *
 * The *path check* deliberately does not live here — it needs the file system, and reducers
 * stay pure — so `applyChange` runs it (through `MutationDeps.allowsKeystorePath`) before
 * calling `addKeystore`.
 */

import { basename } from 'node:path';
import { generateId, keystoreTypeForPath, ProjectError, toKeystoreDef, toKeystoreRef } from '@wirebench/engine';
import type { KeystoreDef, Project, WssRef } from '@wirebench/engine';
import type { KeystorePatchWire } from '../shared/wire-types.js';

function notFound(keystoreId: string): never {
  throw new ProjectError('not-found', `No keystore with id "${keystoreId}"`, { details: { id: keystoreId } });
}

function requireKeystore(project: Project, keystoreId: string): WssRef {
  return project.wss.keystores.find((candidate) => candidate.id === keystoreId) ?? notFound(keystoreId);
}

function withKeystores(project: Project, keystores: readonly WssRef[]): Project {
  return { ...project, wss: { ...project.wss, keystores } };
}

/** The name a keystore gets when the user did not type one: the file's stem. */
export function keystoreNameFromPath(path: string): string {
  const file = basename(path);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return stem.length > 0 ? stem : file;
}

/**
 * Registers a keystore in `wss/keystores.yaml`. The container format is inferred from the
 * extension once, here, so every later load knows what it is reading without sniffing.
 *
 * @throws ProjectError `keystore-type-unknown` for an extension that is neither PKCS#12 nor PEM
 */
export function addKeystore(
  project: Project,
  input: { readonly path: string; readonly name?: string; readonly passwordSecretRef?: string },
): { project: Project; keystoreId: string } {
  const type = keystoreTypeForPath(input.path);
  if (type === undefined) {
    throw new ProjectError(
      'keystore-type-unknown',
      `"${basename(input.path)}" is not a recognised keystore (.p12, .pfx, .pem, .crt, .cer, .key).`,
      { details: { path: input.path } },
    );
  }
  const name = input.name?.trim();
  const def: KeystoreDef = {
    id: generateId(),
    name: name !== undefined && name.length > 0 ? name : keystoreNameFromPath(input.path),
    path: input.path,
    type,
    ...(input.passwordSecretRef !== undefined ? { passwordSecretRef: input.passwordSecretRef } : {}),
  };
  return {
    project: withKeystores(project, [...project.wss.keystores, toKeystoreRef(def)]),
    keystoreId: def.id,
  };
}

/** Applies a patch to one registry entry; `null` clears the password ref or the default alias. */
export function updateKeystore(project: Project, keystoreId: string, patch: KeystorePatchWire): Project {
  const existing = requireKeystore(project, keystoreId);
  const current = toKeystoreDef(existing);
  const name = patch.name?.trim();
  const passwordSecretRef = patch.passwordSecretRef === undefined ? current.passwordSecretRef : patch.passwordSecretRef;
  const defaultAlias = patch.defaultAlias === undefined ? current.defaultAlias : patch.defaultAlias;
  const next: KeystoreDef = {
    id: current.id,
    name: name !== undefined && name.length > 0 ? name : current.name,
    path: current.path,
    type: current.type,
    ...(passwordSecretRef === null || passwordSecretRef === undefined ? {} : { passwordSecretRef }),
    ...(defaultAlias === null || defaultAlias === undefined ? {} : { defaultAlias }),
  };
  const ref = toKeystoreRef(next, existing);
  return withKeystores(
    project,
    project.wss.keystores.map((candidate) => (candidate.id === keystoreId ? ref : candidate)),
  );
}

/**
 * Removes a registry entry, and clears `sslKeystoreRef` on every request that pointed at it —
 * a request left holding a dangling id would fail its next send with `not-found` instead of
 * simply going out without a client certificate.
 */
export function removeKeystore(project: Project, keystoreId: string): Project {
  requireKeystore(project, keystoreId);
  const interfaces = project.interfaces.map((iface) => ({
    ...iface,
    operations: iface.operations.map((operation) => ({
      ...operation,
      requests: operation.requests.map((request) => {
        if (request.properties.sslKeystoreRef !== keystoreId) {
          return request;
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
        const { sslKeystoreRef: dropped, ...properties } = request.properties;
        return { ...request, properties };
      }),
    })),
  }));
  return withKeystores(
    { ...project, interfaces },
    project.wss.keystores.filter((candidate) => candidate.id !== keystoreId),
  );
}
