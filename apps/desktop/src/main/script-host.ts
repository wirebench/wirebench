/**
 * Main's side of request scripts (#63): the one sandbox and checker the app runs them with, the
 * types each request's scripts are checked against, and the session values single sends share.
 *
 * - The sandbox and the checker are the engine's: worker threads, started on first use and ended
 *   on quit. Nothing of a script runs in main itself.
 * - A request's types come from the definition its protocol already caches in main — an API's
 *   OpenAPI document, an interface's loaded WSDL, a gRPC API's `.proto` set — and are kept per
 *   loaded definition object, so an Update Definition (a new object) is picked up without a flush.
 * - Session values (spec §Values): what single sends' scripts set, per project, in memory only.
 *   A value marked secret, or holding a credential already known, is recorded for masking before it
 *   is kept, and is never listed.
 */

import {
  RequestScripting,
  activeScripts,
  createScriptChecker,
  createScriptSandbox,
  grpcMessageTypes,
  grpcScriptTypes,
  restOperationFor,
  restScriptTypes,
  scriptDeclarations,
  soapOperationElements,
  soapScriptTypes,
} from '@wirebench/engine';
import type {
  ImportResult,
  OpenApiDocument,
  Project,
  PropertyMap,
  ProtoSet,
  RequestScripts,
  RequestScriptTypes,
  ScriptChecker,
  ScriptCompletion,
  ScriptDiagnostic,
  ScriptModel,
  ScriptPhase,
  ScriptProtocol,
  ScriptQuickInfo,
  ScriptSandbox,
  ScriptSignatureHelp,
  ScriptValue,
  ScriptedRequest,
} from '@wirebench/engine';
import { findGrpcRequest, grpcApiOwning } from './project-grpc-mutations.js';
import { findRestRequest, restApiOwning } from './project-rest-mutations.js';
import { findRequest } from './project-wire.js';
import { containsRecordedSecret, recordSecretValue, redactSecretText } from './redact.js';

/** The most values one project's session keeps; the oldest goes first. */
export const SESSION_VALUE_LIMIT = 1_000;

export interface ScriptHostDeps {
  /** The open model (unsaved edits included) of the project that owns `entityId`. */
  readonly modelOf: (entityId: string) => Project | undefined;
  readonly openApiDocumentFor: (apiId: string) => Promise<OpenApiDocument>;
  readonly grpcProtoSetFor: (apiId: string) => Promise<ProtoSet>;
  /** The interface's loaded definition; throws, or returns `undefined`, when it is not loaded. */
  readonly soapDefinitionFor: (interfaceId: string) => ImportResult | undefined;
  /** A project's session values changed. */
  readonly onValuesChanged?: (projectId: string) => void;
  /** Tests substitute these; the app uses the engine's workers. */
  readonly createSandbox?: () => ScriptSandbox;
  readonly createChecker?: () => ScriptChecker;
}

/** What a send of a request does about scripts. */
export type ScriptLookup =
  { readonly kind: 'none' } | { readonly kind: 'off' } | { readonly kind: 'on'; readonly request: ScriptedRequest };

/** A session value as the explorer lists it: a secret one without its value. */
export interface SessionValueListing {
  readonly name: string;
  readonly value?: string;
  readonly secret: boolean;
}

/** A request, wherever it is, with what its script types are built from. */
interface Located {
  readonly protocol: ScriptProtocol;
  readonly path: string;
  readonly name: string;
  readonly slug: string;
  readonly scripts: RequestScripts | undefined;
  readonly types: () => Promise<RequestScriptTypes>;
}

/** Types per loaded definition object, per operation in it. */
const typeCache = new WeakMap<object, Map<string, RequestScriptTypes>>();

function memo(owner: object | undefined, key: string, make: () => RequestScriptTypes): RequestScriptTypes {
  if (owner === undefined) return make();
  let byKey = typeCache.get(owner);
  if (byKey === undefined) {
    byKey = new Map();
    typeCache.set(owner, byKey);
  }
  let found = byKey.get(key);
  if (found === undefined) {
    found = make();
    byKey.set(key, found);
  }
  return found;
}

export class ScriptHost {
  private sandbox: ScriptSandbox | undefined;
  private checker: ScriptChecker | undefined;
  private scriptingInstance: RequestScripting | undefined;
  private readonly sessions = new Map<string, Map<string, { readonly value: string; readonly secret: boolean }>>();

