/**
 * What a run supplies around the saved requests it sends, and the property scopes they expand
 * against. Apart from the run's own files so a protocol module can take a `RunContext` without
 * importing the run loop.
 */
import type { HttpExchange, HttpRequest, ProxyOptions } from '../http/types.js';
import { resolveScopes } from '../project/environments.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { RequestScripting } from '../script/request-scripts.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { GetSecret } from '../secrets/resolve.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import type { RunTokenSource } from './oauth2-token.js';
import type { SelectedRequest } from './select.js';

/**
 * The workspace a project is run inside, and the slug its manifest addresses the project by (the
 * first half of a workspace environment's `<projectSlug>/<interfaceSlug>` endpoint key).
 */
export interface RunWorkspace {
  readonly workspace: Workspace;
  readonly projectSlug: string;
}

/** Everything a run supplies around the saved requests it sends. */
export interface RunContext {
  readonly project: Project;
  /** The project folder: keystores, attachments and file bodies are read from inside it only. */
  readonly projectDir: string;
  /**
   * The environment the run resolves under. Inside a workspace it is a *workspace* environment's
   * id, as it is in the app: the project's own environments apply only through the one linked to
   * it by slug.
   */
  readonly environmentId?: string;
  /**
   * The workspace the project sits inside. Its properties become the `${#Workspace#…}` scope, and
   * its environment (with the linked project one laid over it) the `${…}` shorthand's.
   */
  readonly workspace?: RunWorkspace;
  /** `--var` overrides, laid over the environment's properties. */
  readonly overrides: PropertyMap;
  readonly getSecret: GetSecret;
  readonly timeoutMs?: number;
  readonly insecure?: boolean;
  readonly proxyFor?: (url: string) => ProxyOptions | undefined;
  readonly signal?: AbortSignal;
  /**
   * The WSDL-derived default `wsa:Action` for a SOAP request, as the app takes it from the
   * interface's imported definition. Absent (or returning `''`) when no definition is at hand:
   * an explicit `wsa:Action` or the request's SOAPAction then still applies.
   */
  readonly defaultWsaActionFor?: (selected: Extract<SelectedRequest, { kind: 'soap' }>) => string;
  /** Told every OAuth2 access token the run obtains, so the host can mask it in all it prints. */
  readonly onSecretValue?: (value: string) => void;
  /** Sends an OAuth2 token request; the engine's `sendHttp` by default. A test seam. */
  readonly fetchToken?: (request: HttpRequest) => Promise<HttpExchange>;
  /**
   * The run's OAuth2 token cache. `runRequests` creates one per run so every request behind a
   * configuration shares a token; a send outside a run gets a fresh source.
   */
  readonly tokenSource?: RunTokenSource;
  /** A sequence step's `${#Sequence#…}` values, from the responses of the steps before it. */
  readonly sequence?: PropertyMap;
  /**
   * Set for a request with a pre-request script: every `${secret:…}` in the request's text becomes
   * one of these placeholders, and the script's host puts the values back after it (#63).
   */
  readonly secretPlaceholders?: SecretPlaceholders;
  /**
   * Runs requests' scripts (#63). A run without it refuses a request whose scripts are switched on,
   * rather than send it without them.
   */
  readonly scripting?: RequestScripting;
  /** True when a value holds a credential the run knows; such a script value is treated as secret. */
  readonly containsKnownSecret?: (value: string) => boolean;
  /**
   * The protocol modules this run dispatches through, with their feature switches. Absent: the
   * built-in four with every feature on (`defaultRegistry()`).
   */
  readonly registry?: ProtocolRegistry;
}

/** The property scopes a request of this run expands against, secrets not yet added. */
export function scopesFor(context: RunContext): PropertyScopes {
  const { project, environmentId, workspace } = context;
  const scopes =
    workspace === undefined
      ? resolveScopes(project, environmentId, {}, process.env)
      : resolveWorkspaceScopes({
          workspace: withActiveEnvironment(workspace.workspace, environmentId),
          project,
          globals: {},
          system: process.env,
        });
  return {
    ...scopes,
    env: { ...(scopes.env ?? {}), ...context.overrides },
    // A sequence step's `${#Sequence#…}` values: literal, explicit-only and guarded (ADR-0015).
    ...(context.sequence !== undefined ? { sequence: context.sequence } : {}),
  };
}
