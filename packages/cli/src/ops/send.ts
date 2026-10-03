/**
 * `send` (spec §2): one saved request, sent exactly as `wirebench run` sends it — the same
 * environment rules, `WIREBENCH_SECRET_*` secrets, scripts, assertions and callback captures —
 * then recorded in the desktop's History. Needs `--allow-send` under `wirebench mcp`.
 *
 * A WebSocket request is a run's too: the socket opens, the saved messages go out, a reply after the
 * last one (or the run timeout) ends it, and the frames come back as the session recorded them.
 */
import {
  appendHistory,
  checkRunScripts,
  createScriptChecker,
  createScriptSandbox,
  createSecretBytesMasker,
  createSecretMasker,
  historyWsOf,
  isWirebenchError,
  redactHeaders,
  redactUrl,
  RequestScripting,
  runRequests,
  readGoldenFile,
  secretNeedsOf,
} from '@wirebench/engine';
import type {
  AssertionResult,
  BaselineReport,
  CaptureSource,
  LocatedSecretNeed,
  RequestResult,
  RunContext,
  RunOptions,
  SelectedRequest,
  SentExchange,
  SentRequest,
  WsFrame,
} from '@wirebench/engine';
import { z } from 'zod';
import { createEnvSecrets } from '../env-secrets.js';
import { cliSendHost } from '../send-host.js';
import { proxyFromEnv } from '../proxy-env.js';
import { explainMissingSecret, knownSecretIn } from '../secret-advice.js';
import { captureSourceFromEnv } from '../server-captures.js';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { cutText } from './cut.js';
import { OpsError } from './errors.js';
import { historyEntryFor, MAX_STORED_CHARS, redactedWsExchange } from './history-entry.js';
import type { HistoryEntryInput } from './history-entry.js';
import { resolveItem } from './items.js';
import type { SendableItem } from './items.js';
import { historyFileFor } from './paths.js';
import { environmentFor, openProject } from './project.js';
import type { OpenedProject } from './project.js';
import { redactAssertions, redactBody, redactUrlsInText } from './redact.js';

export interface SendResult {
  readonly item: string;
  readonly kind: 'soap' | 'rest' | 'websocket';
  /** `failed`: an assertion failed. `errored`: an assertion or a script errored. */
  readonly outcome: 'passed' | 'failed' | 'errored';
  /** The request has no assertions of its own. */
  readonly unasserted: boolean;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly durationMs: number;
  /** Response headers, lower-cased, sensitive ones redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** A WebSocket request's: every text the server sent, in order, as a JSON array (what assertions read). */
  readonly body: string;
  readonly bodyTruncated: boolean;
  /**
   * A WebSocket request's frames both ways, masked as History stores them and capped as History caps
   * them; `framesTruncated` says some were left out.
   */
  readonly frames?: readonly WsFrame[];
  readonly framesTruncated?: boolean;
  readonly assertions: readonly AssertionResult[];
  /** `baseline: true` only: the comparison with the golden saved beside the request, masked (#218). */
  readonly baseline?: BaselineReport;
  readonly error?: { readonly code: string; readonly message: string };
  /** The History entry written; absent when History could not be written (a warning says why). */
  readonly historyId?: string;
}

const input = z.object({
  item: z
    .string()
    .min(1)
    .describe(
      'A saved SOAP, REST or WebSocket request: its path as operations lists it, or its name when only one has it',
    ),
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('The environment to send under, by name; required when the project defines any'),
  body: z
    .string()
    .optional()
    .describe(
      'Send this envelope (SOAP) or raw body (REST) instead of the saved one; nothing is saved. ' +
        'Not for a WebSocket request, which sends its saved messages. ' +
        "It is sent as written: ${…} placeholders are refused. The saved request's own body still expands as usual.",
    ),
  baseline: z
    .boolean()
    .optional()
    .describe(
      'Also compare the response body with the golden saved beside the request (<slug>.golden.yaml), ' +
        "by meaning, honouring the golden's ignore rules. A difference fails the send.",
    ),
});

