/**
 * `wirebench mock check` (#325): checks every stub of the selected mocks against the contract — the
 * status, the Content-Type and the body, by the checks a received response gets — without serving.
 * stdout carries the report, as text or one JSON object per mock; warnings and errors go to stderr.
 */
import { checkMockStubs, isWirebenchError } from '@wirebench/engine';
import type { MockProblem, MockStubCheck } from '@wirebench/engine';
import type { MockCheckArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { loadMockProject, selectMocks } from './mock.js';

/** Where a problem sits: `status`, `header Content-Type`, `body /items/0`. */
function placeOf(problem: MockProblem): string {
  const where = [problem.in ?? 'body', problem.name, problem.path].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  const position = problem.line === undefined ? '' : ` ${String(problem.line)}:${String(problem.column ?? 1)}`;
  return `${where.join(' ')}${position}`;
}

function report(name: string, result: MockStubCheck): string {
  const { checked, findings } = result;
  const count = `${String(checked)} stub${checked === 1 ? '' : 's'}`;
  if (findings.length === 0) return `${name}: ${count} conform to the contract\n`;
  const lines = [`${name}: ${String(findings.length)} of ${count} do not conform to the contract`];
  for (const finding of findings) {
    lines.push(`  ${finding.operationName} › ${finding.responseName} (${String(finding.status)})`);
    for (const problem of finding.problems) lines.push(`    ${placeOf(problem)}: ${problem.message}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function mockCheckCommand(args: MockCheckArgs, io: CliIo): Promise<ExitCode> {
  const project = await loadMockProject(args.path, io);
  if (typeof project === 'number') return project;
  let code: ExitCode = ExitCode.Ok;
  for (const mock of selectMocks(project, args.mocks)) {
    let result: MockStubCheck;
    try {
      result = await checkMockStubs({ project, root: args.path, mockId: mock.id });
    } catch (error) {
      if (!isWirebenchError(error)) throw error;
      io.stderr.write(`${mock.name}: ${error.code}: ${error.message}\n`);
      code = ExitCode.RunError;
      continue;
    }
    io.stdout.write(
      args.json
        ? `${JSON.stringify({ mockId: mock.id, mock: mock.name, checked: result.checked, findings: result.findings })}\n`
        : report(mock.name, result),
    );
    if (result.findings.length > 0 && code === ExitCode.Ok) code = ExitCode.AssertionFailed;
  }
  return code;
}
