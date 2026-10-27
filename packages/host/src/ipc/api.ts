/**
 * The `api.*` channels: importing an OpenAPI document, and reading back the definition it cached.
 *
 * Separate from `definition.*` because the two describe different things. A WSDL bundle is resolved
 * into main's memory and answered from there; an OpenAPI definition is read from its cache on demand,
 * so there is no per-API engine state to keep, and an API whose definition was never cached simply
 * has no documents to show rather than silently re-fetching them.
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  detectImportFolder,
  detectImportFormat,
  detectPluginFormat,
  mapPluginImport,
  formatImportReport,
  HTTP_ENV_FILE,
  HTTP_PRIVATE_ENV_FILE,
  HttpFileError,
  collectionV3Root,
  importBruno,
  importHar,
  importHoppscotch,
  importHoppscotchEnvironments,
  importHttpFile,
  importInsomnia,
  importOpenCollection,
  importThunderClient,
  importPostmanCollection,
  importPostmanVariables,
  loadProtoSet,
  mapCollectionV3,
  MAX_HTTP_FILE_BYTES,
  parseHttpEnvFiles,
  readCollectionV3,
  readCollectionV3Folder,
  readOpenCollectionFile,
  ReportBuilder,
  VariableSetBuilder,
  WirebenchError,
} from '@wirebench/engine';
import type {
  ImporterContribution,
  ImportedVariables,
  DefinitionAuth,
  MappedClientImport,
  MappedOpenCollection,
  OpenApiSource,
} from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { PostmanSourceWire } from '@wirebench/wire/kinds/rest/wire';
import type { DefinitionAuthWire, OpenApiSourceWire } from '@wirebench/wire/wire-base';
import { MAX_DOCUMENT_TEXT_BYTES } from '@wirebench/wire/kinds/soap/wire';
import type { ReadPicks } from '../dialog-picks.js';
import type { NativeDialogs } from '../native-dialogs.js';
import type { OpenApiImportService } from '../openapi-import.js';
import type { ProtoImportService } from '../proto-import.js';
import { checkedCompanionPaths, checkedImportSource, readCompanionFile, readNoFollow } from '../path-access.js';
import { checkedOpenCollectionRoot, readCompanionProtos, readOpenCollectionTree } from '../opencollection-tree.js';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { HistoryService, ImportedHistoryOutcome } from '../history-service.js';
import type { ProjectRouter } from '../project-router.js';
import { applyImportedVariables } from '../import-variables-apply.js';
import { placeMappedImport } from '../import-place.js';
import type { VariablesApplyPorts } from '../import-variables-apply.js';
import { registerHandler, type HandlerTable } from './register.js';

/** What the `api.*` channels need. A stub stands in for each part in tests. */
export interface ApiChannelDeps {
  readonly router: Pick<
    ProjectRouter,
    | 'addApi'
    | 'addGrpcApi'
    | 'importAsyncApi'
    | 'asyncApiSource'
    | 'asyncApiPlanUpdate'
    | 'asyncApiApplyUpdate'
    | 'restSource'
    | 'restPlanUpdate'
    | 'restApplyUpdate'
    | 'restLint'
    | 'webhookItems'
    | 'importWebhooks'
    | 'apiDefinitionDocuments'
    | 'apiDefinitionText'
    | 'exportApiDefinitionTo'
    | 'grpcDefinition'
    | 'grpcFields'
    | 'grpcRefresh'
    | 'grpcSample'
    | 'writeImportedScripts'
    | 'importWsApi'
    | 'importGrpcApi'
  > &
    // Where an imported GraphQL schema is stored (#77); optional so the import-only tests need not stub it.
    Partial<Pick<ProjectRouter, 'setGraphqlSchema' | 'clearGraphqlSchema'>>;
  readonly imports: Pick<OpenApiImportService, 'run' | 'cancel' | 'readOpenApi'>;
  /**
   * The AsyncAPI import runner — the OpenAPI service's `runAsyncApi`, so `api.cancelImport` reaches
   * it through `imports.cancel`. Optional so the OpenAPI-only tests need not build one.
   */
  readonly asyncApiImports?: Pick<OpenApiImportService, 'runAsyncApi' | 'readAsyncApi'>;
  /** The `.proto` import service; optional so the OpenAPI-only tests need not build one. */
  readonly protoImports?: Pick<ProtoImportService, 'run' | 'cancel'>;
  /** Creates a project inside the open workspace; used only by an import that asks for one. */
  readonly addProject: (name: string) => Promise<{ readonly projectId: string }>;
  /** Takes back a project created for an import that then failed, so no empty project is left. */
  readonly removeProject: (projectId: string, options: { deleteFiles: boolean }) => Promise<unknown>;
  /** The folders of every project open in the workspace, for the `file`-path containment check. */
  readonly projectDirs: () => readonly string[];
  /** The session's dialog memory: proof a `file` source was picked by the user, not named. */
  readonly picks: ReadPicks;
  /** The folder picker Export Definition runs. */
  readonly dialogs: Pick<NativeDialogs, 'pickFolder'>;
  /**
   * Where imported variables are saved: the open workspace, Globals and the secret store, plus the
   * project with `projectId` when one is given (a collection's variables become its properties).
   */
  readonly variablesPorts: (projectId: string | undefined) => VariablesApplyPorts;
  /** Where a HAR import's recorded exchanges are written, when it asks for them in History. */
  readonly history: Pick<HistoryService, 'open' | 'recordImportedRestBatch'>;
  /** Tells every window a project's History changed under it: an import wrote entries. */
  readonly onHistoryChanged: (projectId: string) => void;
  /**
   * The open workspace's importers, plugins' included (phase 7 §3.1): a file no built-in format claims
   * is offered to them. Absent (a test), there are none.
   */
  readonly importers?: () => readonly ImporterContribution[];
}

