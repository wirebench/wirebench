/**
 * Runs one op for a CLI verb (spec §5): with every gate open, since the user typed the command;
 * the result printed for a person or, with `--json`, exactly; an error as `code: message` on stderr.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CookieJar, jarCookieHost } from '@wirebench/engine';
import type { OpArgs, OpName } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { OPEN_GATES, runOp } from '../ops/context.js';
import type { Gates, OpsBase } from '../ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';
import { defaultHistoryDir } from '../ops/paths.js';
import type { SendResult } from '../ops/send.js';
import type { ValidateResult } from '../ops/validate.js';
import { exists } from '../workspace-lookup.js';
import { formatHuman } from './ops-output.js';

/** The base every op of this process runs on; warnings go to stderr, never stdout. */
export function opsBaseFor(
  options: {
    readonly project: string;
    readonly historyDir?: string | undefined;
    readonly gates: Gates;
    readonly origin: 'cli' | 'mcp';
  },
  io: Pick<CliIo, 'stderr' | 'env'>,
): OpsBase {
  return {
    projectDir: resolve(options.project),
    historyDir:
      options.historyDir !== undefined
        ? resolve(options.historyDir)
        : defaultHistoryDir(process.platform, io.env, homedir()),
    env: io.env,
    gates: options.gates,
    origin: options.origin,
    warn: (line) => io.stderr.write(`warning: ${line}\n`),
    // One jar per process: a `call` sends once, an MCP server shares it across its tools.
    cookies: jarCookieHost(new CookieJar()),
  };
}

async function readBodyFile(file: string): Promise<string> {
  const path = resolve(file);
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new OpsError('file-not-found', `No readable file at ${path}`, { file: path });
  }
}

function exitCodeOf(op: OpName, result: unknown): ExitCode {
  if (op === 'send') {
    const { outcome } = result as SendResult;
    return outcome === 'failed' ? ExitCode.AssertionFailed : outcome === 'errored' ? ExitCode.RunError : ExitCode.Ok;
  }
  if (op === 'validate') {
    // A body that could not be checked (`checked: false`) is not a failure.
    return (result as ValidateResult).valid === false ? ExitCode.AssertionFailed : ExitCode.Ok;
  }
  return ExitCode.Ok;
}

export async function opCommand(args: OpArgs, io: CliIo): Promise<ExitCode> {
  const base = opsBaseFor({ project: args.project, historyDir: args.historyDir, gates: OPEN_GATES, origin: 'cli' }, io);
  let triedAsHistoryId = false;
  try {
    let input: Record<string, unknown> = { ...args.input };
    if (args.source !== undefined) {
      const isFile = await exists(resolve(args.source));
      triedAsHistoryId = !isFile && /[/\\.]/.test(args.source);
      input = { ...input, ...(isFile ? { file: args.source } : { historyId: args.source }) };
    }
    if (args.bodyFile !== undefined) {
      input = { ...input, body: await readBodyFile(args.bodyFile) };
    }
    const result = await runOp(OPS[args.op], input, base);
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(args.op, result));
    return exitCodeOf(args.op, result);
  } catch (error) {
    let failure = toOpsError(error);
    if (triedAsHistoryId && failure.code === 'history-entry-not-found') {
      // A path-shaped argument that is no History id was most likely meant as a file.
      failure = new OpsError(failure.code, `${failure.message} (no file exists at that path either)`, failure.details);
    }
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}
