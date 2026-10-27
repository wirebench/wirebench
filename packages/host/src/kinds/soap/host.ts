/**
 * SOAP's share of an open project's host (spec §5.3): its caches and the methods that are
 * about SOAP alone, built once per open project on the {@link ProjectHostCore} the host
 * passes in, and reached as `ProjectHost.kind('soap')`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { isInsideAny } from '../../path-containment.js';
import {
  applyOutgoingWss,
  applyUpdate,
  applyWsaHeaders,
  attachmentFile,
  attachmentsDir,
  createFileAttachmentResolver,
  createInterface,
  createWssContext,
  DEFAULT_WSA_CONFIG,
  definitionCacheDir,
  definitionRootOf,
  effectiveWsa,
  endpointsFromContract,
  expand,
  exportDefinition,
  fetchDocumentFromCache,
  generateDocs,
  generatedRequestName,
  generateId,
  IMPORTED_SCRIPTS_DIR,
  interfaceDir,
  isEndpointAuth,
  mapLegacyProject,
  nextApiOrder,
  planUpdate,
  ProjectError,
  putAttachment,
  removeOutgoingWss,
  soapInterfacesOf,
  soapIssuedTokenKeyTarget,
  soapIssuedTokenTarget,
  soapItemFor,
  stripWsaHeaders,
  toSoapSendInput,
  toWssIncomingConfig,
  toWssOutgoingConfig,
  uniqueSlug,
  WirebenchError,
  writeDefinitionCache,
  wsApisOf,
  wssConfigsOf,
  WssError,
} from '@wirebench/engine';
import type {
  Attachment,
  AttachmentResolvers,
  AttachmentSource,
  Endpoint,
  EndpointAuth,
  GetSecret,
  Interface,
  KerberosSendAuth,
  LegacyImportReport,
  LegacyProject,
  OperationDef,
  Preferences,
  Project,
  ProxyOptions,
  ResolvedLegacyInterface,
  RunContext,
  SendHost,
  SoapAttachmentOptions,
  SoapOwnerAuth,
  SoapSendWss,
  WsaConfig,
  WssContext,
  WssEntry,
  WssIncomingConfig,
  WssIssuedTokenEntry,
  WssOutgoingConfig,
} from '@wirebench/engine';
import { MAX_DROPPED_ATTACHMENT_BYTES } from '@wirebench/wire/kinds/soap/wire';
import type { ApplyUpdateWire, ProjectChange, ProjectWire } from '@wirebench/wire/wire-types';
import type {
  DefinitionUpdateOptions,
  DefinitionUpdateSource,
  ImportSourceWire,
  InterfaceSummary,
  UpdatePlanWire,
  WssPolicyWire,
} from '@wirebench/wire/kinds/soap/wire';
import type { ProjectSaveResult, ProxyOptionsWire } from '@wirebench/wire/wire-base';
import { generateOptionsFrom } from '../../generate-options.js';
import { kerberosImportAuth, withoutPasswordRef } from '../../kerberos-import-auth.js';
import { resolveAuthConfig, resolveEndpointAuth } from '../../secret-resolver.js';
import { takenApiSlugs } from '../../project-api-mutations.js';
import type { ResolvedIssuedToken } from '../../issued-tokens.js';
import { extraTrustAnchors } from '../../send/host.js';
import { allowsReadPath } from '../../path-access.js';
import { addRequest, appendAttachment, contentTypeForPath } from './mutations.js';
import { findRequest, toUpdatePlanWire } from '../../project-wire.js';
import { moveDir } from '../../rename-dir.js';
import type { ProjectHostCore } from '../../project-host-core.js';
import type { KindHostHooks } from '../kind-main.js';
import { errorMessage } from '../../project-host-core.js';
import type { OpenProject } from '../../project-host-core.js';

/**
 * What a send needs to carry a request's attachments: the attachments themselves plus the
 * fully-mapped engine options (the seven MTOM/SwA flags, and the resolvers that read bytes).
 * Never serialised — the resolvers are closures over the main process's file system.
 */
export interface SendAttachmentInput {
  readonly attachments: readonly Attachment[];
  readonly attachmentOptions: SoapAttachmentOptions;
}

/**
 * Cleans a dropped file's browser-reported name before it becomes the attachment's `name` and
 * the source hint for `putAttachment`'s cached file name.
 *
 * A drop hands main a plain string, not a path the OS resolved, so nothing stops it from
 * containing separators or control characters (a crafted `DataTransfer`, or just an odd OS). It
 * is never used to address the file system — `addAttachmentBytes` always writes under
 * `attachments/<sha256>` — but it is shown in the grid and offered back as a save/open default
 * name, so it is stripped to a plain, safe display name here rather than downstream.
 */
function sanitizeDroppedName(name: string): string {
  const withoutSeparators = name.replace(/[/\\]/g, '_');
  const cleaned = withoutSeparators.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'attachment';
}

/**
 * The absolute paths a `path`-source attachment's declared path could mean, in the exact order
 * `createFileAttachmentResolver` (`@wirebench/engine`'s `packages/protocol-soap/src/soap/attachments.ts`)
 * would try them: an absolute path is itself the only candidate; a relative one is tried under
 * `resourceRoot` first (when the project has one), then under the project folder. Kept in sync
 * with that function deliberately, so the path main checks is always the path the engine would
 * actually read — see {@link ProjectHost.attachmentResolvers}'s `resolver`.
 */
function attachmentPathCandidates(projectDir: string, resourceRoot: string | undefined, path: string): string[] {
  if (isAbsolute(path)) {
    return [path];
  }
  return resourceRoot === undefined
    ? [resolvePath(projectDir, path)]
    : [resolvePath(resourceRoot, path), resolvePath(projectDir, path)];
}