/** `count` with the noun that fits it: `1 entry`, `2 entries`. */
function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The report lines a HAR import's History write earns: what it skipped, and what the cap dropped. */
function historyOutcomeWarnings(outcome: ImportedHistoryOutcome): string[] {
  const warnings: string[] = [];
  if (outcome.invalidTime > 0) {
    warnings.push(
      `${counted(outcome.invalidTime, 'recorded exchange', 'recorded exchanges')} had no valid time and ${
        outcome.invalidTime === 1 ? 'was' : 'were'
      } not written to History.`,
    );
  }
  if (outcome.droppedOlder > 0) {
    warnings.push(
      `History keeps a limited number of entries per project: ${counted(
        outcome.droppedOlder,
        'older History entry was',
        'older History entries were',
      )} dropped to make room for the import.`,
    );
  }
  if (outcome.droppedImported > 0) {
    warnings.push(
      `${counted(outcome.droppedImported, 'recorded exchange', 'recorded exchanges')}, the earliest, did not fit under History's per-project limit and ${
        outcome.droppedImported === 1 ? 'was' : 'were'
      } not written.`,
    );
  }
  return warnings;
}

/** The engine's source shape. A `file` path becomes a `file:` URL here, where the platform is known. */
export function toEngineSource(source: OpenApiSourceWire): OpenApiSource {
  if (source.kind === 'file') {
    return { kind: 'file', path: pathToFileURL(source.path).href };
  }
  if (source.kind === 'text') {
    return { kind: 'text', text: source.text, ...(source.location !== undefined ? { location: source.location } : {}) };
  }
  return source;
}

/** A definition's fetch credentials off the wire, into the model: references only, absent optionals dropped. */
export function toDefinitionAuth(wire: DefinitionAuthWire): DefinitionAuth {
  switch (wire.type) {
    case 'basic':
      return { type: 'basic', username: wire.username, passwordRef: wire.passwordRef };
    case 'bearer':
      return { type: 'bearer', tokenRef: wire.tokenRef, ...(wire.scheme !== undefined ? { scheme: wire.scheme } : {}) };
    case 'api-key':
      return { type: 'api-key', name: wire.name, in: wire.in, valueRef: wire.valueRef };
    case 'kerberos':
      return {
        type: 'kerberos',
        ...(wire.spn !== undefined ? { spn: wire.spn } : {}),
        ...(wire.principal !== undefined ? { principal: wire.principal } : {}),
        ...(wire.username !== undefined ? { username: wire.username } : {}),
        ...(wire.domain !== undefined ? { domain: wire.domain } : {}),
        ...(wire.passwordRef !== undefined ? { passwordRef: wire.passwordRef } : {}),
      };
  }
}

/** A sha256 over every document an update read, location and bytes, in the order they were read. */
export function fingerprintOf(documents: readonly { readonly location: string; readonly bytes: Uint8Array }[]): string {
  const hash = createHash('sha256');
  for (const document of documents) {
    hash.update(document.location).update('\0').update(document.bytes).update('\0');
  }
  return hash.digest('hex');
}

/** What the API records as where its definition came from: the location as the user gave it. */
export function sourceLabel(source: OpenApiSourceWire): string {
  if (source.kind === 'url') {
    return source.url;
  }
  if (source.kind === 'file') {
    return source.path;
  }
  return source.location ?? 'inline:openapi';
}

/**
 * A `.http` environment file's text, read through a no-follow handle and refused past the `.http`
 * size cap rather than read whole.
 *
 * @throws WirebenchError `import-path-refused` when the file changed after its companion check
 */
async function readHttpEnvText(path: string): Promise<string> {
  const bytes = await readCompanionFile(
    path,
    MAX_HTTP_FILE_BYTES,
    () =>
      new HttpFileError(
        'http-file-too-large',
        `${basename(path)} is larger than ${String(MAX_HTTP_FILE_BYTES / (1024 * 1024))} MB`,
      ),
  );
  return bytes.toString('utf8');
}

/** The `$shared` names of an environment file that `parseHttpEnvFiles` has already accepted. */
function sharedNamesOf(text: string): string[] {
  const shared = (JSON.parse(text) as Record<string, unknown>)['$shared'];
  return typeof shared === 'object' && shared !== null && !Array.isArray(shared) ? Object.keys(shared) : [];
}

/** The most of a picked file read to detect its format: the import's own file limit. */
const DETECT_MAX_BYTES = 50 * 1024 * 1024;

/** The most a plugin importer is handed: the plugin sandbox's own input limit. */
const PLUGIN_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

/** The root document of an OpenCollection directory, in any case. */
const OC_ROOT_FILE = /^opencollection\.ya?ml$/i;

/**
 * Whether a root document holds its items itself, so its folder is not walked. Text that does not
 * parse counts as a single document, which the engine then refuses with its own error.
 */
function holdsItsItems(rootText: string): boolean {
  try {
    const doc: unknown = parseYaml(rootText);
    return typeof doc !== 'object' || doc === null || Array.isArray((doc as Record<string, unknown>)['items']);
  } catch {
    return true;
  }
}

/** How the import dialog marks text that came from a dropped file: `dropped:<file name>`. */
const DROPPED_PREFIX = 'dropped:';

/**
 * The file name a dropped file's text came from, read from its `dropped:<name>` location, or
 * `undefined` for pasted text. Only the last path segment is kept: a drop names no folder.
 */