/** The request with `body` in place of its saved envelope or body, for this send only. */
function withBody(item: SendableItem, body: string): SendableItem {
  if (item.kind === 'soap') {
    return { ...item, request: { ...item.request, envelopeXml: body } };
  }
  if (item.kind === 'websocket') {
    throw new OpsError(
      'invalid-input',
      `"${item.path}" is a WebSocket request; the body override replaces a SOAP envelope or a REST body only`,
      { item: item.path },
    );
  }
  const saved = item.request.body;
  if (saved.kind !== 'none' && saved.kind !== 'raw') {
    throw new OpsError(
      'invalid-input',
      `"${item.path}" has a ${saved.kind} body; the body override replaces a raw or JSON body only`,
      { item: item.path },
    );
  }
  return {
    ...item,
    request: {
      ...item.request,
      body: {
        kind: 'raw',
        language: saved.kind === 'raw' ? saved.language : 'json',
        ...(saved.kind === 'raw' && saved.contentType !== undefined ? { contentType: saved.contentType } : {}),
        text: body,
      },
    },
  };
}

/**
 * The override is sent as written. A `${…}` in it would expand against the server's own environment
 * (`${#System#NAME}` reads `process.env`) and its properties, so none is accepted.
 */
function checkOverride(body: string): void {
  if (body.includes('${')) {
    throw new OpsError(
      'invalid-input',
      'body: the body override is sent as written and may not contain ${…} placeholders',
    );
  }
}

/** The engine's refusal, with `wirebench run`'s advice for a secret the environment does not set. */
export function sendFailure(result: RequestResult, needs: readonly LocatedSecretNeed[]): OpsError {
  const explained = explainMissingSecret(result, needs).error ?? {
    code: 'send-failed',
    message: `"${result.path}" got no response`,
  };
  return new OpsError(explained.code, explained.message, explained.details);
}

/** What one send came back with: the run's result, the exchange, its maskers, and the History entry written. */
export interface RecordedSend {
  readonly result: RequestResult;
  readonly exchange: Exclude<SentExchange, { kind: 'grpc' }>;
  /** Masks every secret value the send resolved. */
  readonly mask: (text: string) => string;
  readonly maskBase64: (base64: string) => string;
  /** Absent when History could not be written (a warning says why). */
  readonly historyId?: string;
}

export interface SendAndRecordInput {
  readonly item: SendableItem;
  /** The item whose secrets the send reads: the saved one when `item` carries an override. Default: `item`. */
  readonly needsOf?: SendableItem;
  readonly opened: OpenedProject;
  readonly environment: { readonly id: string } | undefined;
  readonly context: OpsContext;
  /** Secret values known before the send (a capture token); every value the send resolves joins them. */
  readonly tokens?: Set<string>;
  readonly scripting?: RequestScripting;
  readonly captures?: CaptureSource;
  /** Runs under the run context before the send: `send`'s script check. */
  readonly before?: (runContext: RunContext) => Promise<void>;
  /** A caller's own refusal of a send that got no exchange, before the engine's. */
  readonly refuse?: (result: RequestResult) => OpsError | undefined;
  /** A temporary request's History names (#33). */
  readonly adHoc?: HistoryEntryInput['adHoc'];
  /** `send`'s golden comparison (#218); a contract tool's call never sets it. */
  readonly baseline?: RunOptions['baseline'];
}

/**
 * One item through `runRequests` as `wirebench run` sends it — `WIREBENCH_SECRET_*` secrets, the
 * environment, `onSent` for the exchange — then its History entry, written with `keepAtLeastCurrent`.
 * A busy or unwritable History warns and leaves `historyId` out. Every secret value the send resolved
 * is added to `context.revealed`, whether it succeeded or not. Shared by `send` and a contract tool's call.
 *
 * @throws OpsError — the caller's refusal, or the engine's (with `wirebench run`'s advice) when no exchange came back
 */
