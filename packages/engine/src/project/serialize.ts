/**
 * Turns a {@link Project} into the exact set of files it occupies on disk.
 *
 * Keeping this pure (project in, `relative path -> file content` out) means the
 * saver only has to diff two maps, and tests can assert on the layout without
 * touching a file system.
 */

import type { Interface, Project, RequestDef, WssRef } from './model.js';
import { ENVIRONMENTS_DIR, INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX, WSS_DIR, slugify } from './paths.js';
import { compact, stringifyYaml } from './yaml.js';

/** A project's files, keyed by path relative to the project root (always `/`-separated). */
export type ProjectFiles = ReadonlyMap<string, string>;

/** Relative path of the manifest. */
export const MANIFEST_PATH = 'wirebench.yaml';

/** Relative path of the keystore registry. */
export const KEYSTORES_PATH = `${WSS_DIR}/keystores.yaml`;

function requestDocument(request: RequestDef): Record<string, unknown> {
  return compact({
    kind: request.kind,
    id: request.id,
    name: request.name,
    order: request.order,
    description: request.description,
    endpointId: request.endpointId,
    endpointUrl: request.endpointUrl,
    soapVersion: request.soapVersion,
    soapAction: request.soapAction,
    headers: request.headers.map((h) => ({ name: h.name, value: h.value })),
    attachments: request.attachments.map((a) => compact({ ...a })),
    auth: request.auth === undefined ? undefined : compact({ ...request.auth }),
    wsa: request.wsa === undefined ? undefined : compact({ ...request.wsa }),
    wssOutgoingRef: request.wssOutgoingRef,
    wssIncomingRef: request.wssIncomingRef,
    properties: compact({ ...request.properties }),
  });
}

function interfaceDocument(iface: Interface): Record<string, unknown> {
  return compact({
    kind: iface.kind,
    id: iface.id,
    name: iface.name,
    order: iface.order,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    targetNamespace: iface.targetNamespace,
    endpoints: iface.endpoints.map((e) =>
      compact({ ...e, auth: e.auth === undefined ? undefined : compact({ ...e.auth }) }),
    ),
    defaultEndpointId: iface.defaultEndpointId,
    wsa: { enabled: iface.wsa.enabled, version: iface.wsa.version },
    auth: iface.auth === undefined ? undefined : compact({ ...iface.auth }),
    operations: iface.operations.map((op) => ({
      name: op.name,
      bindingName: op.bindingName,
      slug: op.slug,
      order: op.order,
    })),
  });
}

function wssDocument(ref: WssRef): string {
  return stringifyYaml({ id: ref.id, name: ref.name });
}

/** Relative path of a WS-Security configuration file. */
export function wssRefPath(direction: 'outgoing' | 'incoming', ref: WssRef): string {
  return ref.file ?? `${WSS_DIR}/${direction}/${slugify(ref.name)}.yaml`;
}

/** Builds the complete `relative path -> content` map for a project. */
export function projectFiles(project: Project): ProjectFiles {
  const files = new Map<string, string>();

  files.set(
    MANIFEST_PATH,
    stringifyYaml(
      compact({
        formatVersion: project.formatVersion,
        id: project.id,
        name: project.name,
        description: project.description,
        settings: compact({ ...project.settings }),
        properties: { ...project.properties },
      }),
    ),
  );

  for (const environment of project.environments) {
    files.set(
      `${ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml({
        id: environment.id,
        name: environment.name,
        order: environment.order,
        endpoints: { ...environment.endpoints },
        properties: { ...environment.properties },
      }),
    );
  }

  for (const iface of project.interfaces) {
    const base = `${INTERFACES_DIR}/${iface.slug}`;
    files.set(`${base}/interface.yaml`, stringifyYaml(interfaceDocument(iface)));
    for (const operation of iface.operations) {
      const dir = `${base}/${OPERATIONS_DIR}/${operation.slug}`;
      for (const request of operation.requests) {
        files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(requestDocument(request)));
        files.set(`${dir}/${request.slug}.xml`, request.envelopeXml);
      }
    }
  }

  for (const [direction, refs] of [
    ['outgoing', project.wss.outgoing],
    ['incoming', project.wss.incoming],
  ] as const) {
    for (const ref of refs) {
      files.set(wssRefPath(direction, ref), wssDocument(ref));
    }
  }
  if (project.wss.keystores.length > 0) {
    files.set(
      KEYSTORES_PATH,
      stringifyYaml({ keystores: project.wss.keystores.map((k) => ({ id: k.id, name: k.name })) }),
    );
  }

  return files;
}
