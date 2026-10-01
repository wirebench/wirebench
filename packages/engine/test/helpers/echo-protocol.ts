/**
 * A fifth protocol, for tests only: `echo` answers a request with the request's own text. It is
 * registered beside the built-in protocols to prove that no core file has to know a protocol
 * (protocol modules spec §10). Its containers live in `project.extraContainers.echo`.
 *
 * This file holds all three facets. `send` reaches no network.
 */
import { join } from 'node:path';
import { z } from 'zod';
import type { Assertion, AssertionSubject } from '../../src/assert/model.js';
import { readFileIfExists, readdirIfExists } from '../../src/project/fs.js';
import { readYaml } from '../../src/project/load-helpers.js';
import { extraContainersOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../../src/project/paths.js';
import { expand } from '../../src/project/properties.js';
import { nonEmpty, parseFile } from '../../src/project/schema-parts.js';
import { stringifyYaml } from '../../src/project/yaml.js';
import { defineProtocol } from '../../src/protocol/module.js';
import type { ProtocolRun, ProtocolScripting, ProtocolStorage, RunScope } from '../../src/protocol/module.js';
import { scopesFor } from '../../src/run/context.js';
import type { SentRequest } from '../../src/run/run.js';
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

/** An echo request as a script sees it. */
export interface EchoRequestSnapshot {
  readonly protocol: 'echo';
  readonly text: string;
}

/** An echo as a script sees it. */
export interface EchoResponseSnapshot {
  readonly protocol: 'echo';
  readonly text: string;
  readonly durationMs: number;
}

const ECHO_PRE = `
declare const request: { text: string };
`;

const ECHO_POST = `
declare const request: { readonly text: string };
declare const response: { readonly text: string; readonly durationMs: number };
`;

/** Runs inside the common prelude's closure: `input`, `define`, `state` and `deepFreeze` are its. */
const ECHO_PRELUDE = String.raw`
const echoRequest = (snapshot, writable) => {
  const data = { text: snapshot.text };
  const request = Object.freeze({
    get text() { return data.text; },
    set text(value) {
      if (!writable) throw new TypeError('The text of a sent request cannot be changed');
      data.text = String(value);
    },
  });
  const snapshotOf = () => ({ protocol: 'echo', text: data.text });
  return { request, snapshotOf };
};

if (input.phase === 'pre') {
  const built = echoRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', echoRequest(input.request, false).request);
  define('response', deepFreeze({ text: input.response.text, durationMs: input.response.durationMs }));
}
`;

/** Echo's scripting facet: one text, which is also every place a secret reference could be. */
export const echoScripting: ProtocolScripting<EchoRequestSnapshot, EchoResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? ECHO_PRE : ECHO_POST),
  reference: () => [
    { title: 'Echo: pre-request', declarations: ECHO_PRE },
    { title: 'Echo: post-response', declarations: ECHO_POST },
  ],
  prelude: () => ECHO_PRELUDE,
  requestSchema: z.object({ protocol: z.literal('echo'), text: z.string() }),
  inspect: (snapshot) => ({ destination: '', fixed: null, pairs: [], lines: [], texts: [snapshot.text] }),
};

/** One echo without scripts: what `send` was before it ran scripts. */
async function echoPlain(selected: EchoSelected, scope: RunScope): Promise<SentRequest> {
  const { context } = scope;
  const { text } = selected.request;
  const scopes = await withSecrets(text, scopesFor(context), context.host.getSecret);
  const expanded = expand(text, scopes);
  if (expanded.unresolved.length > 0) {
    throw unresolvedError(selected.path, expanded.unresolved);
  }
  const raw = bytes(expanded.text);
  return { subject: echoSubject(expanded.text), raw: { rawRequest: raw, rawResponse: raw } };
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

  async send(selected, scope, scripts) {
    if (scripts === undefined) return echoPlain(selected, scope);
    // Every `${secret:…}` goes behind a placeholder before the script sees the text, and comes back
    // as its value after it, as the built-in protocols do it.
    const hidden = selected.request.text.replace(/\$\{secret:([^}]+)\}/g, (_whole, name: string) =>
      scripts.placeholders.placeholderFor(name),
    );
    const before: EchoRequestSnapshot = { protocol: 'echo', text: hidden };
    const sent = await scripts.session.pre(before);
    const restored = await scripts.placeholders.restore({ text: sent.text }, scope.context.host.getSecret);
    const echoed = await echoPlain({ ...selected, request: { ...selected.request, text: restored.text } }, scope);
    const response: EchoResponseSnapshot = {
      protocol: 'echo',
      text: echoed.subject.bodyText,
      durationMs: echoed.subject.durationMs,
    };
    return { ...echoed, script: await scripts.session.post(sent, response) };
  },

  scriptTypes() {
    return Promise.resolve({ generated: '' });
  },

  secretNeeds() {
    return [];
  },
};

