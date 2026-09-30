/**
 * A fifth protocol, for tests only: `echo` answers a request with the request's own text. It is
 * registered beside the built-in protocols to prove that no core file has to know a protocol
 * (protocol modules spec §10). Its containers live in `project.extraContainers.echo`.
 *
 * This file holds the run half. `send` reaches no network.
 */
import type { Assertion, AssertionSubject } from '../../src/assert/model.js';
import { extraContainersOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { expand } from '../../src/project/properties.js';
import { defineProtocol } from '../../src/protocol/module.js';
import type { ProtocolRun } from '../../src/protocol/module.js';
import { scopesFor } from '../../src/run/context.js';
import { unresolvedError, withSecrets } from '../../src/run/send-helpers.js';
import type { RequestScripts } from '../../src/script/model.js';

/** A saved echo request: the text it sends is the text it gets back. */
export interface EchoRequest {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** May hold `${…}` property references and `${secret:name}` tokens. */
  readonly text: string;
  readonly assertions?: readonly Assertion[];
  readonly scripts?: RequestScripts;
}

/** An echo API: a flat list of requests. */
export interface EchoApi {
  readonly kind: 'echo';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly requests: readonly EchoRequest[];
}

/** One echo request selected for a run. */
export interface EchoSelected {
  readonly kind: 'echo';
  readonly path: string;
  readonly group: string;
  readonly api: EchoApi;
  readonly request: EchoRequest;
}

/** The project's echo APIs. */
export function echoApisOf(project: Project): readonly EchoApi[] {
  return extraContainersOf(project, 'echo') as readonly EchoApi[];
}

/** `project` with `apis` as its echo APIs. */
export function withEchoApis(project: Project, apis: readonly EchoApi[]): Project {
  return { ...project, extraContainers: { ...project.extraContainers, echo: apis } };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The echo as assertions see it: always `200`; JSON when the text is JSON, so a `match` can read it. */
function echoSubject(text: string): AssertionSubject {
  return {
    protocol: 'echo',
    status: 200,
    durationMs: 0,
    bodyText: text,
    bodyKind: isJson(text) ? 'json' : 'other',
  };
}

/** Echo's run facet. */
export const echoRun: ProtocolRun<EchoSelected> = {
  groups(project) {
    return echoApisOf(project).map((api) => ({
      order: api.order,
      name: api.name,
      candidates: api.requests.map((request) => ({
        item: { kind: 'echo' as const, path: `${api.name}/${request.name}`, group: api.name, api, request },
        diskPath: `apis/${api.slug}/requests/${request.slug}`,
      })),
    }));
  },

  whyNotRunnable() {
    return undefined;
  },

  async send(selected, scope) {
    const { context } = scope;
    const { text } = selected.request;
    const scopes = await withSecrets(text, scopesFor(context), context.getSecret);
    const expanded = expand(text, scopes);
    if (expanded.unresolved.length > 0) {
      throw unresolvedError(selected.path, expanded.unresolved);
    }
    const raw = bytes(expanded.text);
    return { subject: echoSubject(expanded.text), raw: { rawRequest: raw, rawResponse: raw } };
  },

  scriptTypes() {
    return Promise.resolve({ generated: '' });
  },

  secretNeeds() {
    return [];
  },
};

/** The echo protocol, to register beside the built-in ones. */
export const echoProtocol = defineProtocol({
  kind: 'echo',
  feature: { id: 'echo', title: 'Echo', default: true, stage: 'experimental', requires: [] },
  run: echoRun,
});

/** An echo API for a test project. */
export function echoApi(name: string, order: number, requests: readonly EchoRequest[]): EchoApi {
  return { kind: 'echo', id: `echo-${name.toLowerCase()}`, name, slug: name.toLowerCase(), order, requests };
}

/** An echo request for a test project. */
export function echoRequest(name: string, text: string, extra: Partial<EchoRequest> = {}): EchoRequest {
  return { id: `echo-req-${name.toLowerCase()}`, name, slug: name.toLowerCase(), text, ...extra };
}
