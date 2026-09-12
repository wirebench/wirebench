/**
 * Turns a {@link Project} into the exact set of files it occupies on disk.
 *
 * Keeping this pure (project in, `relative path -> file content` out) means the
 * saver only has to diff two maps, and tests can assert on the layout without
 * touching a file system.
 */

import type { Interface, Project, PropertyMap, RequestDef, WssRef } from './model.js';
import {
  assertPathSegment,
  assertWssRelativePath,
  ENVIRONMENTS_DIR,
  INTERFACES_DIR,
  OPERATIONS_DIR,
  REQUEST_SUFFIX,
  WSS_DIR,
  slugify,
} from './paths.js';
import { compact, stringifyYaml } from './yaml.js';

/** A project's files, keyed by path relative to the project root (always `/`-separated). */
export type ProjectFiles = ReadonlyMap<string, string>;

/** Relative path of the manifest. */
export const MANIFEST_PATH = 'wirebench.yaml';

/** Relative path of the keystore registry. */
export const KEYSTORES_PATH = `${WSS_DIR}/keystores.yaml`;

/**
 * The `disabled` list as written: sorted, deduplicated, and dropped entirely once it would be
 * empty — a name with no entry left in `properties` never outlives its map, so it is filtered
 * out here rather than merely sorted.
 */
function disabledList(disabled: readonly string[], properties: PropertyMap): readonly string[] | undefined {
  const known = new Set(Object.keys(properties));
  const kept = [...new Set(disabled.filter((name) => known.has(name)))].sort();
  return kept.length > 0 ? kept : undefined;
}

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
    orphaned: request.orphaned === true ? true : undefined,
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
    wsa: compact({ ...iface.wsa }),
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
  return stringifyYaml(ref.document);
}

/**
 * Relative path of a WS-Security configuration file.
 *
 * @throws ProjectError `project-path-invalid` when `ref.file` is not a
 * relative path rooted at `wss/` with only safe segments.
 */
export function wssRefPath(direction: 'outgoing' | 'incoming', ref: WssRef): string {
  if (ref.file !== undefined) {
    assertWssRelativePath(ref.file);
    return ref.file;
  }
  return `${WSS_DIR}/${direction}/${slugify(ref.name)}.yaml`;
}

/** Options for {@link projectFiles}. */
export interface ProjectFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
}

/**
 * Builds the complete `relative path -> content` map for a project.
 *
 * Every slug is validated with {@link assertPathSegment} (and every
 * `WssRef.file` with {@link assertWssRelativePath}) before any path is built,
 * so a corrupted slug or an unvalidated file reference throws
 * `ProjectError('project-path-invalid')` here — before `saveProject` ever
 * touches the file system.
 */
export function projectFiles(project: Project, options?: ProjectFilesOptions): ProjectFiles {
  const files = new Map<string, string>();
  const writer = options?.writer ?? 'wirebench';

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
        disabled: disabledList(project.disabledProperties, project.properties),
        activeEnvironmentId: project.activeEnvironmentId,
        writtenBy: writer,
      }),
    ),
  );

  for (const environment of project.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml(
        compact({
          id: environment.id,
          name: environment.name,
          order: environment.order,
          endpoints: { ...environment.endpoints },
          properties: { ...environment.properties },
          disabled: disabledList(environment.disabledProperties, environment.properties),
        }),
      ),
    );
  }

  for (const iface of project.interfaces) {
    assertPathSegment(iface.slug);
    const base = `${INTERFACES_DIR}/${iface.slug}`;
    files.set(`${base}/interface.yaml`, stringifyYaml(interfaceDocument(iface)));
    for (const operation of iface.operations) {
      assertPathSegment(operation.slug);
      const dir = `${base}/${OPERATIONS_DIR}/${operation.slug}`;
      for (const request of operation.requests) {
        assertPathSegment(request.slug);
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
    files.set(KEYSTORES_PATH, stringifyYaml({ keystores: project.wss.keystores.map((k) => k.document) }));
  }

  return files;
}