  constructor(private readonly deps: ScriptHostDeps) {}

  private checkerOf(): ScriptChecker {
    this.checker ??= this.deps.createChecker?.() ?? createScriptChecker();
    return this.checker;
  }

  /** The app's one `RequestScripting`: every script runs in its sandbox, checked by its checker. */
  get scripting(): RequestScripting {
    if (this.scriptingInstance === undefined) {
      this.sandbox = this.deps.createSandbox?.() ?? createScriptSandbox();
      this.scriptingInstance = new RequestScripting({
        sandbox: this.sandbox,
        checker: this.checkerOf(),
        onSecretValue: recordSecretValue,
      });
    }
    return this.scriptingInstance;
  }

  private locate(requestId: string): Located | undefined {
    const project = this.deps.modelOf(requestId);
    if (project === undefined) return undefined;

    const soap = findRequest(project, requestId);
    if (soap !== undefined) {
      const { iface, operation, request } = soap;
      return {
        protocol: 'soap',
        path: `${iface.name} / ${operation.name} / ${request.name}`,
        name: request.name,
        slug: request.slug,
        scripts: request.scripts,
        types: () => {
          let loaded: ImportResult | undefined;
          try {
            loaded = this.deps.soapDefinitionFor(iface.id);
          } catch {
            loaded = undefined;
          }
          return Promise.resolve(
            memo(loaded, `${operation.bindingName}|${operation.name}`, () => {
              if (loaded === undefined) return { generated: soapScriptTypes(undefined) };
              const elements = soapOperationElements(loaded.definition, operation.bindingName, operation.name);
              return {
                generated: soapScriptTypes(loaded.schemaSet, elements.input, elements.output),
                soap: {
                  schemas: loaded.schemaSet,
                  ...(elements.input !== undefined ? { input: elements.input } : {}),
                  ...(elements.output !== undefined ? { output: elements.output } : {}),
                },
              };
            }),
          );
        },
      };
    }

    const rest = findRestRequest(project, requestId);
    const restApi = rest === undefined ? undefined : restApiOwning(project, requestId);
    if (rest !== undefined && restApi !== undefined) {
      return {
        protocol: 'rest',
        path: `${restApi.name} / ${rest.name}`,
        name: rest.name,
        slug: rest.slug,
        scripts: rest.scripts,
        types: async () => {
          const document =
            rest.contract === undefined
              ? undefined
              : await this.deps.openApiDocumentFor(restApi.id).catch(() => undefined);
          const contract = rest.contract;
          return memo(document, contract === undefined ? '' : `${contract.method} ${contract.path}`, () => ({
            generated: restScriptTypes(restOperationFor(document, contract)),
          }));
        },
      };
    }

    const grpc = findGrpcRequest(project, requestId);
    const grpcApi = grpc === undefined ? undefined : grpcApiOwning(project, requestId);
    if (grpc !== undefined && grpcApi !== undefined) {
      return {
        protocol: 'grpc',
        path: `${grpcApi.name} / ${grpc.name}`,
        name: grpc.name,
        slug: grpc.slug,
        scripts: grpc.scripts,
        types: async () => {
          const set = await this.deps.grpcProtoSetFor(grpcApi.id).catch(() => undefined);
          return memo(set, `${grpc.service}/${grpc.method}`, () => {
            const types = grpcMessageTypes(set, grpc.service, grpc.method);
            return {
              generated: grpcScriptTypes(
                types === undefined ? undefined : set,
                types?.input ?? '',
                types?.output ?? '',
              ),
            };
          });
        },
      };
    }
    return undefined;
  }

  /** Whether a send of `requestId` runs scripts, and the request as the scripting runs it when it does. */
  async lookup(requestId: string): Promise<ScriptLookup> {
    const located = this.locate(requestId);
    if (located?.scripts === undefined) return { kind: 'none' };
    const scripts = activeScripts(located.scripts);
    if (scripts === undefined) return { kind: 'off' };
    return {
      kind: 'on',
      request: {
        protocol: located.protocol,
        path: located.path,
        name: located.name,
        slug: located.slug,
        scripts,
        types: await located.types(),
      },
    };
  }

  // --- The editor --------------------------------------------------------------------------------

