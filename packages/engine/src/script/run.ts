/**
 * Runs one pre-request or post-response script and checks what it hands back (spec §API, §Results).
 *
 * The caller supplies the request (and, after a send, the response) as a snapshot, the run's values,
 * the non-secret properties and only the secrets the request file lists. Each of those secrets is
 * reported to `onSecretValue` before the script runs, so whatever the script does with one — log it,
 * set it as a value, write it into the request — is masked downstream.
 */
import { z } from 'zod';
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { ResponseSnapshot } from '../protocols.js';
import { TRANSFER_NAME_PATTERN } from '../sequence/model.js';
import { applyRequestChanges } from './apply.js';
import { buildPrelude } from './api/prelude.js';
import { POSTMAN_LAYER } from './api/postman.js';
import { scriptingOf } from './lookup.js';
import {
  SCRIPT_OUTPUT_LIMITS,
  type ScriptApi,
  type ScriptErrorCode,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptTest,
  type ScriptValue,
} from './model.js';
import type { RequestScriptTypes } from './request-scripts.js';
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
  readonly request: RequestSnapshotBase;
  /**
   * Required for a post-response script. Any module's response snapshot; the built-in union is
   * named only so that a literal of one of its members type-checks.
   */
  readonly response?: ResponseSnapshot | ResponseSnapshotBase;
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
  /**
   * What the request's module put on its script types for typed views (`RequestScriptTypes.binding`).
   * For SOAP: the schema and the operation's elements, which give the script a typed `request.body`
   * and `response.body`. Without it the body is only reachable as `envelope`.
   */
  readonly binding?: unknown;
  /** Where the request's protocol is looked up; the built-in registry when absent. */
  readonly registry?: ProtocolRegistry;
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

/**
 * Runs one script. A request whose protocol has no scripting facet in the registry fails with
 * `script-unsupported`, and nothing runs.
 */
export async function runScript(input: ScriptRunInput): Promise<ScriptOutcome> {
  const empty = { tests: [], values: [], log: { lines: [], truncated: false } } as const;
  if (input.phase === 'post' && input.response === undefined) {
    throw new Error('runScript: a post-response script needs the response');
  }
  const scripting = scriptingOf(input.request.protocol, input.registry);
  if (scripting === undefined) {
    return {
      ok: false,
      error: {
        code: 'script-unsupported',
        message: `Requests of the "${input.request.protocol}" protocol cannot have scripts`,
      },
      ...empty,
    };
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

  // The views read only the binding; a script's generated types are the checker's business.
  const types: RequestScriptTypes = {
    generated: '',
    ...(input.binding !== undefined ? { binding: input.binding } : {}),
  };
  const request = scripting.views?.request(input.request, types) ?? input.request;
  const response =
    input.response === undefined ? undefined : (scripting.views?.response(input.response, types) ?? input.response);

  const result = await input.sandbox.run({
    prelude: buildPrelude(
      scripting,
      input.phase,
      input.api,
      input.layer ?? (input.api === 'postman' ? POSTMAN_LAYER : undefined),
    ),
    code,
    filename: input.filename,
    timeoutMs: input.timeoutMs ?? 0,
    input: {
      phase: input.phase,
      request,
      ...(response !== undefined ? { response } : {}),
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
    const applied = applyRequestChanges(scripting, request, output.request);
    if (!applied.ok) {
      return { ok: false, error: applied.error, tests, values, log: result.log };
    }
    const written = scripting.views?.writeBack(request, applied.request, types) ?? {
      ok: true as const,
      request: applied.request,
    };
    if (!written.ok) {
      return { ok: false, error: written.error, tests, values, log: result.log };
    }
    return { ok: true, request: written.request, tests, values, log: result.log };
  }
  return { ok: true, tests, values, log: result.log };
}