export async function sendAndRecord(input: SendAndRecordInput): Promise<RecordedSend> {
  const { item, opened, environment, context } = input;
  const { project, workspace } = opened;
  // From the saved item, never from an override: the override adds no secret to read.
  const needs = secretNeedsOf([input.needsOf ?? item], project, {}, workspace?.workspace);
  const secrets = createEnvSecrets(needs, context.env);
  const tokens = input.tokens ?? new Set<string>();
  const known = (): string[] => [...secrets.values(), ...tokens];
  const runContext: RunContext = {
    project,
    projectDir: context.projectDir,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(environment !== undefined ? { environmentId: environment.id } : {}),
    overrides: {},
    host: cliSendHost({
      getSecret: secrets.getSecret,
      env: context.env,
      onSecretValue: (secret) => tokens.add(secret),
    }),
    containsKnownSecret: (text) => knownSecretIn(text, known()),
    ...(input.scripting !== undefined ? { scripting: input.scripting } : {}),
  };
  try {
    await input.before?.(runContext);
    const seen: { sent?: SentRequest } = {};
    const run = await runRequests([item], runContext, {
      ...(input.captures !== undefined ? { captures: input.captures } : {}),
      ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
      onSent: (_item, sent) => {
        seen.sent = sent;
      },
    });
    const [result] = run.requests;
    const exchange = seen.sent?.exchange;
    if (result === undefined) {
      throw new Error('the run returned no result');
    }
    // A gRPC item never gets this far (`resolveItem` refuses it); the narrowing says so.
    if (exchange === undefined || exchange.kind === 'grpc') {
      throw input.refuse?.(result) ?? sendFailure(result, needs);
    }
    // Checked before History is written: a send reported as an error leaves no row.
    if (exchange.kind !== item.kind) {
      throw new Error(`a ${item.kind} request came back with a ${exchange.kind} exchange`);
    }
    const mask = createSecretMasker(known());
    const maskBase64 = createSecretBytesMasker(known());
    let historyId: string | undefined;
    try {
      const entry = historyEntryFor({
        item,
        exchange,
        projectId: project.id,
        origin: context.origin,
        durationMs: result.durationMs ?? 0,
        mask,
        maskBase64,
        ...(input.adHoc !== undefined ? { adHoc: input.adHoc } : {}),
      });
      // The desktop may keep more than the default cap: a send from here never drops a kept entry.
      await appendHistory(historyFileFor(context.historyDir, project.id), entry, { keepAtLeastCurrent: true });
      historyId = entry.id;
    } catch (error) {
      // The send happened; a busy or unwritable History must not hide its result.
      context.warn(
        `History not written: ${isWirebenchError(error) ? `${error.code}: ${error.message}` : String(error)}`,
      );
    }
    return { result, exchange, mask, maskBase64, ...(historyId !== undefined ? { historyId } : {}) };
  } finally {
    for (const secret of known()) {
      context.revealed.add(secret);
    }
  }
}

/**
 * The golden comparison and its assertion with every secret the send resolved masked (spec §4): a
 * response can echo a secret, and the changes carry response values.
 */
export function maskedBaseline(result: RequestResult, mask: (text: string) => string): RequestResult {
  const { baseline } = result;
  if (baseline === undefined) {
    return result;
  }
  return {
    ...result,
    baseline: {
      ...baseline,
      ...(baseline.error !== undefined ? { error: mask(baseline.error) } : {}),
      ...(baseline.changes !== undefined
        ? {
            changes: baseline.changes.map((change) => ({
              ...change,
              ...(change.expected !== undefined ? { expected: mask(change.expected) } : {}),
              ...(change.actual !== undefined ? { actual: mask(change.actual) } : {}),
            })),
          }
        : {}),
    },
    assertions: result.assertions.map((assertion) =>
      assertion.type === 'baseline'
        ? {
            ...assertion,
            label: mask(assertion.label),
            ...(assertion.message !== undefined ? { message: mask(assertion.message) } : {}),
          }
        : assertion,
    ),
  };
}

/** What every result carries, whatever the protocol. */
function commonOf(
  item: SendableItem,
  result: RequestResult,
  historyId: string | undefined,
): Pick<
  SendResult,
  'item' | 'kind' | 'outcome' | 'unasserted' | 'durationMs' | 'assertions' | 'baseline' | 'error' | 'historyId'
> {
  return {
    item: item.path,
    kind: item.kind,
    outcome: result.outcome === 'passed' || result.outcome === 'failed' ? result.outcome : 'errored',
    unasserted: result.unasserted,
    durationMs: result.durationMs ?? 0,
    // `run` shows the values an assertion read; an op shows a credential's as the marker.
    assertions: redactAssertions(
      result.assertions,
      'assertions' in item.request ? (item.request.assertions ?? []) : [],
    ),
    ...(result.baseline !== undefined ? { baseline: result.baseline } : {}),
    ...(result.error !== undefined
      ? { error: { code: result.error.code, message: redactUrlsInText(result.error.message) } }
      : {}),
    ...(historyId !== undefined ? { historyId } : {}),
  };
}

/** A WebSocket session's result: the handshake's answer, the texts received, and the frames. */
function wsResultOf(
  item: Extract<SendableItem, { kind: 'websocket' }>,
  result: RequestResult,
  exchange: Extract<SentExchange, { kind: 'websocket' }>,
  masks: { readonly text: (text: string) => string; readonly base64: (base64: string) => string },
  historyId?: string,
): SendResult {
  const ws = exchange.ws;
  const redacted = redactedWsExchange(item, ws, masks);
  const capped = historyWsOf(redacted);
  // Masked before it is cut, as a body is.
  const body = masks.text(
    JSON.stringify(
      ws.frames
        .filter((frame) => frame.direction === 'received' && frame.opcode === 'text')
        .map((frame) => frame.text ?? ''),
    ),
  );
  return {
    ...commonOf(item, result, historyId),
    method: 'GET',
    url: redacted.url,
    status: ws.handshake.status ?? 0,
    statusText: ws.handshake.statusText ?? '',
    headers: redacted.handshake.responseHeaders ?? {},
    body: cutText(body, MAX_STORED_CHARS),
    bodyTruncated: body.length > MAX_STORED_CHARS,
    frames: capped.frames,
    framesTruncated: capped.truncated === true,
  };
}