/** The first of `candidates` that exists on disk, or `undefined` when none do. */
async function firstExistingCandidate(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Every distinct port address of an imported definition, as project endpoints (`${` escaped, #223). */
function endpointsFrom(summary: InterfaceSummary): Endpoint[] {
  return endpointsFromContract(
    summary.services.flatMap((service) =>
      service.ports.map((port) => ({
        service: service.name,
        port: port.name,
        ...(port.address !== undefined ? { address: port.address } : {}),
      })),
    ),
    generateId,
  );
}

/** One empty {@link OperationDef} per operation the definition exposes, with unique slugs. */
function operationsFrom(summary: InterfaceSummary): OperationDef[] {
  const taken = new Set<string>();
  return summary.operations.map((operation, index) => {
    const slug = uniqueSlug(operation.name, taken);
    taken.add(slug);
    return { name: operation.name, bindingName: operation.binding, slug, order: index, requests: [] };
  });
}

/**
 * The engine's proxy shape from the wire's: the keys whose value came over as `undefined` are
 * dropped, since the wire allows present-and-undefined fields and the engine
 * (`exactOptionalPropertyTypes`) does not.
 */
function withoutUndefinedProxy(proxy: ProxyOptionsWire): ProxyOptions {
  return Object.fromEntries(
    Object.entries(proxy).filter(([, value]) => value !== undefined),
  ) as unknown as ProxyOptions;
}

/** True when both URLs parse and share a scheme, host and port; anything unparsable counts as different. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin && new URL(a).origin !== 'null';
  } catch {
    return false;
  }
}

export class SoapHost implements KindHostHooks {
  constructor(private readonly core: ProjectHostCore) {}

  /** Re-imports every interface from its definition cache in the background, after an open. */
  async hydrate(): Promise<void> {
    await this.hydrateAll();
  }

  /** Releases each interface's imported definition as the project closes. */
  close(project: Project): void {
    for (const iface of soapInterfacesOf(project)) {
      this.core.engine.close(iface.id);
    }
  }

  /** A removed interface takes its runtime state and its imported definition with it. */
  afterChange(change: ProjectChange): void {
    if (change.kind === 'remove-interface') {
      this.core.open?.runtime.delete(change.interfaceId);
      this.core.engine.close(change.interfaceId);
    }
  }

  /**
   * The URL a send of `requestId` goes to under `envId` (the active environment when absent),
   * without changing which environment is active. `undefined` when no project is open, the
   * request or the environment is unknown, or no endpoint resolves.
   */
  endpointFor(requestId: string, envId?: string): string | undefined {
    if (this.core.open === undefined || !this.core.knowsEnvironment(this.core.open.project, envId)) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    return this.core.resolveEndpointFor(this.core.open.project, location.iface, location.request, envId).url;
  }

  /**
   * Whether main may touch `resolved` on behalf of a request attachment.
   *
   * Two kinds of evidence count, and nothing else does: the file is contained in the project
   * folder (or its attachment cache), or the *user* picked it through the Add-attachments /
   * Browse… dialog this session. A path that merely arrived over IPC — or that a project file
   * declares after a restart — has neither, so it is refused rather than read, sent or opened.
   *
   * A path delivered by an OS drag-and-drop (Task 33b) is NOT evidence: it leaves no record in
   * main. 33b must add its own "remember this drop" channel and call it before the drop's path
   * reaches `add-attachment`, rather than widening this check.
   */
  private async allowsAttachmentPath(dir: string, resolved: string): Promise<boolean> {
    return await allowsReadPath([dir, attachmentsDir(dir)], this.core.picks, resolved);
  }

  /**
   * The attachments (and the MTOM/SwA options the request's properties ask for) that a send of
   * `requestId` must carry. Deliberately NOT part of `SoapSendInputWire`: it holds the
   * resolver closures that read bytes, which cannot — and must not — cross IPC.
   *
   * `undefined` when no project is open or the request is unknown (an ad-hoc send, which has
   * no saved attachments and no project folder to read them from).
   */
  sendAttachmentsFor(requestId: string): SendAttachmentInput | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const { request } = location;
    // Built through `toSoapSendInput` rather than by mapping the seven MTOM flags here a second
    // time: that mapping is the engine's, and duplicating it is how the two drift apart. Only
    // the attachment fields of the result are used.
    const input = toSoapSendInput({
      request: {
        properties: request.properties,
        soapVersion: request.soapVersion,
        ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
        headers: request.headers,
        envelopeXml: request.envelopeXml,
      },
      endpoint: '',
      ...(this.core.prefs() !== undefined ? { preferences: this.core.prefs() as Preferences } : {}),
      projectSettings: this.core.open.project.settings,
      attachments: request.attachments,
      attachmentResolvers: this.attachmentResolvers(this.core.open),
    });
    if (input.attachmentOptions === undefined) {
      return undefined;
    }
    return { attachments: input.attachments ?? [], attachmentOptions: input.attachmentOptions };
  }

  /**
   * The resolvers a send reads attachment (and inline-file) bytes through.
   *
   * Both closures are guarded by the same predicate as `add-attachment` and
   * `resolveAttachmentPath`, {@link allowsAttachmentPath}: a read is allowed only when the
   * resolved path is inside the project folder (or its attachment cache) or was picked by the
   * *user* through a native dialog this session.
   *
   * `resolver` does NOT delegate a `path` source to the engine's project-folder resolver
   * (`createFileAttachmentResolver`) — only a `cache` source does, since its digest already
   * confines it to `attachments/`. For a `path` source, main itself works out the same
   * candidate list the engine resolver would try (`resourceRoot` first when the path is
   * relative and one is set, then the project folder — see `attachments-cache.ts`'s own
   * candidate logic), picks the first candidate that exists, and runs
   * {@link allowsAttachmentPath} on *that exact candidate* before reading it itself. Checking
   * `resolvePath(projectDir, path)` instead (ignoring `resourceRoot`) would be wrong: a
   * relative path can be contained under the project folder by that resolution while the
   * candidate the engine would actually read — `resourceRoot` joined with the same relative
   * path — points somewhere else entirely, e.g. `resourceRoot: /Users/me/.ssh` +
   * `source.path: id_rsa`. Checking the wrong candidate is equivalent to not checking at all.
   *
   * `resolveFile` handles `file:<path>` references the renderer put into the envelope; a read
   * is allowed only inside the project folder or its attachment cache, or at a user-picked
   * path — never merely because some attachment on the request happens to declare it, since
   * that declaration might itself be an unpicked, cross-session one.
   */
  private attachmentResolvers(open: OpenProject): AttachmentResolvers {
    const projectDir = open.dir;
    const resourceRoot = open.project.settings.resourceRoot;
    const readFileAttachment = createFileAttachmentResolver(projectDir, resourceRoot);
    return {
      resolver: async (attachment: Attachment): Promise<Uint8Array> => {
        if (attachment.source.kind !== 'path') {
          return readFileAttachment(attachment);
        }
        const declared = attachment.source.path;
        const candidates = attachmentPathCandidates(projectDir, resourceRoot, declared);
        const existing = await firstExistingCandidate(candidates);
        if (existing === undefined) {
          throw new ProjectError(
            'attachment-unreadable',
            `Attachment "${attachment.name}" could not be read from ${declared}`,
            { details: { attachmentId: attachment.id, path: declared } },
          );
        }
        if (!(await this.allowsAttachmentPath(projectDir, existing))) {
          throw new ProjectError(
            'attachment-outside-project',
            `The attachment "${attachment.name}" is outside the project`,
            { details: { attachmentId: attachment.id, path: declared } },
          );
        }
        return new Uint8Array(await readFile(existing));
      },
      resolveFile: async (path: string): Promise<Uint8Array> => {
        const resolved = resolvePath(projectDir, path);
        if (!(await this.allowsAttachmentPath(projectDir, resolved))) {
          throw new ProjectError(
            'inline-file-outside-project',
            `The file "${path}" resolves outside the project folder`,
            { details: { path } },
          );
        }
        return new Uint8Array(await readFile(resolved));
      },
      // Relative `file:` references resolve against the project folder, which is exactly the
      // set `resolveFile` above is willing to read from.
      resourceRoot: projectDir,
    };
  }

  /**
   * The absolute file that holds one request attachment's bytes: the cache blob for a `cache`
   * source, or the resolved `path` for a `path` one.
   *
   * The result is what `attachments.openRequest` hands to the OS — a `.command`/`.desktop`
   * away from arbitrary code execution — so it is allow-listed here rather than at the call
   * site, through {@link allowsAttachmentPath}: inside the project folder or its attachment
   * cache, or a path the user picked through a dialog *this session*. A `path` attachment
   * saved in an earlier session therefore needs re-picking before it can be opened. Throws
   * rather than returning `undefined` so the renderer sees *why* an open was refused.
   */
  async resolveAttachmentPath(requestId: string, attachmentId: string): Promise<string> {
    const open = this.core.require();
    const location = findRequest(open.project, requestId);
    if (location === undefined) {
      throw new ProjectError('not-found', `No request with id "${requestId}"`, { details: { requestId } });
    }
    const attachment = location.request.attachments.find((candidate) => candidate.id === attachmentId);
    if (attachment === undefined) {
      throw new ProjectError('not-found', `No attachment with id "${attachmentId}"`, { details: { attachmentId } });
    }
    if (attachment.source.kind === 'cache') {
      return attachmentFile(open.dir, attachment.source.sha256);
    }
    const declared = attachment.source.path;
    const resolved = resolvePath(open.dir, declared);
    if (await this.allowsAttachmentPath(open.dir, resolved)) {
      return resolved;
    }
    throw new ProjectError('attachment-outside-project', `The attachment "${attachment.name}" is outside the project`, {
      details: { attachmentId, path: declared },
    });
  }

  /** The `dumpFile` path a request asks its responses to be written to, if any. */
  dumpFileFor(requestId: string): { path: string; projectDir: string } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    const path = location?.request.properties.dumpFile;
    if (path === undefined || path.trim().length === 0) {
      return undefined;
    }
    return { path: path.trim(), projectDir: this.core.open.dir };
  }

  /**
   * The credentials configured on one SOAP interface, endpoint or request — its own, not its
   * effective ones.
   *
   * The SOAP counterpart of {@link restAuthOf}, for the OAuth2 channels: a token is obtained for
   * the owner that configures it, not for whichever request happened to inherit it.
   */
  soapAuthOf(ownerId: string): SoapOwnerAuth | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    for (const iface of soapInterfacesOf(this.core.open.project)) {
      if (iface.id === ownerId) {
        return iface.auth;
      }
      const endpoint = iface.endpoints.find((candidate) => candidate.id === ownerId);
      if (endpoint !== undefined) {
        return endpoint.auth;
      }
    }
    return findRequest(this.core.open.project, ownerId)?.request.auth;
  }

  /**
   * Everything `validate.message` needs about a saved request: which imported interface (and
   * binding operation) it belongs to, the envelope as last saved, and the transport metadata
   * the SOAP structure checks cross-check the envelope against.
   *
   * `undefined` when no project is open or the request is unknown.
   */
  validationTargetFor(requestId: string):
    | {
        readonly interfaceId: string;
        readonly bindingName: string;
        readonly operationName: string;
        readonly envelopeXml: string;
        readonly soapAction?: string;
        readonly contentType?: string;
      }
    | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const { iface, operation, request } = location;
    const contentType = request.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
    return {
      interfaceId: iface.id,
      bindingName: operation.bindingName,
      operationName: operation.name,
      envelopeXml: request.envelopeXml,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  }

  /**
   * The saved request's name and owning interface/operation, for labelling a history entry.
   * `undefined` when no project is open or the request is unknown (an ad-hoc/raw send).
   */
  requestMeta(
    requestId: string,
  ): { requestName: string; interfaceName: string; operationName: string; tags?: readonly string[] } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    return {
      requestName: location.request.name,
      interfaceName: location.iface.name,
      operationName: location.operation.name,
    };
  }

  /**
   * Where a saved request came from (its operation) and what it currently holds. `undefined`
   * when no project is open or the request no longer exists. Used by `request.recreate`, which
   * must regenerate that operation's envelope before merging the current one into it.
   */
  requestSource(
    requestId: string,
  ): { interfaceId: string; bindingName: string; operationName: string; envelopeXml: string } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    return {
      interfaceId: location.iface.id,
      bindingName: location.operation.bindingName,
      operationName: location.operation.name,
      envelopeXml: location.request.envelopeXml,
    };
  }

  /** The incoming WS-Security configuration with this id, or `undefined` when there is none. */
  private wssIncomingConfig(configId: string): WssIncomingConfig | undefined {
    const ref = (this.core.open === undefined ? [] : wssConfigsOf(this.core.open.project).incoming).find(
      (candidate) => candidate.id === configId,
    );
    if (ref === undefined) {
      return undefined;
    }
    try {
      return toWssIncomingConfig(ref);
    } catch {
      return undefined;
    }
  }

  /** The outgoing WS-Security configuration with this id, or `undefined` when there is none. */
  private wssOutgoingConfig(configId: string): WssOutgoingConfig | undefined {
    const ref = (this.core.open === undefined ? [] : wssConfigsOf(this.core.open.project).outgoing).find(
      (candidate) => candidate.id === configId,
    );
    if (ref === undefined) {
      return undefined;
    }
    try {
      return toWssOutgoingConfig(ref);
    } catch {
      return undefined;
    }
  }

  /**
   * The {@link WssContext} every WS-Security editor operation (the preview, "apply to editor" and
   * the ad-hoc entries) runs against: keystores read through the same containment check every
   * other read uses, and secrets decrypted through the secret store. Both closures stay inside
   * main — a resolved password never crosses the bridge.
   *
   * A SAML token's `${…}` expands against the scopes a send of the open project reads under the
   * active environment ({@link scopesFor}); a reference nothing resolves refuses with
   * `unresolved-properties` rather than going out literally. Its file is read from the project
   * folder only — a dialog pick does not widen it, as the engine's run does not — and any failure
   * (outside the folder, missing, unreadable) refuses with `saml-token-file-missing`. The send
   * itself goes through the engine's run, which lends the same two.
   */
  private wssContext(): WssContext {
    return createWssContext({
      keystores: async (ref) => await this.core.keystoreFor(ref),
      secrets: async (ref) => await this.core.secrets?.get(ref),
      expand: (text) => {
        const result = expand(text, this.core.scopesFor());
        if (result.unresolved.length > 0) {
          const exprs = result.unresolved.map((ref) => ref.expr);
          throw new WirebenchError(
            'unresolved-properties',
            `The WS-Security SAML token has property references nothing resolves: ${exprs.join(', ')}`,
            { details: { unresolved: exprs } },
          );
        }
        return result.text;
      },
      projectFile: async (path) => await this.samlTokenFile(path),
    });
  }

  /**
   * One SAML token file's text, from inside the open project's folder.
   *
   * @throws WssError `saml-token-file-missing` when no project is open, or the file is outside the
   * folder, missing or unreadable
   */
  private async samlTokenFile(path: string): Promise<string> {
    const missing = (message: string, cause?: unknown): WssError =>
      new WssError('saml-token-file-missing', message, {
        details: { file: path },
        ...(cause !== undefined ? { cause } : {}),
      });
    if (this.core.open === undefined) {
      throw missing(`The SAML token file "${path}" cannot be read: no project is open.`);
    }
    const dir = this.core.open.dir;
    const resolved = resolvePath(dir, path);
    if (!(await isInsideAny([dir], resolved))) {
      throw missing(`The SAML token file "${path}" resolves outside the project folder.`);
    }
    try {
      return await readFile(resolved, 'utf8');
    } catch (cause) {
      throw missing(`The SAML token file "${path}" could not be read.`, cause);
    }
  }

  /**
   * The WS-Security half of a send of `requestId`, or `undefined` when the request selects
   * neither an outgoing nor an incoming configuration. Async and secret-bearing, exactly like
   * {@link tlsFor}.
   *
   * A selected-but-missing configuration throws rather than sending an unsecured request: a
   * WS-Security send that quietly degrades is as bad as a mutual-TLS one that does.
   *
   * @param requestId the request about to be sent
   * @returns the configuration, the context and the request's WSS property overrides
   * @throws WirebenchError `wss-config-missing` when the project no longer has the configuration
   */
  /**
   * True when `requestId` selects an outgoing WS-Security configuration — synchronous and
   * secret-free, unlike {@link wssFor}, so `request.curl` can decide whether to note "WS-Security
   * is not included" without resolving a keystore just to check.
   */
  hasOutgoingWss(requestId: string): boolean {
    if (this.core.open === undefined) {
      return false;
    }
    const outgoingId = findRequest(this.core.open.project, requestId)?.request.wssOutgoingRef;
    return outgoingId !== undefined && outgoingId.length > 0;
  }

  /**
   * What the Auth inspector's policy panel judges (#58): the WS-SecurityPolicy the WSDL attaches to
   * the request's operation, the entries of the outgoing configuration the request selects (none
   * when it selects none, or one that no longer reads), and the URL a send goes to. `undefined`
   * when the operation carries no policy, or the definition has not loaded yet.
   */
  wssPolicyInputs(
    requestId: string,
  ): { policy: WssPolicyWire; entries: readonly WssEntry[]; endpoint?: string } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const policy = this.core.open.runtime
      .get(location.iface.id)
      ?.summary?.operations.find(
        (operation) =>
          operation.binding === location.operation.bindingName && operation.name === location.operation.name,
      )?.wssPolicy;
    if (policy === undefined) {
      return undefined;
    }
    const outgoingId = location.request.wssOutgoingRef;
    const entries = outgoingId === undefined ? [] : (this.wssOutgoingConfig(outgoingId)?.entries ?? []);
    const endpoint = this.core.resolveEndpointFor(this.core.open.project, location.iface, location.request).url;
    return { policy, entries, ...(endpoint !== undefined ? { endpoint } : {}) };
  }

  wssFor(requestId: string): Promise<SoapSendWss | undefined> {
    if (this.core.open === undefined) {
      return Promise.resolve(undefined);
    }
    const location = findRequest(this.core.open.project, requestId);
    const outgoingId = location?.request.wssOutgoingRef;
    const incomingId = location?.request.wssIncomingRef;
    const selected = (id: string | undefined): string | undefined =>
      id === undefined || id.length === 0 ? undefined : id;
    if (location === undefined || (selected(outgoingId) === undefined && selected(incomingId) === undefined)) {
      return Promise.resolve(undefined);
    }
    const missing = (configId: string): Promise<never> =>
      Promise.reject(
        new WirebenchError(
          'wss-config-missing',
          'This request selects a WS-Security configuration the project no longer has.',
          { details: { configId } },
        ),
      );
    const outgoingRef = selected(outgoingId);
    const outgoing = outgoingRef === undefined ? undefined : this.wssOutgoingConfig(outgoingRef);
    if (outgoingRef !== undefined && outgoing === undefined) {
      return missing(outgoingRef);
    }
    const incomingRef = selected(incomingId);
    const incoming = incomingRef === undefined ? undefined : this.wssIncomingConfig(incomingRef);
    if (incomingRef !== undefined && incoming === undefined) {
      return missing(incomingRef);
    }
    const properties = location.request.properties;
    return Promise.resolve({
      ...(outgoing !== undefined ? { outgoing } : {}),
      ...(incoming !== undefined ? { incoming } : {}),
      ctx: this.wssContext(),
      requestProperties: {
        ...(properties.wssPasswordType !== undefined ? { wssPasswordType: properties.wssPasswordType } : {}),
        ...(properties.wssTimeToLive !== undefined ? { wssTimeToLive: properties.wssTimeToLive } : {}),
      },
    });
  }

  /** The envelope a WS-Security editor action starts from: what the editor holds, else the saved one. */
  private envelopeFor(requestId: string, envelopeXml?: string): string {
    if (envelopeXml !== undefined) {
      return envelopeXml;
    }
    const location = this.core.open === undefined ? undefined : findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      throw new WirebenchError('not-found', `No request with id "${requestId}"`, { details: { requestId } });
    }
    return location.request.envelopeXml;
  }

  /**
   * The WSDL-derived default `wsa:Action` for a request's operation, as the import recorded it.
   * An interface that never hydrated (or an operation the current WSDL no longer exposes)
   * yields `''`, which the header builder treats as "no default action".
   */
  defaultWsaActionFor(requestId: string): string {
    if (this.core.open === undefined) {
      return '';
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return '';
    }
    const summary = this.core.open.runtime.get(location.iface.id)?.summary;
    return summary?.wsa?.defaultActionByOperation[`${location.operation.bindingName}|${location.operation.name}`] ?? '';
  }

  /**
   * The WS-Addressing half of a send of `requestId`, or `undefined` when the effective
   * configuration is disabled. Unlike {@link wssFor} this is synchronous and carries no secret.
   */
  wsaFor(requestId: string): { config: WsaConfig; defaultAction: string } | undefined {
    if (this.core.open === undefined) {
      return undefined;
    }
    const location = findRequest(this.core.open.project, requestId);
    if (location === undefined) {
      return undefined;
    }
    const config = effectiveWsa(location.iface.wsa, location.request.wsa);
    return config.enabled ? { config, defaultAction: this.defaultWsaActionFor(requestId) } : undefined;
  }

  /**
   * Bakes the request's effective WS-Addressing headers into an envelope — the editor action,
   * as opposed to the send path, which writes the same headers on their way to the wire.
   *
   * @param requestId the request whose configuration to use
   * @param envelopeXml the envelope to address; the saved one when omitted
   * @throws WirebenchError `wsa-disabled` when the effective configuration is off
   */
  insertWsaHeaders(requestId: string, envelopeXml?: string): string {
    const wsa = this.wsaFor(requestId);
    if (wsa === undefined) {
      throw new WirebenchError('wsa-disabled', 'WS-Addressing is not enabled for this request.', {
        details: { requestId },
      });
    }
    const location = this.core.open === undefined ? undefined : findRequest(this.core.open.project, requestId);
    const request = location?.request;
    const endpoint =
      this.core.open === undefined || location === undefined
        ? ''
        : (this.core.resolveEndpointFor(this.core.open.project, location.iface, location.request).url ?? '');
    return applyWsaHeaders(this.envelopeFor(requestId, envelopeXml), wsa.config, {
      endpoint,
      ...(request?.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      defaultAction: wsa.defaultAction,
      uuid: () => randomUUID(),
      envelopeVersion: request?.soapVersion ?? '1.1',
    });
  }

  /**
   * Strips every `wsa:*` header, of either version, from the request's envelope text.
   *
   * @param requestId the request whose envelope is being edited
   * @param envelopeXml the envelope to clean; the saved one when omitted
   */
  removeWsaHeadersFrom(requestId: string, envelopeXml?: string): string {
    return stripWsaHeaders(this.envelopeFor(requestId, envelopeXml));
  }

  /**
   * Applies the request's own outgoing configuration to an envelope, for the preview and the
   * "apply to editor" action. The caller redacts the result before it leaves main.
   *
   * @param requestId the request whose configuration to use
   * @param envelopeXml the envelope to secure; the saved one when omitted
   * @returns the secured envelope
   * @throws WirebenchError `wss-config-missing` when the request selects no (or an unknown) configuration
   */
  async previewOutgoingWss(requestId: string, envelopeXml?: string): Promise<string> {
    const wss = await this.wssFor(requestId);
    if (wss?.outgoing === undefined) {
      throw new WirebenchError('wss-config-missing', 'This request has no outgoing WS-Security configuration.', {
        details: { requestId },
      });
    }
    const { config, ctx } = this.previewIssuedTokens(requestId, wss.outgoing, wss.ctx);
    return await applyOutgoingWss(this.envelopeFor(requestId, envelopeXml), config, ctx, {
      ...(wss.requestProperties !== undefined ? { requestProperties: wss.requestProperties } : {}),
    });
  }

  /**
   * The configuration and context a preview applies, so that it never contacts a token service
   * (spec §4.1): an issued token the session has cached for this request is placed as a send would
   * place it, and any other becomes a placeholder assertion naming the service it comes from at send.
   * The caller redacts the result, so a cached assertion's signature is masked unless secrets show.
   */
  private previewIssuedTokens(
    requestId: string,
    config: WssOutgoingConfig,
    ctx: WssContext,
  ): { config: WssOutgoingConfig; ctx: WssContext } {
    if (!config.entries.some((entry) => entry.kind === 'issued-token')) {
      return { config, ctx };
    }
    const target = this.issuedTokenKeyTarget(requestId);
    const peek = (entry: WssIssuedTokenEntry) =>
      target === undefined ? undefined : this.core.issuedTokens?.peek(entry, target);
    const entries = config.entries.map((entry): WssEntry => {
      if (entry.kind !== 'issued-token' || peek(entry) !== undefined) return entry;
      return {
        kind: 'saml-token',
        source: 'xml',
        xml:
          '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_preview">' +
          `<!-- issued token: fetched from ${this.stsHostOf(entry)} at send --></saml2:Assertion>`,
        expandProperties: false,
      };
    });
    return {
      config: { ...config, entries },
      // Only cached tokens reach `get`: the placed one keeps its attached reference and proof key,
      // so a signature over it previews as the send signs it.
      ctx: createWssContext({
        ...ctx,
        issuedTokens: {
          get: (entry) => {
            const token = peek(entry);
            return token === undefined
              ? Promise.reject(new WssError('ws-trust-unavailable', 'Issued tokens are not fetched for a preview.'))
              : Promise.resolve(token);
          },
          peek,
        },
      }),
    };
  }

  /** The host of an issued-token entry's expanded STS URL, for the preview's placeholder. */
  private stsHostOf(entry: WssIssuedTokenEntry): string {
    try {
      const expanded = expand(entry.stsUrl, this.core.scopesFor()).text;
      // It goes inside an XML comment, which may not hold `--` (a punycode host has one).
      return new URL(expanded).hostname.split('--').join('- -');
    } catch {
      return 'the token service';
    }
  }

  /**
   * The cache-key half of the target a send of `requestId` fetches its issued tokens with: its
   * endpoint and expansion, built by the engine as the send builds them. `undefined` when the request
   * resolves no endpoint, so nothing can have been cached for it.
   */
  private issuedTokenKeyTarget(requestId: string): ReturnType<typeof soapIssuedTokenKeyTarget> | undefined {
    const located = this.issuedTokenContext(requestId, { getSecret: () => Promise.resolve(undefined) });
    if (located === undefined) return undefined;
    try {
      return soapIssuedTokenKeyTarget(located.selected, located.context);
    } catch {
      return undefined;
    }
  }

  /** A send of `requestId` as the engine sees one, with `host` lent: `undefined` for no such request. */
  private issuedTokenContext(
    requestId: string,
    host: SendHost,
  ): { selected: NonNullable<ReturnType<typeof soapItemFor>>; context: RunContext } | undefined {
    const located = this.core.runContextFor(requestId);
    const selected = located === undefined ? undefined : soapItemFor(located.project, requestId);
    if (located === undefined || selected === undefined) return undefined;
    return { selected, context: { ...located, overrides: {}, host } };
  }

  /**
   * One issued-token entry of an outgoing configuration, with the target and dependencies a send of
   * `requestId` (or, when absent, of the first request that selects the configuration) fetches its
   * token with: the request's endpoint and the active environment's expansion, mutual TLS from the
   * entry's own keystore with the preferred trust anchors, the app's proxy, and the keystores and
   * secrets the editor's WS-Security reads. The engine builds the target, as it does for a send, so
   * a token fetched here is the one a send finds.
   *
   * @throws WirebenchError `unknown-project` | `wss-config-missing` | `not-found` (no such request, or
   * the entry is not an issued token) | `ws-trust-no-request` | `endpoint-unresolved` | `keystore-missing`
   */
  async issuedTokenTarget(
    projectId: string,
    configId: string,
    entryIndex: number,
    requestId?: string,
    /** The getter a send of this project resolves secrets through; the keychain alone when absent. */
    getSecret?: GetSecret,
  ): Promise<ResolvedIssuedToken> {
    const open = this.core.open;
    if (open === undefined || open.project.id !== projectId) {
      throw new WirebenchError('unknown-project', `No open project with id "${projectId}"`, { details: { projectId } });
    }
    const config = this.wssOutgoingConfig(configId);
    if (config === undefined) {
      throw new WirebenchError('wss-config-missing', 'The project has no such outgoing WS-Security configuration.', {
        details: { configId },
      });
    }
    const entry = config.entries[entryIndex];
    if (entry?.kind !== 'issued-token') {
      throw new WirebenchError('not-found', 'That entry of the configuration is not an issued token.', {
        details: { configId, entryIndex },
      });
    }
    const chosen = requestId ?? this.firstRequestSelecting(open.project, configId);
    if (chosen === undefined) {
      throw new WirebenchError('ws-trust-no-request', 'Select this configuration on a request first.', {
        details: { configId },
      });
    }
    if (requestId !== undefined && findRequest(open.project, requestId)?.request.wssOutgoingRef !== configId) {
      throw new WirebenchError('ws-trust-no-request', 'This request does not select this configuration.', {
        details: { configId, requestId },
      });
    }
    const anchors = [...((await this.core.trustAnchors()) ?? []), ...extraTrustAnchors(this.core.hostState)];
    const located = this.issuedTokenContext(chosen, {
      getSecret: getSecret ?? (async (ref) => await this.core.secrets?.get(ref)),
      proxyFor: async (url) => {
        const proxy = await this.core.proxyFor(url);
        return proxy === undefined ? undefined : withoutUndefinedProxy(proxy);
      },
      tls: {
        ...(anchors.length > 0 ? { anchors } : {}),
        identityFor: async (keystoreId) => {
          const identity = await this.core.clientIdentityFor(keystoreId);
          return identity?.cert === undefined || identity.key === undefined
            ? undefined
            : { cert: identity.cert, key: identity.key };
        },
      },
      keystoreFor: async (keystoreId) => await this.core.keystoreFor(keystoreId),
    });
    if (located === undefined) {
      throw new WirebenchError('not-found', `No SOAP request with id "${chosen}"`, { details: { requestId: chosen } });
    }
    const { target, ctx, kerberosToken } = await soapIssuedTokenTarget(located.selected, located.context, entry);
    return { entry, target, deps: { ctx, kerberosToken } };
  }

  /** The first SOAP request, in project order, whose outgoing WS-Security is `configId`. */
  private firstRequestSelecting(project: Project, configId: string): string | undefined {
    for (const iface of soapInterfacesOf(project)) {
      for (const operation of iface.operations) {
        const request = operation.requests.find((candidate) => candidate.wssOutgoingRef === configId);
        if (request !== undefined) return request.id;
      }
    }
    return undefined;
  }

  /**
   * Applies one ad-hoc entry to an envelope — the "Add WSS Username Token…" / "Add
   * WS-Timestamp…" actions, which involve no stored configuration at all.
   *
   * @param requestId the request whose envelope is being edited
   * @param entry the single entry to write
   * @param envelopeXml the envelope to secure; the saved one when omitted
   * @returns the secured envelope
   */
  async insertWssEntry(requestId: string, entry: WssEntry, envelopeXml?: string): Promise<string> {
    const config: WssOutgoingConfig = {
      id: 'ad-hoc',
      name: 'Ad-hoc',
      mustUnderstand: false,
      entries: [entry],
    };
    return await applyOutgoingWss(this.envelopeFor(requestId, envelopeXml), config, this.wssContext());
  }

  /**
   * Strips the `wsse:Security` header the request's configuration writes (the ultimate
   * receiver's when it selects none).
   *
   * @param requestId the request whose envelope is being edited
   * @param envelopeXml the envelope to clean; the saved one when omitted
   * @returns the envelope without that header
   */
  removeOutgoingWssFrom(requestId: string, envelopeXml?: string): string {
    const configId =
      this.core.open === undefined ? undefined : findRequest(this.core.open.project, requestId)?.request.wssOutgoingRef;
    const actor = configId === undefined ? undefined : this.wssOutgoingConfig(configId)?.actor;
    const envelope = this.envelopeFor(requestId, envelopeXml);
    return actor === undefined ? removeOutgoingWss(envelope) : removeOutgoingWss(envelope, actor);
  }

  /**
   * Appends an attachment from bytes the renderer already holds — the drag-and-drop path.
   *
   * A dropped file's path is not evidence of anything (see {@link allowsAttachmentPath}), so a
   * drop never names one: the renderer sends what the browser sandbox handed it, and those
   * bytes go straight into `attachments/<sha256>`. A drop is therefore always a copy — there is
   * no path to reference — which is also why {@link MAX_DROPPED_ATTACHMENT_BYTES} caps it: the
   * bytes travel through IPC and are held in memory twice on the way.
   *
   * @param requestId the request to attach to
   * @param input the dropped file's name, its browser-sniffed media type (may be empty) and bytes
   * @returns the new attachment's id
   */
  async addAttachmentBytes(
    requestId: string,
    input: { readonly name: string; readonly contentType: string; readonly bytes: Uint8Array },
  ): Promise<string> {
    const open = this.core.require();
    if (input.bytes.byteLength > MAX_DROPPED_ATTACHMENT_BYTES) {
      throw new ProjectError(
        'attachment-too-large',
        `"${input.name}" is larger than the ${String(MAX_DROPPED_ATTACHMENT_BYTES / (1024 * 1024))} MiB drop limit`,
        { details: { name: input.name, size: input.bytes.byteLength, limit: MAX_DROPPED_ATTACHMENT_BYTES } },
      );
    }
    const name = sanitizeDroppedName(input.name);
    const contentType = input.contentType.trim().length > 0 ? input.contentType : contentTypeForPath(name);
    const { sha256, size } = await putAttachment(open.dir, input.bytes, {
      originalName: name,
      contentType,
    });
    const result = appendAttachment(open.project, requestId, {
      name,
      contentType,
      size,
      source: { kind: 'cache', sha256 },
    });
    open.project = result.project;
    this.core.markDirty();
    this.core.emitChanged();
    if (result.createdAttachmentId === undefined) {
      throw new ProjectError('not-found', 'The attachment was not appended');
    }
    return result.createdAttachmentId;
  }

  /**
   * Turns the path an `add-attachment` names into the bytes' size and their {@link AttachmentSource}:
   * copied into `attachments/<sha256>` when the change asks for it (so the project stays
   * self-contained and survives the original being moved), or referenced where it lies.
   *
   * The path arrives over IPC, so it is checked by {@link allowsAttachmentPath} *before* any
   * `stat` or `readFile`: without that, a renderer could name `~/.ssh/id_rsa` and have main
   * read it into the project cache — or, with `copyToCache: false`, ship it to whatever
   * endpoint the next send goes to.
   */
  async readAttachmentSource(
    projectDir: string,
    input: { path: string; copyToCache: boolean; contentType: string },
  ): Promise<{ size: number; source: AttachmentSource }> {
    // Relative against the project folder, matching `resolveAttachmentPath` and the inline-file
    // resolver, so all three agree on which file a given string means.
    const path = resolvePath(projectDir, input.path);
    if (!(await this.allowsAttachmentPath(projectDir, path))) {
      throw new ProjectError(
        'attachment-outside-project',
        `The file "${input.path}" is outside the project and was not picked through the Add dialog`,
        { details: { path: input.path } },
      );
    }
    if (!input.copyToCache) {
      const info = await stat(path);
      return { size: info.size, source: { kind: 'path', path } };
    }
    const bytes = await readFile(path);
    const { sha256, size } = await putAttachment(projectDir, new Uint8Array(bytes), {
      originalName: basename(path),
      contentType: input.contentType,
    });
    return { size, source: { kind: 'cache', sha256 } };
  }

  /**
   * Imports a WSDL into the open project: resolves it (refreshing the definition cache under
   * the new interface's folder), records its endpoints and operations, and generates one
   * `Request 1` per operation. Saves immediately, so an import is never lost to a crash.
   */
  async addInterface(input: {
    source: ImportSourceWire;
    /** `password` never appears here: the caller sends a `secretRef`, resolved just below. */
    auth?: { username: string; passwordRef: string } | { type: 'kerberos'; spn?: string | undefined };
    /** When true, the resolved auth (by ref, never plaintext) is saved onto the interface. */
    useForRequests?: boolean;
    token?: string;
  }): Promise<{ project: ProjectWire; interfaceId: string }> {
    const open = this.core.require();
    const interfaceId = generateId();
    // Every top-level slug, APIs' too: an interface sharing an API's slug makes the next load skip
    // that API (`api-slug-conflict`), and the save after it would delete its folder.
    const taken = takenApiSlugs(open.project);

    const importAuth: { username: string; password: string } | KerberosSendAuth | undefined =
      input.auth === undefined
        ? undefined
        : 'type' in input.auth
          ? kerberosImportAuth(input.auth.spn)
          : await this.basicImportAuth({
              type: 'basic',
              username: input.auth.username,
              passwordRef: input.auth.passwordRef,
            });

    // The interface's name (and therefore its slug) comes from the WSDL, which is only known
    // once the import has run — so the cache is written to a staging folder outside the project
    // and moved into place afterwards. Staged inside the project, a provisional folder that is
    // renamed a moment after it appears races the project watcher's scan of it (issue #150), and
    // is left behind in the user's folder (and their sync) by an import that fails.
    const staging = await mkdtemp(join(tmpdir(), 'wirebench-import-'));
    let summary: InterfaceSummary;
    let slug: string;
    try {
      const stagedCache = join(staging, 'definition');
      summary = await this.core.engine.importForProject(
        {
          interfaceId,
          source: input.source,
          cache: { dir: stagedCache, mode: 'refresh' },
          ...(importAuth !== undefined ? { auth: importAuth } : {}),
          ...(input.token !== undefined ? { token: input.token } : {}),
        },
        { onProgress: (event) => this.core.hooks.onProgress?.(event) },
      );
      slug = uniqueSlug(summary.name, taken);
      if (existsSync(stagedCache)) {
        // `mkdir` returns the first folder it had to create, if any: what a failed move removes again.
        const created = await mkdir(interfaceDir(open.dir, slug), { recursive: true });
        try {
          await moveDir(stagedCache, definitionCacheDir(open.dir, slug));
        } catch (error) {
          if (created !== undefined) {
            await rm(created, { recursive: true, force: true }).catch(() => undefined);
          }
          throw error;
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }

    const endpoints = endpointsFrom(summary);
    const savedAuth: SoapOwnerAuth | undefined =
      input.useForRequests !== true || input.auth === undefined
        ? undefined
        : 'type' in input.auth
          ? kerberosImportAuth(input.auth.spn)
          : { type: 'basic', username: input.auth.username, passwordRef: input.auth.passwordRef, preemptive: true };
    // A second import of the same service is told apart by its name: "Calculator (2)" (#727).
    const takenNames = new Set(soapInterfacesOf(open.project).map((existing) => existing.name));
    let interfaceName = summary.name;
    for (let n = 2; takenNames.has(interfaceName); n += 1) interfaceName = `${summary.name} (${String(n)})`;
    const iface: Interface = {
      ...createInterface(interfaceName, {
        id: interfaceId,
        slug,
        definitionUrl: summary.definitionUrl,
        targetNamespace: summary.targetNamespace,
        order: soapInterfacesOf(open.project).length,
        // The WSDL preference is the default for a newly imported interface; the Details
        // panel's "Cache definition" toggle is what changes it afterwards, per interface.
        cacheDefinition: this.core.prefs()?.wsdl.cacheDefinitions ?? true,
        endpoints,
        operations: operationsFrom(summary),
      }),
      ...(savedAuth !== undefined ? { auth: savedAuth } : {}),
      // A WSDL that declares WS-Addressing turns it on for the interface straight away: the
      // alternative is the user discovering the requirement from a runtime fault.
      wsa: {
        ...DEFAULT_WSA_CONFIG,
        enabled: summary.wsa?.enabled ?? false,
        version: summary.wsa?.version ?? '2005/08',
      },
    };

    open.project = {
      ...open.project,
      containers: { ...open.project.containers, soap: [...soapInterfacesOf(open.project), iface] },
    };
    open.runtime.set(interfaceId, { hydration: 'ready', summary });

    const generateOptions = generateOptionsFrom(this.core.prefs());
    for (const operation of summary.operations) {
      const generated = this.core.engine.generate({
        interfaceId,
        bindingName: operation.binding,
        operationName: operation.name,
        ...(generateOptions !== undefined ? { options: generateOptions } : {}),
      });
      open.project = addRequest(open.project, {
        interfaceId,
        bindingName: operation.binding,
        operationName: operation.name,
        // Named after the operation, with the binding when there are several, not "Request 1" (#726).
        name: generatedRequestName(operation, summary.operations),
        generated: {
          envelopeXml: generated.envelopeXml,
          soapVersion: generated.soapVersion,
          ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        },
      }).project;
    }

    open.dirty = true;
    await this.core.save({ reason: 'import' });
    return { project: this.core.snapshot() as ProjectWire, interfaceId };
  }

  /**
   * Imports a legacy single-XML SOAP project into the open project: resolves each interface from
   * the definition the file carried (writing it to the interface's definition cache, so the
   * project reopens offline), adds interfaces with their saved requests, environments and new
   * properties, writes the file's scripts under `imported-scripts/`, and saves once.
   *
   * A document the file holds no copy of is fetched over `http(s)` only, never from a `file:`
   * location, because the path would come from the imported file rather than from the user. An
   * interface that cannot be resolved is left out and reported, and the rest still import.
   */
  async importLegacyProject(input: {
    project: LegacyProject;
    token?: string;
  }): Promise<{ project: ProjectWire; report: LegacyImportReport; environmentNames: string[] }> {
    const open = this.core.require();
    // Every top-level slug, APIs' too: an interface sharing an API's slug makes the next load skip
    // that API (`api-slug-conflict`), and the save after it would delete its folder.
    const taken = takenApiSlugs(open.project);
    const network = this.core.engine.networkFetchDocument();
    const summaries = new Map<string, InterfaceSummary>();

    const resolved: ResolvedLegacyInterface[] = [];
    for (const legacy of input.project.interfaces) {
      const id = generateId();
      const slug = uniqueSlug(legacy.name, taken);
      taken.add(slug);
      const base = { legacy, id, slug };
      const root = definitionRootOf(legacy.cache, legacy.definitionUrl);
      if (root === undefined) {
        resolved.push({ ...base, resolved: false, problem: 'the project file names no definition for it.' });
        continue;
      }
      const fetchedFromNetwork: string[] = [];
      let refusedLocal: string | undefined;
      const fetchDocument = fetchDocumentFromCache(legacy.cache, {
        fallback: (location, signal) => {
          if (!/^https?:/i.test(location)) {
            refusedLocal = location;
            throw new ProjectError('legacy-local-definition', `${location} is not in the project file`, {
              details: { location },
            });
          }
          return network(location, signal);
        },
        onFallback: (location) => fetchedFromNetwork.push(location),
      });
      try {
        const summary = await this.core.engine.importForProject(
          {
            interfaceId: id,
            source: { kind: 'url', url: root },
            cache: { dir: definitionCacheDir(open.dir, slug), mode: 'refresh' },
            fetchDocument,
            ...(input.token !== undefined ? { token: input.token } : {}),
          },
          { onProgress: (event) => this.core.hooks.onProgress?.(event) },
        );
        summaries.set(id, summary);
        resolved.push({
          ...base,
          resolved: true,
          definitionUrl: summary.definitionUrl,
          targetNamespace: summary.targetNamespace,
          operations: summary.operations.map((operation) => ({
            bindingName: operation.binding,
            name: operation.name,
            soapVersion: operation.soapVersion,
            ...(operation.soapAction !== undefined ? { soapAction: operation.soapAction } : {}),
          })),
          fetchedFromNetwork,
        });
      } catch (error) {
        const problem =
          refusedLocal !== undefined
            ? `the project file holds no copy of ${refusedLocal}, and a local path it names is never read. Import that WSDL on its own.`
            : error instanceof Error
              ? error.message
              : String(error);
        resolved.push({ ...base, resolved: false, problem });
      }
    }

    const mapped = mapLegacyProject(input.project, resolved, {
      environmentNames: new Set(open.project.environments.map((environment) => environment.name)),
      environmentSlugs: new Set(open.project.environments.map((environment) => environment.slug)),
      propertyNames: new Set(Object.keys(open.project.properties)),
      firstInterfaceOrder: nextApiOrder(open.project),
      firstEnvironmentOrder: open.project.environments.length,
    });

    const cacheDefinition = this.core.prefs()?.wsdl.cacheDefinitions ?? true;
    const interfaces = mapped.interfaces.map((iface): Interface => {
      const summary = summaries.get(iface.id);
      if (summary !== undefined) {
        open.runtime.set(iface.id, { hydration: 'ready', summary });
      }
      return {
        ...iface,
        cacheDefinition,
        // As for a WSDL import: a definition that declares WS-Addressing turns it on for the interface.
        wsa: {
          ...DEFAULT_WSA_CONFIG,
          enabled: summary?.wsa?.enabled ?? false,
          version: summary?.wsa?.version ?? '2005/08',
        },
      };
    });

    const scripts = await this.core.writeImportedScripts(mapped.scripts);
    const scriptItems = [
      ...scripts.renamed.map(({ from, to }) => ({
        severity: 'info' as const,
        path: '',
        message: `A script already existed at ${from}, so this one was saved as ${to}.`,
      })),
      ...scripts.skipped.map((path) => ({
        severity: 'warning' as const,
        path: '',
        message: `The script ${path} would have been saved outside ${IMPORTED_SCRIPTS_DIR}/ and was not written.`,
      })),
    ];

    open.project = {
      ...open.project,
      ...(open.project.description === undefined && input.project.description !== undefined
        ? { description: input.project.description }
        : {}),
      properties: { ...open.project.properties, ...mapped.properties },
      containers: { ...open.project.containers, soap: [...soapInterfacesOf(open.project), ...interfaces] },
      environments: [...open.project.environments, ...mapped.environments],
    };
    open.dirty = true;
    await this.core.save({ reason: 'import' });
    return {
      project: this.core.snapshot() as ProjectWire,
      report: { ...mapped.report, items: [...mapped.report.items, ...scriptItems] },
      environmentNames: mapped.environments.map((environment) => environment.name),
    };
  }

  /** The open project's interface with `interfaceId`, or a `not-found` error. */
  private requireInterface(interfaceId: string): Interface {
    const open = this.core.require();
    const iface = soapInterfacesOf(open.project).find((candidate) => candidate.id === interfaceId);
    if (iface === undefined) {
      throw new ProjectError('not-found', `No interface with id "${interfaceId}"`, {
        details: { id: interfaceId },
      });
    }
    return iface;
  }

  /**
   * Turns the renderer's Update Definition source into an engine source.
   *
   * A `url` is taken as written (the engine fetches it); a `path` is only accepted when it is
   * inside the project folder or the user picked it through an Open dialog this session — the
   * same rule every other main-side file read follows, so a renderer can never name an
   * arbitrary file to read.
   */
  private async updateSource(source: DefinitionUpdateSource): Promise<ImportSourceWire> {
    if (source.kind === 'url') {
      return { kind: 'url', url: source.url };
    }
    const open = this.core.require();
    const path = resolvePath(open.dir, source.path);
    if (!(await allowsReadPath([open.dir], this.core.picks, path))) {
      throw new ProjectError('path-not-allowed', `"${source.path}" is outside the project and was not picked`, {
        details: { path: source.path },
      });
    }
    return { kind: 'file', path };
  }

  /**
   * What an interface's own auth resolves to for re-fetching its WSDL: Basic credentials, or a
   * Kerberos auth (its keychain secret is read only on Windows, and only when a username is set:
   * elsewhere an explicit account is refused anyway, so a reopen reads nothing for it). Any other
   * scheme resolves to no re-fetch credentials.
   */
  private async importAuthFor(
    iface: Interface,
  ): Promise<{ username: string; password: string } | KerberosSendAuth | undefined> {
    if (iface.auth?.type === 'kerberos') {
      const auth = process.platform === 'win32' ? iface.auth : withoutPasswordRef(iface.auth);
      const resolved = await resolveAuthConfig(this.core.hostState.redactor, auth, (ref) => this.core.getSecret(ref));
      return resolved?.type === 'kerberos' ? resolved : undefined;
    }
    return this.basicImportAuth(iface.auth !== undefined && isEndpointAuth(iface.auth) ? iface.auth : undefined);
  }

  /**
   * The auth an Update Definition fetch is given. A URL on another origin than the interface's
   * definition is a host the interface's credentials were not set up for: a Basic username and
   * password are not sent to it, and a Kerberos auth keeps its account but drops the SPN, so the
   * token targets the host that was typed (the SPN defaults to it) rather than the old service.
   */
  private async updateAuthFor(
    iface: Interface,
    source: DefinitionUpdateSource,
  ): Promise<{ username: string; password: string } | KerberosSendAuth | undefined> {
    const auth = await this.importAuthFor(iface);
    if (source.kind !== 'url' || auth === undefined || sameOrigin(iface.definitionUrl, source.url)) {
      return auth;
    }
    if ('type' in auth) {
      const withoutSpn: KerberosSendAuth = { ...auth };
      delete (withoutSpn as { spn?: string }).spn;
      return withoutSpn;
    }
    return undefined;
  }

  private async basicImportAuth(
    auth: EndpointAuth | undefined,
  ): Promise<{ username: string; password: string } | undefined> {
    const resolved =
      auth !== undefined ? await resolveEndpointAuth(auth, (ref) => this.core.getSecret(ref)) : undefined;
    return resolved?.username !== undefined && resolved.password !== undefined
      ? { username: resolved.username, password: resolved.password }
      : undefined;
  }

  /**
   * Previews an Update Definition: fetches `source` and diffs it against the definition the
   * interface is currently using. Nothing is stored, cached or changed — this is what the
   * dialog shows before the user commits.
   */
  async planDefinitionUpdate(interfaceId: string, source: DefinitionUpdateSource): Promise<UpdatePlanWire> {
    const iface = this.requireInterface(interfaceId);
    const current = this.core.engine.resultFor(interfaceId);
    const auth = await this.updateAuthFor(iface, source);
    const next = await this.core.engine.importPreview(await this.updateSource(source), auth);
    return toUpdatePlanWire(planUpdate(current, next));
  }

  /**
   * Applies an Update Definition: re-imports `source` (refreshing the interface's definition
   * cache, so a reopen sees the new WSDL offline), reconciles the project against it per
   * `options`, and saves — writing `<request>.xml.bak` backups first when asked.
   */
  async applyDefinitionUpdate(
    interfaceId: string,
    source: DefinitionUpdateSource,
    options: DefinitionUpdateOptions,
  ): Promise<Omit<ApplyUpdateWire, 'project'>> {
    const open = this.core.require();
    const iface = this.requireInterface(interfaceId);
    const previous = this.core.engine.resultFor(interfaceId);
    const auth = await this.updateAuthFor(iface, source);
    // Fetched into a scratch result only: nothing about the live `WsdlImportResult` or the
    // definition cache changes here. If the save below fails, the interface must look exactly
    // as it did before this call — see the fix1 finding on this method.
    const next = await this.core.engine.importPreview(await this.updateSource(source), auth);
    const plan = planUpdate(previous, next);
    const applied = applyUpdate(open.project, interfaceId, plan, next, options);

    const priorProject = open.project;
    const priorDirty = open.dirty;
    open.project = applied.project;
    open.dirty = true;
    let saveResult: ProjectSaveResult;
    try {
      // The backups must be copied from the bytes currently on disk, so they are handed to the
      // very save that overwrites them rather than written out of band afterwards.
      saveResult = await this.core.save({ reason: 'update-definition', backups: applied.backups });
    } catch (error) {
      // Roll the in-memory model back: the live `WsdlImportResult`/definition cache were never
      // touched, so undoing `open.project`/`open.dirty` is enough to leave everything as it
      // was before this call.
      open.project = priorProject;
      open.dirty = priorDirty;
      throw error;
    }

    // Only a successful save may make the new definition live.
    await writeDefinitionCache(next.bundle, definitionCacheDir(open.dir, iface.slug));
    const summary = this.core.engine.commitResult(interfaceId, next, next.bundle.root.location);
    open.runtime.set(interfaceId, { hydration: 'ready', summary });

    return {
      plan: toUpdatePlanWire(plan),
      requestsCreated: [...applied.requestsCreated],
      requestsRecreated: [...applied.requestsRecreated],
      requestsOrphaned: [...applied.requestsOrphaned],
      // The actual timestamped `.xml.bak` paths the save wrote, not the pre-timestamp names
      // `applyUpdate` requested — see `save.ts`'s timestamped-backup policy.
      backups: [...(saveResult.backups ?? [])],
    };
  }

  /** Writes the definition bundle of `interfaceId` into `dir`, returning the file names written. */
  async exportDefinitionTo(interfaceId: string, dir: string): Promise<string[]> {
    this.requireInterface(interfaceId);
    const result = await exportDefinition(this.core.engine.resultFor(interfaceId).bundle, dir);
    return result.files.map((file) => file.file);
  }

  /** Renders the documentation for `interfaceId`, titled with the interface's own name. */
  definitionDocs(interfaceId: string, format: 'html' | 'markdown'): string {
    const iface = this.requireInterface(interfaceId);
    return generateDocs(this.core.engine.resultFor(interfaceId), { format, title: iface.name });
  }

  /**
   * Re-imports every interface from its definition cache, one at a time so a project with
   * many interfaces does not open dozens of parallel resolves. A failure marks that interface
   * `failed` and adds a problem — it never fails the open.
   */
  private async hydrateAll(): Promise<void> {
    const open = this.core.open;
    if (open === undefined) {
      return;
    }
    for (const iface of soapInterfacesOf(open.project)) {
      if (this.core.open !== open) {
        return; // The project was closed or replaced while hydrating.
      }
      try {
        // The interface's own auth must be resolved for hydration exactly as it is for the
        // first import: a WSDL behind Basic or Kerberos auth is otherwise re-fetched anonymously
        // and the whole interface fails to hydrate on reopen. A token-scheme owner resolves to
        // no re-fetch credentials, same as `importAuthFor`.
        const importAuth = await this.importAuthFor(iface);
        const summary = await this.core.engine.importForProject({
          interfaceId: iface.id,
          source: { kind: 'url', url: iface.definitionUrl },
          cache: { dir: definitionCacheDir(open.dir, iface.slug), mode: 'prefer-cache' },
          ...(importAuth !== undefined ? { auth: importAuth } : {}),
        });
        open.runtime.set(iface.id, { hydration: 'ready', summary });
        this.core.hooks.onHydration?.({ interfaceId: iface.id, status: 'ready' });
      } catch (error) {
        const message = errorMessage(error);
        open.runtime.set(iface.id, { hydration: 'failed' });
        open.problems = [...open.problems, { code: 'hydration-failed', message, file: iface.slug }];
        this.core.hooks.onHydration?.({ interfaceId: iface.id, status: 'failed', message });
      }
      this.core.emitChanged();
    }
    // The Definition card's version and servers come from each AsyncAPI API's cached document.
    for (const api of wsApisOf(open.project)) {
      if (this.core.open !== open) {
        return;
      }
      if (api.definition?.kind === 'asyncapi' && api.definition.cache) {
        if (
          (await this.core
            .kind('websocket')
            .asyncApiContractFor(api.id)
            .catch(() => undefined)) !== undefined
        ) {
          this.core.emitChanged();
        }
      }
    }
  }
}
