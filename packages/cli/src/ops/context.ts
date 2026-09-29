/**
 * One core, two faces (spec §2): each capability is an {@link Op}, run through {@link runOp} by a
 * CLI verb and by an MCP tool alike, so the input check and the redaction are the same for both.
 */
import type { z } from 'zod';
import { secretValuesIn } from '../env-secrets.js';
import { OpsError, toOpsError } from './errors.js';
import { redactError, redactResult } from './redact.js';

/** What `wirebench mcp` lets its tools do (spec §4). The CLI's own verbs run with {@link OPEN_GATES}. */
export interface Gates {
  readonly write: boolean;
  readonly send: boolean;
  /** `--env`: the environments `send` may use, by name, slug or id. Absent: any. */
  readonly environments?: readonly string[];
}

export const OPEN_GATES: Gates = { write: true, send: true };

/** Everything an op needs that is not its input. Built once per process (CLI verb) or per server. */
export interface OpsBase {
  readonly projectDir: string;
  /** The folder holding `<projectId>.jsonl`: the desktop's `<userData>/history`, or `--history-dir`. */
  readonly historyDir: string;
  /** Where secrets (`WIREBENCH_SECRET_<NAME>`) and proxies are read from. */
  readonly env: NodeJS.ProcessEnv;
  readonly gates: Gates;
  /** Tags the History entries a send writes. */
  readonly origin: 'cli' | 'mcp';
  /** A warning for the person running the process: stderr, never stdout. */
  readonly warn: (line: string) => void;
}

/** One call's context: the base, plus every secret value the call resolved, for the redaction step. */
export interface OpsContext extends OpsBase {
  readonly revealed: Set<string>;
}

export interface Op<S extends z.ZodType, R> {
  /** The MCP tool name and the key the CLI dispatches on. */
  readonly name: string;
  readonly title: string;
  /** What the op does, what it changes and which gate it needs; the MCP tool description. */
  readonly description: string;
  /** The single source for the CLI's argument check and the tool's `inputSchema`. */
  readonly input: S;
  run(input: z.output<S>, context: OpsContext): Promise<R>;
}

/** Any op, for a registry. `run` is a method, so its parameter is checked bivariantly. */
export type AnyOp = Op<z.ZodType, unknown>;

export function defineOp<S extends z.ZodType, R>(op: Op<S, R>): Op<S, R> {
  return op;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`)
    .join('; ');
}

/**
 * Checks `raw` against the op's schema, runs the op with a fresh secret set, and passes the result
 * or the error through the redaction step (spec §2.2) before anything leaves.
 *
 * The step shared here is the literal mask: every secret value the call revealed, wherever it appears
 * (and a URL quoted in an error). Pattern redaction (credential headers, URL credentials and parameters,
 * the WS-Security password, secret-keyed JSON and form values) is each op's own job, applied to what it
 * returns where it builds it, since only the op knows which text is a header, a URL or a body.
 *
 * @throws OpsError — always an `OpsError`, already redacted
 */
export async function runOp<S extends z.ZodType, R>(op: Op<S, R>, raw: unknown, base: OpsBase): Promise<R> {
  // Defence in depth for an agent: every secret the server was started with is masked in every
  // tool's result, whether or not this call resolved it (a saved `${#System#…}` reads the env too).
  const context: OpsContext = { ...base, revealed: new Set(base.origin === 'mcp' ? secretValuesIn(base.env) : []) };
  try {
    const parsed = op.input.safeParse(raw);
    if (!parsed.success) {
      throw new OpsError('invalid-input', describeIssues(parsed.error));
    }
    return redactResult(await op.run(parsed.data, context), context.revealed);
  } catch (error) {
    throw redactError(toOpsError(error), context.revealed);
  }
}