const echoScriptsFileSchema = z.looseObject({
  api: z.enum(['wirebench', 'postman']),
  enabled: z.boolean(),
  secrets: z.array(z.string()),
  pre: z.string().optional(),
  post: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const echoApiFileSchema = z.looseObject({
  kind: z.literal('echo'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
});

const echoRequestFileSchema = z.looseObject({
  kind: z.literal('echo'),
  id: nonEmpty,
  name: z.string(),
  text: z.string(),
  scripts: echoScriptsFileSchema.optional(),
});

function scriptsFromFile(file: z.infer<typeof echoScriptsFileSchema>): RequestScripts {
  return {
    api: file.api,
    enabled: file.enabled,
    secrets: file.secrets,
    ...(file.pre !== undefined ? { pre: { text: file.pre } } : {}),
    ...(file.post !== undefined ? { post: { text: file.post } } : {}),
    ...(file.timeoutMs !== undefined ? { timeoutMs: file.timeoutMs } : {}),
  };
}

function scriptsToFile(scripts: RequestScripts): Record<string, unknown> {
  return {
    api: scripts.api,
    enabled: scripts.enabled,
    secrets: scripts.secrets,
    ...(scripts.pre !== undefined ? { pre: scripts.pre.text } : {}),
    ...(scripts.post !== undefined ? { post: scripts.post.text } : {}),
    ...(scripts.timeoutMs !== undefined ? { timeoutMs: scripts.timeoutMs } : {}),
  };
}

/**
 * How the echo protocol is stored: `apis/<slug>/api.yaml` with `kind: echo`, and one
 * `requests/<slug>.request.yaml` per request holding its text and, inline, its scripts. Its
 * containers have no list of their own on `Project`, so they are kept in `extraContainers.echo`.
 * Assertions are not stored: the run tests build those requests in memory.
 */
export const echoStorage: ProtocolStorage<EchoApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const base = `${APIS_DIR}/${slug}`;
    const api = parseFile(echoApiFileSchema, document, `${base}/${API_FILE}`);
    const requests: EchoRequest[] = [];
    const entries = await readdirIfExists(ctx.fs, join(ctx.root, APIS_DIR, slug, REQUESTS_DIR));
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile || !entry.name.endsWith(REQUEST_SUFFIX)) {
        continue;
      }
      const relative = `${base}/${REQUESTS_DIR}/${entry.name}`;
      const parsed = parseFile(echoRequestFileSchema, await readYaml(ctx.fs, ctx.root, relative), relative);
      requests.push({
        id: parsed.id,
        name: parsed.name,
        slug: entry.name.slice(0, -REQUEST_SUFFIX.length),
        text: parsed.text,
        ...(parsed.scripts !== undefined ? { scripts: scriptsFromFile(parsed.scripts) } : {}),
      });
    }
    return { kind: 'echo', id: api.id, name: api.name, slug, order: api.order, requests };
  },

  files(api) {
    const files = new Map<string, string>();
    assertPathSegment(api.slug);
    const base = `${APIS_DIR}/${api.slug}`;
    files.set(`${base}/${API_FILE}`, stringifyYaml({ kind: api.kind, id: api.id, name: api.name, order: api.order }));
    for (const request of api.requests) {
      assertPathSegment(request.slug);
      files.set(
        `${base}/${REQUESTS_DIR}/${request.slug}${REQUEST_SUFFIX}`,
        stringifyYaml({
          kind: 'echo',
          id: request.id,
          name: request.name,
          text: request.text,
          ...(request.scripts !== undefined ? { scripts: scriptsToFile(request.scripts) } : {}),
        }),
      );
    }
    return files;
  },

  async managed(fs, root, slug) {
    const base = `${APIS_DIR}/${slug}`;
    const managed: string[] = [];
    if ((await readFileIfExists(fs, join(root, APIS_DIR, slug, API_FILE))) !== undefined) {
      managed.push(`${base}/${API_FILE}`);
    }
    for (const entry of await readdirIfExists(fs, join(root, APIS_DIR, slug, REQUESTS_DIR))) {
      if (entry.isFile && entry.name.endsWith(REQUEST_SUFFIX)) {
        managed.push(`${base}/${REQUESTS_DIR}/${entry.name}`);
      }
    }
    return managed;
  },

  containers: (project) => extraContainersOf(project, 'echo') as readonly EchoApi[],
  withContainers: (project, containers) => ({
    ...project,
    extraContainers: { ...project.extraContainers, echo: containers },
  }),
};

/** The echo protocol, to register beside the built-in ones. */
export const echoProtocol = defineProtocol({
  kind: 'echo',
  feature: { id: 'echo', title: 'Echo', default: true, stage: 'experimental', requires: [] },
  storage: echoStorage,
  run: echoRun,
  scripting: echoScripting,
});

/** An echo API for a test project. */
export function echoApi(name: string, order: number, requests: readonly EchoRequest[]): EchoApi {
  return { kind: 'echo', id: `echo-${name.toLowerCase()}`, name, slug: name.toLowerCase(), order, requests };
}

/** An echo request for a test project. */
export function echoRequest(name: string, text: string, extra: Partial<EchoRequest> = {}): EchoRequest {
  return { id: `echo-req-${name.toLowerCase()}`, name, slug: name.toLowerCase(), text, ...extra };
}
