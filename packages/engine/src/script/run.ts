/**
 * Runs one pre-request or post-response script and checks what it hands back (spec §API, §Results).
 *
 * The caller supplies the request (and, after a send, the response) as a snapshot, the run's values,
 * the non-secret properties and only the secrets the request file lists. Each of those secrets is
 * reported to `onSecretValue` before the script runs, so whatever the script does with one — log it,
 * set it as a value, write it into the request — is masked downstream.
 */
import { z } from 'zod';
import { TRANSFER_NAME_PATTERN } from '../sequence/model.js';
import { applyRequestChanges } from './apply.js';
import { buildPrelude } from './api/prelude.js';
import {
  SCRIPT_OUTPUT_LIMITS,
  type RequestSnapshot,
  type ResponseSnapshot,
  type ScriptApi,
  type ScriptErrorCode,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptTest,
  type ScriptValue,
} from './model.js';
import type { ScriptSandbox } from './sandbox/host.js';
import type { SandboxError } from './sandbox/model.js';
import { StripError, stripTypes } from './strip.js';

export interface ScriptRunInput {
  readonly sandbox: ScriptSandbox;
  readonly phase: ScriptPhase;
  readonly api: ScriptApi;
  /** The script as written: TypeScript for the `wirebench` API, JavaScript for `postman`. */
  readonly source: string;
  /** The script's file name, which errors are reported against. */
  readonly filename: string;
  readonly timeoutMs?: number;
  /** For a pre-request script, the request it may change; for a post-response one, what was sent. */
  readonly request: RequestSnapshot;
  /** Required for a post-response script. */
  readonly response?: ResponseSnapshot;
  /** The run's values so far (spec §Values). */
  readonly vars: Readonly<Record<string, string>>;
  /** Resolved properties, secrets excluded. */
  readonly props: Readonly<Record<string, string>>;
  /** The values of the secrets `scripts.secrets` lists, and no others. */
  readonly secrets: Readonly<Record<string, string>>;
  /** The request's name, for `pm.info.requestName`. */
  readonly requestName: string;
  /** An extra layer run after the API and before the script (the Postman one, spec §Postman). */
  readonly layer?: string;
  /** Called with each secret value before the script runs, so it is masked wherever it lands. */
  readonly onSecretValue?: (value: string) => void;
}

/** A rule's error, raised in the sandbox by name (`api/prelude.ts`), mapped to its code. */
const CODE_BY_ERROR_NAME: Readonly<Record<string, ScriptErrorCode>> = {
  ScriptSecretDenied: 'script-secret-denied',
  ScriptValueInvalid: 'script-value-invalid',
  ScriptUnsupported: 'script-unsupported',
};

const outputSchema = z.object({
  tests: z
    .array(z.object({ name: z.string(), passed: z.boolean(), message: z.string().optional() }))
    .max(SCRIPT_OUTPUT_LIMITS.tests),
  values: z
    .array(
      z.object({
        name: z.string().regex(TRANSFER_NAME_PATTERN),
        value: z.string().refine((v) => Buffer.byteLength(v, 'utf8') <= SCRIPT_OUTPUT_LIMITS.valueBytes),
        secret: z.boolean(),
      }),
    )
    .max(SCRIPT_OUTPUT_LIMITS.values),
  request: z.unknown().optional(),
});

type Output = z.infer<typeof outputSchema>;

function failureOf(error: SandboxError): ScriptFailure {
  if (error.code === 'script-error') {
    const name = /^(\w+):/.exec(error.message)?.[1];
    const code = name !== undefined ? CODE_BY_ERROR_NAME[name] : undefined;
    if (code !== undefined) {
      return { ...error, code, message: error.message.slice((name ?? '').length + 1).trim() };
    }
  }
  return error;
}

function readOutput(output: unknown): Output | undefined {
  const parsed = outputSchema.safeParse(output);
  return parsed.success ? parsed.data : undefined;
}

const cleanTests = (tests: Output['tests']): ScriptTest[] =>
  tests.map((t) => ({ name: t.name, passed: t.passed, ...(t.message !== undefined ? { message: t.message } : {}) }));

export async function runScript(input: ScriptRunInput): Promise<ScriptOutcome> {
  const empty = { tests: [], values: [], log: { lines: [], truncated: false } } as const;
  if (input.phase === 'post' && input.response === undefined) {
    throw new Error('runScript: a post-response script needs the response');
  }

  let code: string;
  try {
    code = input.api === 'wirebench' ? stripTypes(input.source) : input.source;
  } catch (error) {
    return {
      ok: false,
      error: { code: 'script-syntax-error', message: error instanceof StripError ? error.message : String(error) },
      ...empty,
    };
  }

  for (const value of Object.values(input.secrets)) {
    input.onSecretValue?.(value);
  }

  const result = await input.sandbox.run({
    prelude: buildPrelude(input.request.protocol, input.phase, input.api, input.layer),
    code,
    filename: input.filename,
    timeoutMs: input.timeoutMs ?? 0,
    input: {
      phase: input.phase,
      request: input.request,
      ...(input.response !== undefined ? { response: input.response } : {}),
      vars: input.vars,
      props: input.props,
      secrets: input.secrets,
      info: { requestName: input.requestName },
    },
  });

  const output = readOutput(result.ok ? result.output : result.output);
  const tests: readonly ScriptTest[] = output !== undefined ? cleanTests(output.tests) : [];
  const values: readonly ScriptValue[] = output?.values ?? [];

  if (!result.ok) {
    return { ok: false, error: failureOf(result.error), tests, values, log: result.log };
  }
  if (output === undefined) {
    return {
      ok: false,
      error: { code: 'script-error', message: 'The script handed back something the engine cannot read' },
      ...empty,
      log: result.log,
    };
  }
  if (input.phase === 'pre') {
    const applied = applyRequestChanges(input.request, output.request);
    if (!applied.ok) {
      return { ok: false, error: applied.error, tests, values, log: result.log };
    }
    return { ok: true, request: applied.request, tests, values, log: result.log };
  }
  return { ok: true, tests, values, log: result.log };
}