function resultOf(
  item: Exclude<SendableItem, { kind: 'websocket' }>,
  result: RequestResult,
  exchange: Extract<SentExchange, { kind: 'soap' | 'rest' }>,
  mask: (text: string) => string,
  historyId?: string,
): SendResult {
  const http = exchange.kind === 'soap' ? exchange.soap.http : exchange.rest;
  const text =
    exchange.kind === 'soap'
      ? (exchange.soap.response?.envelopeXml ?? new TextDecoder().decode(http.body))
      : exchange.rest.text;
  // Masked before it is cut: a secret across the cut would otherwise leave its first characters.
  const body = mask(redactBody(text, http.headers['content-type']));
  return {
    ...commonOf(item, result, historyId),
    method: http.request.method,
    url: redactUrl(http.request.url, { show: false }),
    status: http.status,
    statusText: http.statusText,
    headers: redactHeaders(http.headers, { show: false }),
    body: cutText(body, MAX_STORED_CHARS),
    bodyTruncated: http.truncated || body.length > MAX_STORED_CHARS,
  };
}

export const sendOp = defineOp({
  name: 'send',
  title: 'Send a saved request',
  description:
    'Sends one saved SOAP, REST or WebSocket request as wirebench run does (environment, secrets from ' +
    'WIREBENCH_SECRET_* variables, scripts, assertions), returns the response and the assertion results, and ' +
    "records the send in the desktop's History. A WebSocket request sends its saved messages, waits for a " +
    'reply after the last one, closes, and returns the frames; a session with no reply before the timeout ' +
    'fails with timeout, with no frames and no History. Needs --allow-send; --env limits the environments ' +
    'it may use. With baseline: true it also compares the response with the golden saved beside the request: ' +
    'a difference fails the send, and a request with no golden reports baseline status missing.',
  input,
  async run(value, context): Promise<SendResult> {
    if (!context.gates.send) {
      throw new OpsError('send-not-allowed', 'This server was started without --allow-send; send needs it');
    }
    const opened = await openProject(context);
    const environment = environmentFor(opened, value.environment, context.gates.environments);
    const found = resolveItem(opened.project, value.item);
    if (value.body !== undefined) {
      checkOverride(value.body);
    }
    const item = value.body === undefined ? found : withBody(found, value.body);
    const tokens = new Set<string>();
    const proxyFor = proxyFromEnv(context.env);
    const captures = captureSourceFromEnv(context.env, { proxyFor });
    if (captures.token !== undefined) {
      tokens.add(captures.token);
    }
    const sandbox = createScriptSandbox();
    const checker = createScriptChecker();
    try {
      const {
        result: sent,
        exchange,
        mask,
        maskBase64,
        historyId,
      } = await sendAndRecord({
        item,
        needsOf: found,
        opened,
        environment,
        context,
        tokens,
        scripting: new RequestScripting({ sandbox, checker, onSecretValue: (secret) => tokens.add(secret) }),
        captures: captures.source,
        ...(value.baseline === true
          ? {
              baseline: {
                source: (selected: SelectedRequest) =>
                  readGoldenFile(context.projectDir, opened.project, selected.request.id),
                require: false,
              },
            }
          : {}),
        before: async (runContext) => {
          const [scriptError] = await checkRunScripts([item], runContext);
          if (scriptError !== undefined) {
            throw scriptError;
          }
        },
      });
      const result = maskedBaseline(sent, mask);
      if (exchange.kind === 'websocket' && item.kind === 'websocket') {
        return wsResultOf(item, result, exchange, { text: mask, base64: maskBase64 }, historyId);
      }
      if (exchange.kind === 'websocket' || item.kind === 'websocket') {
        throw new Error(`a ${item.kind} request came back with a ${exchange.kind} exchange`);
      }
      return resultOf(item, result, exchange, mask, historyId);
    } finally {
      await Promise.all([sandbox.dispose(), checker.dispose()]);
    }
  },
});
