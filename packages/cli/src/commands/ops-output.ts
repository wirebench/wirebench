/** The op results as a person reads them: short lines, bodies as they are. `--json` bypasses this. */
import type { OpName } from '../args.js';
import type { GenerateResult } from '../ops/generate.js';
import type { HistoryDiffResult, HistoryListResult } from '../ops/history.js';
import type { ImportOutput } from '../ops/import.js';
import type { OperationsResult } from '../ops/operations.js';
import type { QueryOutput } from '../ops/query.js';
import type { SendResult } from '../ops/send.js';
import type { ValidateResult } from '../ops/validate.js';

const lines = (...parts: readonly string[]): string => `${parts.join('\n')}\n`;

const headerLines = (headers: Readonly<Record<string, string>>): string[] =>
  Object.entries(headers).map(([name, value]) => `${name}: ${value}`);

function importText(result: ImportOutput): string {
  return lines(
    ...result.added.map(
      (item) =>
        `added ${item.kind === 'soap' ? 'interface' : 'API'} ${item.name}: ${String(item.operations)} operations, ${String(item.requests)} requests`,
    ),
    ...result.problems.map(
      (problem) =>
        `problem: ${problem.code}: ${problem.message}${problem.where !== undefined ? ` (${problem.where})` : ''}`,
    ),
  );
}

function operationsText(result: OperationsResult): string {
  const out: string[] = [];
  for (const row of result.operations) {
    const detail =
      row.kind === 'soap' ? (row.soapAction ?? '') : row.kind === 'rest' ? (row.operationId ?? '') : row.url;
    out.push(detail.length > 0 ? `${row.ref}  (${detail})` : row.ref);
    out.push(...row.items.map((item) => `  ${item}`));
  }
  out.push(...result.notes.map((note) => `note: ${note}`));
  return out.length === 0 ? lines('no operations') : lines(...out);
}

function generateText(result: GenerateResult): string {
  if (result.kind === 'soap') {
    return lines(
      `Content-Type: ${result.contentType}`,
      ...headerLines(result.headers),
      '',
      result.body,
      ...result.problems.map((problem) => `problem: ${problem}`),
    );
  }
  return lines(
    `${result.method} ${result.path}`,
    ...headerLines(result.headers),
    ...(result.body !== undefined ? ['', result.body] : []),
    ...(result.note !== undefined ? [`note: ${result.note}`] : []),
  );
}

/** A WebSocket frame as one line: `>` sent, `<` received. */
function frameLine(frame: NonNullable<SendResult['frames']>[number]): string {
  const arrow = frame.direction === 'sent' ? '>' : '<';
  if (frame.close !== undefined) {
    return `${arrow} close ${String(frame.close.code)}${frame.close.reason.length > 0 ? ` ${frame.close.reason}` : ''}`;
  }
  if (frame.text !== undefined) return `${arrow} ${frame.text}`;
  return `${arrow} (${frame.opcode}, ${String(frame.size)} bytes)`;
}

function sendText(result: SendResult): string {
  const mark = (outcome: string): string => (outcome === 'passed' ? 'ok  ' : outcome === 'failed' ? 'FAIL' : 'ERR ');
  return lines(
    `${result.outcome.toUpperCase()}  ${result.method} ${result.url} -> ${String(result.status)} ${result.statusText} (${String(result.durationMs)} ms)`,
    ...(result.unasserted ? ['  (no assertions)'] : []),
    ...result.assertions.map(
      (assertion) =>
        `  ${mark(assertion.outcome)} ${assertion.label}${assertion.message !== undefined ? `: ${assertion.message}` : ''}`,
    ),
    ...(result.error !== undefined ? [`  error: ${result.error.code}: ${result.error.message}`] : []),
    '',
    ...headerLines(result.headers),
    '',
    ...(result.frames !== undefined
      ? [
          ...result.frames.map(frameLine),
          ...(result.framesTruncated === true ? ['(frames cut: some were left out)'] : []),
        ]
      : [result.body, ...(result.bodyTruncated ? ['(body truncated)'] : [])]),
    ...(result.historyId !== undefined ? ['', `history: ${result.historyId}`] : []),
  );
}

function validateText(result: ValidateResult): string {
  const verdict =
    result.kind === 'rest' && !result.checked ? `not checked: ${result.contract}` : result.valid ? 'valid' : 'invalid';
  const head = `${verdict}  ${result.operation} (${result.direction}${result.kind === 'rest' ? `, ${String(result.status)}, ${result.contract}` : ''})`;
  return lines(
    head,
    ...result.problems.map((problem) => {
      const at = problem.line !== undefined ? `${String(problem.line)}:${String(problem.column ?? 0)} ` : '';
      const where = problem.path !== undefined ? ` at ${problem.path}` : '';
      return `  ${problem.severity} ${at}${problem.code}: ${problem.message}${where}`;
    }),
    ...(result.kind === 'rest' ? result.notes.map((note) => `  note: ${note}`) : []),
    ...(result.truncated ? [`(problems cut at ${String(result.problems.length)}; there are more)`] : []),
  );
}

function queryText(result: QueryOutput): string {
  const cut = result.truncated ? ['(output truncated: results were left out or cut at a size cap)'] : [];
  return lines(...(result.results.length === 0 ? ['(no results)'] : result.results), ...cut);
}

function historyListText(result: HistoryListResult): string {
  if (result.entries.length === 0) {
    return lines('no History entries');
  }
  return lines(
    ...result.entries.map(
      (row) =>
        `${row.id}  ${row.at}  ${row.status !== undefined ? String(row.status) : '---'}  ${String(row.durationMs)} ms  ${row.item}`,
    ),
    ...(result.total > result.entries.length ? [`${String(result.total - result.entries.length)} more`] : []),
  );
}

function historyDiffText(result: HistoryDiffResult): string {
  return lines(
    `${result.format}: ${String(result.changes.length)} changes${result.ignored > 0 ? ` (${String(result.ignored)} ignored)` : ''}`,
    ...(result.error !== undefined ? [`note: ${result.error}`] : []),
    ...result.changes.map((change) => {
      if (change.kind === 'added') return `+ ${change.path}: ${change.actual ?? ''}`;
      if (change.kind === 'removed') return `- ${change.path}: ${change.expected ?? ''}`;
      return `~ ${change.path}: ${change.expected ?? ''} -> ${change.actual ?? ''}`;
    }),
    ...(result.truncated ? ['(output cut at 256 KiB)'] : []),
  );
}

export function formatHuman(op: OpName, result: unknown): string {
  switch (op) {
    case 'import':
      return importText(result as ImportOutput);
    case 'operations':
      return operationsText(result as OperationsResult);
    case 'generate':
      return generateText(result as GenerateResult);
    case 'send':
      return sendText(result as SendResult);
    case 'validate':
      return validateText(result as ValidateResult);
    case 'query':
      return queryText(result as QueryOutput);
    case 'history_list':
      return historyListText(result as HistoryListResult);
    case 'history_diff':
      return historyDiffText(result as HistoryDiffResult);
  }
}