  /** The model an editor's script is checked as: its text, and its request's declarations. */
  private async modelFor(requestId: string, phase: ScriptPhase, source: string): Promise<ScriptModel> {
    const located = this.locate(requestId);
    if (located === undefined) {
      return { source, declarations: '', api: 'wirebench' };
    }
    const api = located.scripts?.api ?? 'wirebench';
    if (api === 'postman') {
      return { source, declarations: '', api };
    }
    const types = await located.types();
    return {
      source,
      declarations: scriptDeclarations(located.protocol, phase, located.scripts?.secrets ?? [], types.generated),
      api,
    };
  }

  private static modelId(requestId: string, phase: ScriptPhase): string {
    return `${requestId}:${phase}`;
  }

  async diagnostics(requestId: string, phase: ScriptPhase, source: string): Promise<readonly ScriptDiagnostic[]> {
    const model = await this.modelFor(requestId, phase, source);
    return this.checkerOf().diagnostics(ScriptHost.modelId(requestId, phase), model);
  }

  async completions(
    requestId: string,
    phase: ScriptPhase,
    source: string,
    line: number,
    column: number,
  ): Promise<readonly ScriptCompletion[]> {
    const model = await this.modelFor(requestId, phase, source);
    return this.checkerOf().completions(ScriptHost.modelId(requestId, phase), model, line, column);
  }

  async quickInfo(
    requestId: string,
    phase: ScriptPhase,
    source: string,
    line: number,
    column: number,
  ): Promise<ScriptQuickInfo | undefined> {
    const model = await this.modelFor(requestId, phase, source);
    return this.checkerOf().quickInfo(ScriptHost.modelId(requestId, phase), model, line, column);
  }

  async signatureHelp(
    requestId: string,
    phase: ScriptPhase,
    source: string,
    line: number,
    column: number,
  ): Promise<ScriptSignatureHelp | undefined> {
    const model = await this.modelFor(requestId, phase, source);
    return this.checkerOf().signatureHelp(ScriptHost.modelId(requestId, phase), model, line, column);
  }

  /** Drops the language service of an editor that closed. */
  async closeModel(requestId: string, phase: ScriptPhase): Promise<void> {
    if (this.checker !== undefined) await this.checker.remove(ScriptHost.modelId(requestId, phase));
  }

  // --- Session values ----------------------------------------------------------------------------

  /** A project's session values, as `${#Sequence#name}` reads them in a single send. */
  sessionValues(projectId: string): PropertyMap {
    const session = this.sessions.get(projectId);
    return session === undefined ? {} : Object.fromEntries([...session].map(([name, { value }]) => [name, value]));
  }

  /** Keeps what a single send's scripts set. A secret value is recorded for masking first. */
  keepValues(projectId: string, values: readonly ScriptValue[]): void {
    if (values.length === 0) return;
    let session = this.sessions.get(projectId);
    if (session === undefined) {
      session = new Map();
      this.sessions.set(projectId, session);
    }
    for (const { name, value, secret } of values) {
      const isSecret = secret || containsRecordedSecret(value);
      if (isSecret) recordSecretValue(value);
      session.delete(name);
      session.set(name, { value, secret: isSecret });
    }
    for (const name of session.keys()) {
      if (session.size <= SESSION_VALUE_LIMIT) break;
      session.delete(name);
    }
    this.deps.onValuesChanged?.(projectId);
  }

  /** A project's session values for the explorer: masked, and a secret one without its value. */
  listValues(projectId: string): SessionValueListing[] {
    return [...(this.sessions.get(projectId) ?? [])].map(([name, { value, secret }]) =>
      secret ? { name, secret } : { name, value: redactSecretText(value, { show: false }), secret },
    );
  }

  /** Forgets a project's session values; how many there were. */
  clearValues(projectId: string): number {
    const count = this.sessions.get(projectId)?.size ?? 0;
    this.sessions.delete(projectId);
    if (count > 0) this.deps.onValuesChanged?.(projectId);
    return count;
  }

  /** Ends the workers; a later script starts new ones. */
  async dispose(): Promise<void> {
    const sandbox = this.sandbox;
    const checker = this.checker;
    this.sandbox = undefined;
    this.checker = undefined;
    this.scriptingInstance = undefined;
    await Promise.all([sandbox?.dispose(), checker?.dispose()]);
  }
}