function droppedFileName(source: PostmanSourceWire): string | undefined {
  if (source.kind !== 'text' || source.location?.startsWith(DROPPED_PREFIX) !== true) return undefined;
  const name = source.location.slice(DROPPED_PREFIX.length).split(/[\\/]/).at(-1)?.trim() ?? '';
  return name === '' ? undefined : name;
}

/** True for the private `.http` environment file's name, in any case. */
function isPrivateHttpEnvName(name: string): boolean {
  return name.toLowerCase() === HTTP_PRIVATE_ENV_FILE;
}

/** Registers the `api.*` IPC channels. */
export function registerApiChannels(table: HandlerTable, deps: ApiChannelDeps): void {
  const { router } = deps;

  /** A Postman source with its `file` path checked for containment or a dialog pick before it is read. */
  const checkedPostmanSource = async (
    source: PostmanSourceWire,
  ): Promise<{ readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string }> => {
    if (source.kind === 'text') {
      return { kind: 'text', text: source.text };
    }
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, { kind: 'file', path: source.path });
    if (checked.kind !== 'file') {
      throw new WirebenchError('invalid-argument', 'Expected a file source');
    }
    return { kind: 'file', path: checked.path };
  };

  /**
   * Places another request client's mapped import in the target project: an existing one, or one
   * created for it and taken back when anything after it fails, so a refusal changes nothing.
   */
  const placeClientImport = async (
    target: { readonly projectId: string } | { readonly newProjectName: string },
    mapped: MappedClientImport,
    meta: { readonly source: string; readonly declaredVersion: string },
  ) => {
    const placeIn = async (projectId: string) => {
      const placed = await placeMappedImport(deps, projectId, mapped, meta);
      return {
        projectId: placed.projectId,
        ...(placed.project !== undefined ? { project: placed.project } : {}),
        apiIds: placed.apiIds,
        counts: { ...mapped.counts, scripts: placed.scripts },
        ...(placed.variables !== undefined ? { variables: placed.variables } : {}),
        warnings: placed.warnings,
        notes: placed.notes,
        reportText: placed.reportText,
      };
    };
    if ('projectId' in target) return await placeIn(target.projectId);
    const { projectId } = await deps.addProject(target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  };

  /**
   * Writes an importer's scripts under `imported-scripts/`, never overwriting one: how many were
   * written, a note for each saved under another name, and a warning for each that was not written.
   */
  const writeScriptsReported = async (
    projectId: string,
    scripts: readonly { readonly path: string; readonly source: string }[],
  ): Promise<{ readonly written: number; readonly notes: string[]; readonly warnings: string[] }> => {
    if (scripts.length === 0) return { written: 0, notes: [], warnings: [] };
    const { written, renamed, skipped } = await router.writeImportedScripts(projectId, scripts);
    return {
      written: written.length,
      notes: renamed.map(({ from, to }) => `A script already existed at ${from}, so this one was saved as ${to}.`),
      warnings: skipped.map(
        (path) => `The script ${path} would have been saved outside imported-scripts/ and was not written.`,
      ),
    };
  };

  registerHandler(table, channels.api.importPostman, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const imported = await importPostmanCollection(checkedSource, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
    });

    const place = {
      api: imported.api,
      documents: [],
      source: checkedSource.kind === 'file' ? checkedSource.path : 'inline:postman',
      declaredVersion: 'postman-collection',
      cache: false,
    };

    // The collection's own variables become properties of the project the API landed in; a name
    // the project already has keeps its value.
    const placeIn = async (projectId: string) => {
      const added = await router.addApi(projectId, place);
      const variables =
        imported.projectProperties.variables.length > 0
          ? await applyImportedVariables(
              { environments: [], projectProperties: imported.projectProperties, report: { warnings: [], notes: [] } },
              deps.variablesPorts(projectId),
            )
          : undefined;
      return { ...added, projectId, summary: imported.summary, ...(variables !== undefined ? { variables } : {}) };
    };

    if ('projectId' in request.target) {
      return await placeIn(request.target.projectId);
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * A HAR capture: one REST API per origin it called, placed in the target project. With
   * `responses: 'history'` each recorded exchange is written to that project's History at the time
   * it was recorded, redacted as a live send's entry is. A project created for the import is taken
   * back when anything after it fails.
   */
  registerHandler(table, channels.api.importHar, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const mapped = await importHar(checkedSource, {
      includeStaticAssets: request.includeStaticAssets,
      responses: request.responses,
    });
    if (mapped.apis.length === 0) {
      throw new WirebenchError(
        'har-nothing-to-import',
        'No HTTP requests were left to import after skipping preflights and static assets',
      );
    }
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:har';

    const placeIn = async (projectId: string) => {
      let project: Awaited<ReturnType<typeof router.addApi>>['project'] | undefined;
      for (const api of mapped.apis) {
        ({ project } = await router.addApi(projectId, {
          api,
          documents: [],
          source,
          declaredVersion: 'har',
          cache: false,
        }));
      }
      if (project === undefined) {
        throw new WirebenchError('internal-error', 'The HAR import placed no API');
      }
      let historyRecorded = 0;
      const historyWarnings: string[] = [];
      if (request.responses === 'history' && mapped.exchanges.length > 0) {
        await deps.history.open(projectId);
        const names = new Map(
          mapped.apis.flatMap((api) =>
            api.requests.map((restRequest) => [restRequest.id, { request: restRequest.name, api: api.name }] as const),
          ),
        );
        const records = mapped.exchanges.flatMap((exchange) => {
          const name = names.get(exchange.requestId);
          return name === undefined
            ? []
            : [{ ...exchange, requestName: name.request, apiName: name.api, tags: ['imported:har'] }];
        });
        // One write for the whole capture, rotated against the cap as a live send's entry is.
        const outcome = await deps.history.recordImportedRestBatch(projectId, records);
        historyRecorded = outcome.recorded;
        historyWarnings.push(...historyOutcomeWarnings(outcome));
        if (historyRecorded > 0) deps.onHistoryChanged(projectId);
      }
      const report = { warnings: [...mapped.report.warnings, ...historyWarnings], notes: mapped.report.notes };
      return {
        projectId,
        project,
        apiIds: mapped.apis.map((api) => api.id),
        summary: { ...mapped.summary, historyRecorded },
        ...report,
        reportText: formatImportReport(report),
      };
    };

    if ('projectId' in request.target) {
      return await placeIn(request.target.projectId);
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * The environment files beside `file` that exist, read through the companion rule (ADR-0005):
   * `[public, private]`, each `undefined` when it is not there.
   */
  const readHttpEnvCompanions = async (
    file: string,
    names: readonly string[] = [HTTP_ENV_FILE, HTTP_PRIVATE_ENV_FILE],
  ): Promise<[string | undefined, string | undefined]> => {
    const found = await checkedCompanionPaths(deps.projectDirs(), deps.picks, file, names);
    const textOf = async (name: string) => {
      const path = found.find((candidate) => basename(candidate) === name);
      return path === undefined ? undefined : await readHttpEnvText(path);
    };
    return [await textOf(HTTP_ENV_FILE), await textOf(HTTP_PRIVATE_ENV_FILE)];
  };

  /** The environment names beside a `.http` file, so the import dialog can offer them. Never a value. */
  registerHandler(table, channels.api.inspectHttpFile, async (request) => {
    const checked = await checkedPostmanSource({ kind: 'file', path: request.path });
    if (checked.kind !== 'file') {
      throw new WirebenchError('invalid-argument', 'Expected a file source');
    }
    const [publicText, privateText] = await readHttpEnvCompanions(checked.path);
    if (publicText === undefined && privateText === undefined) return { environments: [] };
    return {
      environments: parseHttpEnvFiles(publicText, privateText, 'project').environments.map((set) => set.name),
    };
  });

  /**
   * What a picked file or folder holds, for the Import dialog, which can read neither (spec
   * 2026-10-15 §3.3). A file is read without following a link, up to {@link DETECT_MAX_BYTES}, and
   * detected by its content and name; a larger one by its name alone. A folder is detected by the
   * names directly in it, a folder's name ending in `/`; a Thunder Client `thunder-tests` folder, or
   * one whose `collections/` holds its `tc_col_*.json` files, is told apart from a folder collection
   * here. The path must pass {@link checkedImportSource} first.
   */
  /** A file no built-in format claims, as the plugin importers see it; `unknown` when none is sure, or two are. */
  const pluginDetected = async (
    text: string,
    filename: string | undefined,
  ): Promise<{ kind: string; label: string; confidence: 'definite' | 'probable' | 'unknown' }> => {
    const found = await detectPluginFormat(deps.importers?.() ?? [], {
      ...(filename !== undefined ? { filename } : {}),
      text,
    });
    if (found.kind !== 'found') return { kind: 'unknown', label: 'Unknown format', confidence: 'unknown' };
    return { kind: `plugin:${found.importer.id}`, label: found.importer.title, confidence: found.confidence };
  };

  registerHandler(table, channels.api.detectPluginImport, async (request) =>
    pluginDetected(request.text, request.filename),
  );

  /**
   * A file or text through a plugin's importer (ADR-0031): its result is checked in the engine, mapped
   * as a REST export is, and placed as another client's export; a secret value it names is not kept.
   */
  registerHandler(table, channels.api.importPlugin, async (request) => {
    const importer = (deps.importers?.() ?? []).find((entry) => entry.id === request.importer);
    if (importer?.import === undefined) {
      throw new WirebenchError('plugin-missing', `No plugin importer "${request.importer}" is on`, {
        details: { id: request.importer },
      });
    }
    const checkedSource = await checkedPostmanSource(request.source);
    const tooLarge = (): Error =>
      new WirebenchError('plugin-error', 'The file is larger than a plugin may be handed (32 MiB)');
    const bytes =
      checkedSource.kind === 'file'
        ? await readNoFollow(checkedSource.path, PLUGIN_IMPORT_MAX_BYTES, tooLarge)
        : undefined;
    if (checkedSource.kind === 'file' && bytes === undefined) {
      throw new WirebenchError('invalid-argument', `${checkedSource.path} is not a regular file`);
    }
    const text = checkedSource.kind === 'file' ? (bytes?.toString('utf8') ?? '') : checkedSource.text;
    const result = await importer.import({
      ...(checkedSource.kind === 'file' ? { filename: basename(checkedSource.path) } : {}),
      text,
    });
    const mapped = mapPluginImport(result, importer.title);
    const source = checkedSource.kind === 'file' ? checkedSource.path : `inline:plugin:${importer.id}`;
    return await placeClientImport(request.target, mapped, { source, declaredVersion: `plugin:${importer.id}` });
  });

  registerHandler(table, channels.api.detectImportSource, async (request) => {
    const checked = await checkedPostmanSource({ kind: 'file', path: request.path });
    if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a path');
    if (!request.folder) {
      const bytes = await readNoFollow(checked.path, DETECT_MAX_BYTES, () => new Error('too large')).catch(
        () => undefined,
      );
      const text = bytes?.toString('utf8');
      const detected = detectImportFormat({ ...(text !== undefined ? { text } : {}), filename: checked.path });
      if (detected.kind !== 'unknown' || text === undefined) return detected;
      return await pluginDetected(text, checked.path);
    }
    const entries = await readdir(checked.path, { withFileTypes: true });
    const children = entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (basename(checked.path).toLowerCase() === 'thunder-tests') {
      return { kind: 'thunder-client', label: 'Thunder Client collection', confidence: 'definite' as const };
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === 'collections')) {
      const inner = await readdir(join(checked.path, 'collections')).catch(() => [] as string[]);
      const lower = inner.map((name) => name.toLowerCase());
      if (lower.some((name) => name.startsWith('tc_col_') && name.endsWith('.json'))) {
        return { kind: 'thunder-client', label: 'Thunder Client collection', confidence: 'definite' as const };
      }
    }
    return detectImportFolder(children);
  });

  /**
   * A `.http` request file: a REST API (and a WebSocket API for its `WEBSOCKET` requests) in the
   * target project, its response handlers written under `imported-scripts/` and never run, its
   * `@variables` as project properties, and — for a picked file — the environment files beside it as
   * workspace environments. Everything is read and parsed before a project is created; a project
   * created for the import is taken back when anything after it fails.
   */
  registerHandler(table, channels.api.importHttpFile, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    // A dropped file names its API after the file, as a picked one does; pasted text has no name.
    const droppedName = droppedFileName(request.source)?.replace(/\.(?:http|rest)$/i, '');
    const mapped = await importHttpFile(
      checkedSource.kind === 'text' && droppedName !== undefined && droppedName !== ''
        ? { ...checkedSource, name: droppedName }
        : checkedSource,
    );
    const [publicText, privateText] =
      request.includeEnvironments && checkedSource.kind === 'file'
        ? await readHttpEnvCompanions(checkedSource.path)
        : [undefined, undefined];
    const env =
      publicText === undefined && privateText === undefined
        ? undefined
        : parseHttpEnvFiles(publicText, privateText, 'project');
    // Which `$shared` names came from the private file, so a clash note names the file it lost from.
    const privateShared = new Set(privateText === undefined ? [] : sharedNamesOf(privateText));

    // `@variables` first, so a name the file sets wins over the environment files' `$shared` one.
    const mergeReport = new ReportBuilder();
    const properties = new VariableSetBuilder('Project properties', mergeReport);
    for (const variable of mapped.projectProperties.variables) properties.add(variable);
    for (const variable of env?.projectProperties?.variables ?? []) {
      properties.add(variable, privateShared.has(variable.name) ? HTTP_PRIVATE_ENV_FILE : HTTP_ENV_FILE);
    }
    const merged = mergeReport.build();
    const plan: ImportedVariables = {
      environments: env?.environments ?? [],
      ...(properties.size > 0 ? { projectProperties: properties.build() } : {}),
      report: {
        warnings: [...(env?.report.warnings ?? []), ...merged.warnings],
        notes: [...(env?.report.notes ?? []), ...merged.notes],
      },
    };
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:http';

    const placeIn = async (projectId: string) => {
      let { project, apiId } = await router.addApi(projectId, {
        api: mapped.rest,
        documents: [],
        source,
        declaredVersion: 'http-file',
        cache: false,
      });
      const apiIds = [apiId];
      if (mapped.websocket !== undefined) {
        ({ project, apiId } = await router.importWsApi(projectId, { api: mapped.websocket }));
        apiIds.push(apiId);
      }
      const scripts = await writeScriptsReported(projectId, mapped.scripts);
      const variables =
        plan.environments.length > 0 || plan.projectProperties !== undefined
          ? await applyImportedVariables(plan, deps.variablesPorts(projectId))
          : undefined;
      // The apply result repeats the plan's own report, so the env and merge lines come from it.
      const report = {
        warnings: [...mapped.report.warnings, ...scripts.warnings, ...(variables?.warnings ?? [])],
        notes: [...mapped.report.notes, ...scripts.notes, ...(variables?.notes ?? [])],
      };
      return {
        projectId,
        project,
        apiIds,
        counts: { ...mapped.counts, scripts: scripts.written },
        ...(variables !== undefined ? { variables } : {}),
        ...report,
        reportText: formatImportReport(report),
      };
    };

    if ('projectId' in request.target) {
      return await placeIn(request.target.projectId);
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * A picked or pasted OpenCollection, read in the form it is in (spec §7.1). A picked
   * `opencollection.yml` whose document has no `items` is the directory form: every YAML file under
   * its folder is read, never through a link — the root and its folder must not be links either.
   * Any other file, and text, is a single document.
   */
  const readOpenCollection = async (
    source: { readonly kind: 'file'; readonly path: string } | { readonly kind: 'text'; readonly text: string },
  ): Promise<{ readonly mapped: MappedOpenCollection; readonly tree: boolean }> => {
    if (source.kind === 'text' || !OC_ROOT_FILE.test(basename(source.path))) {
      return { mapped: await importOpenCollection(source), tree: false };
    }
    // A linked root or root folder would point the walk at a folder the user never chose.
    await checkedOpenCollectionRoot(source.path, deps.projectDirs(), deps.picks);
    const rootText = await readOpenCollectionFile(source.path);
    const rootDir = dirname(source.path);
    if (holdsItsItems(rootText)) {
      return { mapped: await importOpenCollection({ kind: 'text', text: rootText }, { rootDir }), tree: false };
    }
    const files = await readOpenCollectionTree(source.path, deps.projectDirs(), deps.picks);
    const rootKey = basename(source.path);
    // The root is `rootText`; left in, it would count twice against the size cap.
    files.delete(rootKey);
    return {
      mapped: await importOpenCollection({ kind: 'tree', rootText, files, rootKey }, { rootDir }),
      tree: true,
    };
  };

  /**
   * The `.proto` files a directory collection's gRPC items name, and the files they import, read
   * beside its root through the companion rule (ADR-0005) and checked to load, so the gRPC API can
   * be placed with its definition. `protos` is absent when none could be used; the report says why.
   */
  const readOpenCollectionProtos = async (
    rootFile: string,
    grpcName: string,
    names: readonly string[],
  ): Promise<{
    readonly protos?: { readonly sources: Map<string, string>; readonly roots: readonly string[] };
    readonly warnings: string[];
    readonly notes: string[];
  }> => {
    const warnings: string[] = [];
    const notes: string[] = [];
    let protos: { readonly sources: Map<string, string>; readonly roots: readonly string[] } | undefined;
    try {
      const read = await readCompanionProtos(rootFile, deps.projectDirs(), deps.picks, names);
      const base = dirname(rootFile);
      const listed = new Set(read.roots);
      for (const name of names) {
        if (!listed.has(relative(base, resolve(base, name)).split(sep).join('/'))) {
          notes.push(`${grpcName}: ${name} was not found beside the collection.`);
        }
      }
      for (const { name, importedBy } of read.missing) {
        warnings.push(`${grpcName}: ${importedBy} imports ${name}, which was not found in the collection's folder.`);
      }
      if (read.missingMore > 0) {
        warnings.push(
          `${grpcName}: and ${String(read.missingMore)} more missing import${read.missingMore === 1 ? '' : 's'}.`,
        );
      }
      if (read.roots.length > 0 && read.missing.length === 0) {
        loadProtoSet(read.sources, { roots: read.roots });
        protos = { sources: read.sources, roots: read.roots };
      }
    } catch (error) {
      warnings.push(
        `${grpcName}: the .proto files could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (protos === undefined) {
      notes.push(`${grpcName}: needs a definition: import its .proto or use server reflection.`);
    }
    return { ...(protos !== undefined ? { protos } : {}), warnings, notes };
  };

  /**
   * An OpenCollection (spec §7): a REST API for its HTTP and GraphQL items, a gRPC API and a
   * WebSocket API for theirs, its scripts attached switched off (the rest under `imported-scripts/` as text), its environments
   * as workspace environments (never activated) and its variables as project properties. Secret
   * values go to the secret store; none is in the response.
   *
   * Everything is read, parsed and mapped before a project is created, so a refusal — a path that
   * was not picked, a collection past the limits, or one with no request and no environment (one
   * holding only project properties or scripts is refused too) — changes nothing. A project created
   * for the import is taken back when anything after it fails.
   */
  registerHandler(table, channels.api.importOpenCollection, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const { mapped, tree } = await readOpenCollection(checkedSource);
    const proto =
      tree && checkedSource.kind === 'file' && mapped.grpc !== undefined && mapped.protoFiles.length > 0
        ? await readOpenCollectionProtos(checkedSource.path, mapped.grpc.name, mapped.protoFiles)
        : mapped.grpc !== undefined && mapped.protoFiles.length > 0
          ? {
              warnings: [],
              notes: [`${mapped.grpc.name}: needs a definition: import its .proto or use server reflection.`],
            }
          : { warnings: [], notes: [] };
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:opencollection';

    const placeIn = async (projectId: string) => {
      let project: Awaited<ReturnType<typeof router.addApi>>['project'] | undefined;
      const apiIds: string[] = [];
      const placed = (added: Awaited<ReturnType<typeof router.addApi>>) => {
        project = added.project;
        apiIds.push(added.apiId);
      };
      if (mapped.rest !== undefined) {
        placed(
          await router.addApi(projectId, {
            api: mapped.rest,
            documents: [],
            source,
            declaredVersion: 'opencollection-1',
            cache: false,
          }),
        );
      }
      if (mapped.grpc !== undefined) {
        const protos = proto.protos;
        const first = protos?.roots[0];
        placed(
          protos !== undefined && first !== undefined && checkedSource.kind === 'file'
            ? await router.addGrpcApi(projectId, {
                api: mapped.grpc,
                roots: protos.roots,
                source: join(dirname(checkedSource.path), ...first.split('/')),
                kind: 'proto',
                sources: protos.sources,
              })
            : await router.importGrpcApi(projectId, { api: mapped.grpc }),
        );
      }
      if (mapped.websocket !== undefined) {
        placed(await router.importWsApi(projectId, { api: mapped.websocket }));
      }
      const scripts = await writeScriptsReported(projectId, mapped.scripts);
      const plan = mapped.variables;
      const variables =
        plan.environments.length > 0 || plan.projectProperties !== undefined
          ? await applyImportedVariables(plan, deps.variablesPorts(projectId))
          : undefined;
      // The apply result repeats the plan's own report; with nothing applied, the plan's report stands.
      const variableReport = variables ?? plan.report;
      const report = {
        warnings: [...mapped.report.warnings, ...proto.warnings, ...scripts.warnings, ...variableReport.warnings],
        notes: [...mapped.report.notes, ...proto.notes, ...scripts.notes, ...variableReport.notes],
      };
      return {
        projectId,
        ...(project !== undefined ? { project } : {}),
        apiIds,
        counts: {
          requests: mapped.counts.requests,
          folders: mapped.counts.folders,
          assertions: mapped.counts.assertions,
          assertionsSkipped: mapped.counts.assertionsSkipped,
          scripts: scripts.written,
        },
        ...(variables !== undefined ? { variables } : {}),
        ...report,
        reportText: formatImportReport(report),
      };
    };

    if ('projectId' in request.target) {
      return await placeIn(request.target.projectId);
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * A folder (v3) collection (spec 2026-10-11): each collection's REST, gRPC and WebSocket API in the
   * chosen project, the collections' variables as its properties, a workspace folder's environments
   * (never activated) and globals in the workspace. Secret values go to the secret store.
   *
   * The picked path — a folder from `dialogs.openFolder`, or a `.resources/definition.yaml` from
   * Browse… — must pass {@link checkedImportSource}; the folder it stands for is then walked without
   * following a link and without leaving it. Everything is read and mapped before a project is
   * created, so a refusal changes nothing, and a project created for the import is taken back when
   * anything after it fails.
   */
  registerHandler(table, channels.api.importPostmanFolder, async (request) => {
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, { kind: 'file', path: request.path });
    if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a path');
    const root = await collectionV3Root(checked.path);
    const files = await readCollectionV3Folder(root);
    const mapped = mapCollectionV3(readCollectionV3(files, basename(root)), {
      ...(request.name !== undefined && request.name.trim() !== '' ? { name: request.name } : {}),
    });

    const placeIn = async (projectId: string) => {
      const placed = await placeMappedImport(deps, projectId, mapped, {
        source: root,
        declaredVersion: 'postman-collection-v3',
      });
      return {
        projectId: placed.projectId,
        ...(placed.project !== undefined ? { project: placed.project } : {}),
        apiIds: placed.apiIds,
        counts: mapped.counts,
        ...(placed.variables !== undefined ? { variables: placed.variables } : {}),
        warnings: placed.warnings,
        notes: placed.notes,
        reportText: placed.reportText,
      };
    };

    if ('projectId' in request.target) {
      return await placeIn(request.target.projectId);
    }

    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      return await placeIn(projectId);
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  /**
   * An Insomnia export (spec 2026-10-15 §4): each workspace's REST, gRPC and WebSocket API in the
   * chosen project, its scripts attached to their requests and folders switched off (they run only once the
   * user turns them on), its base and folder
   * environments as project properties and its sub-environments as workspace environments (never
   * activated). Everything is read and mapped before a project is created, so a refusal changes
   * nothing; a project created for the import is taken back when anything after it fails. An export
   * holding only environments goes to `api.importClientEnvironments` instead.
   */
  registerHandler(table, channels.api.importInsomnia, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const mapped = await importInsomnia(checkedSource, {
      ...(request.name !== undefined && request.name.trim() !== '' ? { name: request.name } : {}),
    });
    if (mapped.collections.length === 0 && mapped.variables.projectProperties === undefined) {
      throw new WirebenchError(
        'insomnia-environments-only',
        'This Insomnia file holds only environments: import it as Insomnia environments.',
      );
    }
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:insomnia';
    return await placeClientImport(request.target, mapped, { source, declaredVersion: 'insomnia' });
  });

  /**
   * A Bruno collection (spec 2026-10-15 §5): a picked folder, or its `bruno.json`, is walked for its
   * `.bru`, `.js` and `.proto` files (a `.env` file is never opened); any other file, or text, is
   * read as a JSON export. Its REST, gRPC and WebSocket APIs land in the chosen project as an
   * Insomnia export's do, its scripts as text, its environments in the workspace, never activated.
   */
  registerHandler(table, channels.api.importBruno, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const isFolder =
      checkedSource.kind === 'file' &&
      (await stat(checkedSource.path).then(
        (info) => info.isDirectory(),
        () => false,
      ));
    const mapped = await importBruno(
      isFolder && checkedSource.kind === 'file' ? { kind: 'folder', path: checkedSource.path } : checkedSource,
      { ...(request.name !== undefined && request.name.trim() !== '' ? { name: request.name } : {}) },
    );
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:bruno';
    return await placeClientImport(request.target, mapped, { source, declaredVersion: 'bruno' });
  });

  /**
   * A Hoppscotch collections export (spec 2026-10-15 §6): each top-level collection's REST API in the
   * chosen project, its collection and folder variables as project properties, its scripts attached
   * switched off (a dropped collection's or folder's kept as text). An environments file is refused by the reader: it goes to `api.importClientEnvironments`.
   */
  registerHandler(table, channels.api.importHoppscotch, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const mapped = await importHoppscotch(checkedSource, {
      ...(request.name !== undefined && request.name.trim() !== '' ? { name: request.name } : {}),
    });
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:hoppscotch';
    return await placeClientImport(request.target, mapped, { source, declaredVersion: 'hoppscotch' });
  });

  /**
   * A Thunder Client collection export, or a `thunder-tests` folder picked with Folder… (spec
   * 2026-10-15 §7): each collection's REST API in the chosen project, its tests as assertions where
   * they fit, its scripts attached switched off (a dropped collection's or folder's kept as text), and
   * a folder's environments in the workspace, never activated.
   */
  registerHandler(table, channels.api.importThunderClient, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    const isFolder =
      checkedSource.kind === 'file' &&
      (await stat(checkedSource.path).then(
        (info) => info.isDirectory(),
        () => false,
      ));
    const mapped = await importThunderClient(
      isFolder && checkedSource.kind === 'file' ? { kind: 'folder', path: checkedSource.path } : checkedSource,
      { ...(request.name !== undefined && request.name.trim() !== '' ? { name: request.name } : {}) },
    );
    const source = checkedSource.kind === 'file' ? checkedSource.path : 'inline:thunder-client';
    return await placeClientImport(request.target, mapped, { source, declaredVersion: 'thunder-client' });
  });

  /**
   * Another request client's environments file, applied to the open workspace: its base merged into
   * Globals, each sub-environment a workspace environment under a free name (never activated). An
   * export holding requests is refused rather than half imported.
   */
  registerHandler(table, channels.api.importClientEnvironments, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    // A Hoppscotch environments file is its own format, refused by the reader when it holds collections.
    const mapped =
      request.format === 'hoppscotch'
        ? await importHoppscotchEnvironments(checkedSource)
        : request.format === 'thunder-client'
          ? await importThunderClient(checkedSource)
          : await importInsomnia(checkedSource);
    if (mapped.collections.length > 0 || mapped.variables.projectProperties !== undefined) {
      throw new WirebenchError(
        'insomnia-not-environments',
        request.format === 'thunder-client'
          ? 'This Thunder Client export holds a collection: import it as a Thunder Client collection.'
          : 'This Insomnia export holds a collection: import it as an Insomnia export.',
      );
    }
    const summary = await applyImportedVariables(mapped.variables, deps.variablesPorts(undefined));
    const report = {
      warnings: [...mapped.report.warnings, ...summary.warnings],
      notes: [...mapped.report.notes, ...summary.notes],
    };
    return { summary: { ...summary, ...report }, reportText: formatImportReport(report) };
  });

  /**
   * `.http` environment files on their own, applied to the open workspace: environments under a free
   * name (never activated), `$shared` into workspace properties, private values into the secret
   * store. A picked file brings its partner from beside it; pasted text is read as the public file,
   * and dropped text as the file it was dropped from.
   */
  registerHandler(table, channels.api.importHttpEnv, async (request) => {
    const checkedSource = await checkedPostmanSource(request.source);
    let publicText: string | undefined;
    let privateText: string | undefined;
    if (checkedSource.kind === 'text') {
      // Dropped from the private file, the text is private: its values must become secrets.
      const dropped = droppedFileName(request.source);
      if (dropped !== undefined && isPrivateHttpEnvName(dropped)) privateText = checkedSource.text;
      else publicText = checkedSource.text;
    } else {
      const picked = await readHttpEnvText(checkedSource.path);
      if (isPrivateHttpEnvName(basename(checkedSource.path))) {
        privateText = picked;
        [publicText] = await readHttpEnvCompanions(checkedSource.path, [HTTP_ENV_FILE]);
      } else {
        publicText = picked;
        [, privateText] = await readHttpEnvCompanions(checkedSource.path, [HTTP_PRIVATE_ENV_FILE]);
      }
    }
    const plan = parseHttpEnvFiles(publicText, privateText, 'workspace-properties');
    const summary = await applyImportedVariables(plan, deps.variablesPorts(undefined));
    return { summary, reportText: formatImportReport({ warnings: summary.warnings, notes: summary.notes }) };
  });

  /**
   * A Postman environment or globals export, applied to the open workspace: an environment under a
   * free name (never activated), globals merged into Globals, secret values into the secret store.
   * Each channel refuses the other's export rather than guessing what the user meant.
   */
  const importPostmanVariablesFrom = async (source: PostmanSourceWire, want: 'environment' | 'globals') => {
    const plan = await importPostmanVariables(await checkedPostmanSource(source));
    const isGlobals = plan.globals !== undefined;
    if (want === 'globals' && !isGlobals) {
      throw new WirebenchError(
        'postman-not-globals',
        'This is an environment export; import it as a Postman environment',
      );
    }
    if (want === 'environment' && isGlobals) {
      throw new WirebenchError('postman-not-environment', 'This is a globals export; import it as Postman globals');
    }
    const summary = await applyImportedVariables(plan, deps.variablesPorts(undefined));
    return { summary, reportText: formatImportReport({ warnings: summary.warnings, notes: summary.notes }) };
  };
  registerHandler(table, channels.api.importPostmanEnvironment, async (request) =>
    importPostmanVariablesFrom(request.source, 'environment'),
  );
  registerHandler(table, channels.api.importPostmanGlobals, async (request) =>
    importPostmanVariablesFrom(request.source, 'globals'),
  );

  registerHandler(table, channels.api.cancelImport, (request) =>
    Promise.resolve({
      cancelled:
        deps.imports.cancel(request.token).cancelled || (deps.protoImports?.cancel(request.token).cancelled ?? false),
    }),
  );

  // Identity only — no text — so a large definition stays a bounded payload.
  registerHandler(table, channels.api.definitionDocuments, async (request) => {
    const read = await router.apiDefinitionDocuments(request.apiId);
    return { ...read, documents: read.documents.map((document) => ({ ...document })) };
  });

  registerHandler(table, channels.api.definitionText, async (request) => {
    const text = await router.apiDefinitionText(request.apiId, request.location);
    const size = Buffer.byteLength(text, 'utf8');
    if (size > MAX_DOCUMENT_TEXT_BYTES) {
      throw new WirebenchError(
        'document-too-large',
        `Document "${request.location}" is too large to show (${String(size)} bytes)`,
        { details: { location: request.location, size } },
      );
    }
    return { text };
  });

  registerHandler(table, channels.api.exportDefinition, async (request, sender) => {
    const dir = await deps.dialogs.pickFolder(sender, { title: 'Export definition to folder' });
    if (dir === undefined) {
      return { cancelled: true, files: [] };
    }
    return { cancelled: false, dir, files: await router.exportApiDefinitionTo(request.apiId, dir) };
  });
}
