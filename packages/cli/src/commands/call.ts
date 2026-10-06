/**
 * `wirebench call` (#33 spec §7): one contract operation from the terminal, through the same core as
 * its MCP tool. Not gated, as `send` from the terminal is not: the person typing it allowed it.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CallArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { callOp, findContractTool } from '../ops/call.js';
import type { CallResult } from '../ops/call.js';
import { OPEN_GATES, runOp } from '../ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';
import { isRecord } from '../ops/records.js';
import { opsBaseFor } from './ops.js';

async function readArgs(text: string | undefined): Promise<Record<string, unknown>> {
  if (text === undefined) {
    return {};
  }
  let json = text;
  if (text.startsWith('@')) {
    const path = resolve(text.slice(1));
    try {
      json = await readFile(path, 'utf8');
    } catch {
      throw new OpsError('file-not-found', `No readable file at ${path}`, { file: path });
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new OpsError('invalid-input', `--args is not JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new OpsError('invalid-input', '--args must be a JSON object');
  }
  return parsed;
}

function callText(result: CallResult): string {
  const out = [`${String(result.status)} ${result.statusText} (${String(Math.round(result.durationMs))} ms)`];
  if (result.fault !== undefined) {
    out.push(`fault: ${result.fault.code}: ${result.fault.reason}`);
    if (result.fault.detail !== undefined) {
      out.push(
        typeof result.fault.detail === 'string' ? result.fault.detail : JSON.stringify(result.fault.detail, null, 2),
      );
    }
  }
  if (result.result !== undefined) {
    out.push(JSON.stringify(result.result, null, 2));
  }
  if (result.body !== undefined) {
    out.push(result.body);
  }
  out.push(...result.notes.map((note) => `note: ${note}`));
  if (result.historyId !== undefined) {
    out.push(`history: ${result.historyId}`);
  }
  return `${out.join('\n')}\n`;
}

export async function callCommand(args: CallArgs, io: CliIo): Promise<ExitCode> {
  const base = opsBaseFor(
    {
      project: args.project,
      historyDir: args.historyDir,
      gates: OPEN_GATES,
      origin: 'cli',
      secretSources: args.secretSources,
    },
    io,
  );
  try {
    const { project } = await openProject(base);
    const tool = await findContractTool(project, base.projectDir, args.operation);
    if (args.schema) {
      io.stdout.write(`${JSON.stringify(tool.inputSchema, null, 2)}\n`);
      return ExitCode.Ok;
    }
    const given = await readArgs(args.args);
    const callArgs = args.environment !== undefined ? { ...given, [tool.environmentKey]: args.environment } : given;
    const result = await runOp(callOp, { tool: tool.name, ref: tool.ref, args: callArgs }, base);
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : callText(result));
    return ExitCode.Ok;
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}
