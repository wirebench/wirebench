/**
 * `send` (spec §2): one saved request, sent exactly as `wirebench run` sends it — the same
 * environment rules, `WIREBENCH_SECRET_*` secrets, scripts, assertions and callback captures —
 * then recorded in the desktop's History. Needs `--allow-send` under `wirebench mcp`.
 */
import {
  appendHistory,
  checkRunScripts,
  createScriptChecker,
  createScriptSandbox,
  createSecretMasker,
  envVariablesFor,
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
} from '@wirebench/engine';
import { z } from 'zod';
import { createEnvSecrets } from '../env-secrets.js';
import { proxyFromEnv } from '../proxy-env.js';
import { captureSourceFromEnv } from '../server-captures.js';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { historyEntryFor, MAX_STORED_CHARS } from './history-entry.js';
import { resolveItem } from './items.js';
import type { SendableItem } from './items.js';
import { historyFileFor } from './paths.js';
import { environmentFor, openProject } from './project.js';
import { redactBody } from './redact.js';

export interface SendResult {
  readonly item: string;
  readonly kind: 'soap' | 'rest';
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
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly assertions: readonly AssertionResult[];
  readonly error?: { readonly code: string; readonly message: string };
  /** The History entry written; absent when History could not be written (a warning says why). */
  readonly historyId?: string;
}

const input = z.object({
  item: z
    .string()
    .min(1)
    .describe('A saved SOAP or REST request: its path as operations lists it, or its name when only one has it'),
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('The environment to send under, by name; required when the project defines any'),
  body: z
    .string()
    .optional()
    .describe('Send this envelope (SOAP) or raw body (REST) instead of the saved one; nothing is saved'),
});

/** The request with `body` in place of its saved envelope or body, for this send only. */
function withBody(item: SendableItem, body: string): SendableItem {
  if (item.kind === 'soap') {
    return { ...item, request: { ...item.request, envelopeXml: body } };
  }
  const saved = item.request.body;
  const language = saved.kind === 'raw' ? saved.language : 'json';
  return {
    ...item,
    request: {
      ...item.request,
      body: {
        kind: 'raw',
        language,
        ...(saved.kind === 'raw' && saved.contentType !== undefined ? { contentType: saved.contentType } : {}),
        text: body,
      },
    },
  };
}

function containsAny(value: string, known: readonly string[]): boolean {
  return known.some((secret) => secret.length >= 4 && value.includes(secret));
}

/** The engine's refusal, with `wirebench run`'s advice for a secret the environment does not set. */
function failure(result: RequestResult, needs: readonly LocatedSecretNeed[]): OpsError {
  const error = result.error ?? { code: 'send-failed', message: `"${result.path}" got no response` };
  const ref = error.details?.['ref'];
  if (error.code === 'secret-missing' && typeof ref === 'string') {
    const [first, ...rest] = envVariablesFor(needs.find((need) => need.ref === ref) ?? { ref });
    const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : '';
    return new OpsError(error.code, `Set ${first ?? ''}${alternatives} to send "${result.path}".`, error.details);
  }
  return new OpsError(error.code, error.message, error.details);
}

function resultOf(item: SendableItem, result: RequestResult, exchange: SentExchange, historyId?: string): SendResult {
  const http = exchange.kind === 'soap' ? exchange.soap.http : exchange.rest;
  const text =
    exchange.kind === 'soap'
      ? (exchange.soap.response?.envelopeXml ?? new TextDecoder().decode(http.body))
      : exchange.rest.text;
  const body = redactBody(text, http.headers['content-type']);
  return {
    item: item.path,
    kind: item.kind,
    outcome: result.outcome === 'passed' || result.outcome === 'failed' ? result.outcome : 'errored',
    unasserted: result.unasserted,
    method: http.request.method,
    url: redactUrl(http.request.url, { show: false }),
    status: http.status,
    statusText: http.statusText,
    durationMs: result.durationMs ?? 0,
    headers: redactHeaders(http.headers, { show: false }),
    body: body.length > MAX_STORED_CHARS ? body.slice(0, MAX_STORED_CHARS) : body,
    bodyTruncated: http.truncated || body.length > MAX_STORED_CHARS,
    assertions: result.assertions,
    ...(result.error !== undefined ? { error: { code: result.error.code, message: result.error.message } } : {}),
    ...(historyId !== undefined ? { historyId } : {}),
  };
}

export const sendOp = defineOp({
  name: 'send',
  title: 'Send a saved request',
  description:
    'Sends one saved SOAP or REST request as wirebench run does (environment, secrets from WIREBENCH_SECRET_* ' +
    'variables, scripts, assertions), returns the response and the assertion results, and records the send ' +
    "in the desktop's History. Needs --allow-send; --env limits the environments it may use.",
  input,
  async run(value, context): Promise<SendResult> {
    if (!context.gates.send) {
      throw new OpsError('send-not-allowed', 'This server was started without --allow-send; send needs it');
    }
    const opened = await openProject(context);
    const environment = environmentFor(opened, value.environment, context.gates.environments);
    const found = resolveItem(opened.project, value.item);
    const item = value.body === undefined ? found : withBody(found, value.body);
    const { project, workspace } = opened;

    const needs = secretNeedsOf([item], project, {}, workspace?.workspace);
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
      getSecret: secrets.getSecret,
      proxyFor,
      onSecretValue: (secret) => tokens.add(secret),
      containsKnownSecret: (text) => containsAny(text, known()),
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
      if (exchange === undefined) {
        throw failure(result, needs);
      }
      let historyId: string | undefined;
      try {
        const entry = historyEntryFor({
          item,
          exchange,
          projectId: project.id,
          origin: context.origin,
          durationMs: result.durationMs ?? 0,
          mask: createSecretMasker(known()),
        });
        await appendHistory(historyFileFor(context.historyDir, project.id), entry);
        historyId = entry.id;
      } catch (error) {
        // The send happened; a busy or unwritable History must not hide its result.
        context.warn(
          `History not written: ${isWirebenchError(error) ? `${error.code}: ${error.message}` : String(error)}`,
        );
      }
      return resultOf(item, result, exchange, historyId);
    } finally {
      for (const secret of known()) {
        context.revealed.add(secret);
      }
      await Promise.all([sandbox.dispose(), checker.dispose()]);
    }
  },
});
