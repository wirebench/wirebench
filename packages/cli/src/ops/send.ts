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
  secretNeedsOf,
} from '@wirebench/engine';
import type {
  AssertionResult,
  LocatedSecretNeed,
  RequestResult,
  RunContext,
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
import { cutText } from './cut.js';
import { OpsError } from './errors.js';
import { historyEntryFor, MAX_STORED_CHARS, redactedWsExchange } from './history-entry.js';
import { resolveItem } from './items.js';
import type { SendableItem } from './items.js';
import { historyFileFor } from './paths.js';
import { environmentFor, openProject } from './project.js';
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
function failure(result: RequestResult, needs: readonly LocatedSecretNeed[]): OpsError {
  const explained = explainMissingSecret(result, needs).error ?? {
    code: 'send-failed',
    message: `"${result.path}" got no response`,
  };
  return new OpsError(explained.code, explained.message, explained.details);
}

/** What every result carries, whatever the protocol. */
function commonOf(
  item: SendableItem,
  result: RequestResult,
  historyId: string | undefined,
): Pick<SendResult, 'item' | 'kind' | 'outcome' | 'unasserted' | 'durationMs' | 'assertions' | 'error' | 'historyId'> {
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
    'reply after the last one or the timeout, closes, and returns the frames. Needs --allow-send; --env limits ' +
    'the environments it may use.',
  input,
  async run(value, context): Promise<SendResult> {
    if (!context.gates.send) {
      throw new OpsError('send-not-allowed', 'This server was started without --allow-send; send needs it');
    }
    const opened = await openProject(context);
    const environment = environmentFor(opened, value.environment, context.gates.environments);
    const found = resolveItem(opened.project, value.item);
    const { project, workspace } = opened;
    // From the saved item, never from the override: the override adds no secret to read.
    const needs = secretNeedsOf([found], project, {}, workspace?.workspace);
    if (value.body !== undefined) {
      checkOverride(value.body);
    }
    const item = value.body === undefined ? found : withBody(found, value.body);
    const secrets = createEnvSecrets(needs, context.env);
    const tokens = new Set<string>();
    const known = (): string[] => [...secrets.values(), ...tokens];
    const proxyFor = proxyFromEnv(context.env);
    const captures = captureSourceFromEnv(context.env, { proxyFor });
    if (captures.token !== undefined) {
      tokens.add(captures.token);
    }
    const sandbox = createScriptSandbox();
    const checker = createScriptChecker();
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
      scripting: new RequestScripting({ sandbox, checker, onSecretValue: (secret) => tokens.add(secret) }),
    };
    try {
      const [scriptError] = await checkRunScripts([item], runContext);
      if (scriptError !== undefined) {
        throw scriptError;
      }
      const seen: { sent?: SentRequest } = {};
      const run = await runRequests([item], runContext, {
        captures: captures.source,
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
        throw failure(result, needs);
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
      if (exchange.kind === 'websocket' || item.kind === 'websocket') {
        if (exchange.kind !== 'websocket' || item.kind !== 'websocket') {
          throw new Error(`a ${item.kind} request came back with a ${exchange.kind} exchange`);
        }
        return wsResultOf(item, result, exchange, { text: mask, base64: maskBase64 }, historyId);
      }
      return resultOf(item, result, exchange, mask, historyId);
    } finally {
      for (const secret of known()) {
        context.revealed.add(secret);
      }
      await Promise.all([sandbox.dispose(), checker.dispose()]);
    }
  },
});
