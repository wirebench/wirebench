import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/exit-codes.js';
import { OPS_HELP_TEXT, VERB_HELP } from '../../src/args-ops.js';
import type { OpName } from '../../src/args-ops.js';
import { formatHuman } from '../../src/commands/ops-output.js';
import { main } from '../../src/main.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  restProject,
  SOAP_ITEM,
  soapProject,
  startServer,
  tempDir,
  updateProject,
} from './ops/helpers.js';
import type { TestServer } from './ops/helpers.js';

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout: stdout.stream, stderr: stderr.stream, env: {} });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const envelope = (result: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  `<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>${result}</c:result></c:AddResponse>` +
  '</soapenv:Body></soapenv:Envelope>';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await removeTempDirs();
});

describe('the op verbs', () => {
  it('imports, lists and generates', async () => {
    const fixture = await emptyProject();
    const imported = await cli(['import', CALCULATOR_WSDL, '--project', fixture.dir]);
    expect(imported).toMatchObject({ code: ExitCode.Ok, stderr: '' });
    expect(imported.stdout).toContain('CalculatorService');

    const listed = await cli(['operations', '--project', fixture.dir, '--json']);
    expect(listed.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(listed.stdout) as { operations: { ref: string }[] };
    expect(parsed.operations.map((row) => row.ref)).toEqual(['CalculatorService/Add']);
    const text = await cli(['operations', '--project', fixture.dir]);
    expect(text.stdout).toContain(
      'CalculatorService/Add  (urn:wirebench:calculator/Add)\n  tool: calculator_service_add\n',
    );

    const generated = await cli(['generate', 'CalculatorService/Add', '--project', fixture.dir]);
    expect(generated.code).toBe(ExitCode.Ok);
    expect(generated.stdout).toContain('SOAPAction');
    expect(generated.stdout).toContain('Envelope');
  });

  it('sends, exits 1 on a failed assertion, and lists the send in History', async () => {
    const fixture = await soapProject();
    server = await startServer(() => ({ status: 500, headers: { 'Content-Type': 'text/xml' }, body: envelope('5') }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation) => ({
          ...operation,
          requests: operation.requests.map((request) => ({
            ...request,
            assertions: [{ type: 'status', equals: 200 }],
          })),
        })),
      })),
    }));
    const where = ['--project', fixture.dir, '--history-dir', fixture.historyDir];

    const sent = await cli(['send', SOAP_ITEM, '-e', 'local', ...where]);
    expect(sent.code).toBe(ExitCode.AssertionFailed);
    expect(sent.stdout).toContain('FAILED');
    expect(sent.stdout).toContain('500');

    const listed = await cli(['history', 'list', ...where]);
    expect(listed.code).toBe(ExitCode.Ok);
    expect(listed.stdout).toContain(SOAP_ITEM);
  });

  it('validates and queries a file, exiting 1 for an invalid message', async () => {
    const fixture = await soapProject();
    const dir = await tempDir();
    const good = join(dir, 'good.xml');
    const bad = join(dir, 'bad.xml');
    await writeFile(good, envelope('5'));
    await writeFile(bad, envelope('five'));
    const project = ['--project', fixture.dir];

    expect(await cli(['validate', good, '--operation', 'CalculatorService/Add', ...project])).toMatchObject({
      code: ExitCode.Ok,
    });
    const invalid = await cli(['validate', bad, '--operation', 'CalculatorService/Add', ...project]);
    expect(invalid.code).toBe(ExitCode.AssertionFailed);
    expect(invalid.stdout).toContain('invalid');

    expect(await cli(['query', 'string(//*:result)', good, ...project])).toMatchObject({
      code: ExitCode.Ok,
      stdout: '5\n',
    });
  });

  it('exits 0 for a REST body it could not check, saying so, and 1 for an undeclared status', async () => {
    const fixture = await restProject();
    const dir = await tempDir();
    const huge = join(dir, 'huge.json');
    await writeFile(huge, JSON.stringify([{ id: 1, name: 'x'.repeat(1_100_000) }]));
    const empty = join(dir, 'empty.json');
    await writeFile(empty, '[]');
    const project = ['--project', fixture.dir];

    const unchecked = await cli(['validate', huge, '--operation', 'Pets/listPets', ...project]);
    expect(unchecked.code).toBe(ExitCode.Ok);
    expect(unchecked.stdout).toMatch(/^not checked: skipped {2}Pets\//);

    const unmatched = await cli(['validate', empty, '--operation', 'Pets/listPets', '--status', '500', ...project]);
    expect(unmatched.code).toBe(ExitCode.AssertionFailed);
    expect(unmatched.stdout).toMatch(/^invalid {2}Pets\//);
  });

  it('exits 2 with the code on stderr for a refused call, and prints verb help', async () => {
    const fixture = await soapProject();
    const missing = await cli(['send', 'Nope', '--project', fixture.dir, '--history-dir', fixture.historyDir]);
    expect(missing).toMatchObject({ code: ExitCode.Usage, stdout: '' });
    expect(missing.stderr).toContain('item-not-found:');

    const help = await cli(['send', '--help']);
    expect(help.code).toBe(ExitCode.Ok);
    expect(help.stdout).toContain('wirebench send <item>');
    expect((await cli(['--help'])).stdout).toContain('wirebench history list');
  });
});

describe('the op verbs, --json and the human text', () => {
  it('prints the op result exactly with --json, and a person-readable text without it', async () => {
    const fixture = await soapProject();
    const json = await cli([
      'history',
      'list',
      '--project',
      fixture.dir,
      '--history-dir',
      fixture.historyDir,
      '--json',
    ]);
    expect(json.code).toBe(ExitCode.Ok);
    expect(JSON.parse(json.stdout)).toEqual({ entries: [], total: 0 });
    const text = await cli(['history', 'list', '--project', fixture.dir, '--history-dir', fixture.historyDir]);
    expect(text.stdout).toBe('no History entries\n');
  });

  it('says when output was cut, for query and history diff', () => {
    expect(formatHuman('query', { language: 'xpath', results: ['a'], truncated: true })).toBe(
      'a\n(output truncated: results were left out or cut at a size cap)\n',
    );
    expect(formatHuman('query', { language: 'xpath', results: ['a'], truncated: false })).toBe('a\n');
    const diff = {
      from: { id: 'a', at: 't', item: 'x' },
      to: { id: 'b', at: 't', item: 'x' },
      format: 'json',
      changes: [{ kind: 'changed', path: '/n', expected: '1', actual: '2' }],
      ignored: 0,
      truncated: true,
    };
    expect(formatHuman('history_diff', diff)).toBe('json: 1 changes\n~ /n: 1 -> 2\n(output cut at 256 KiB)\n');
    expect(formatHuman('history_diff', { ...diff, truncated: false })).not.toContain('cut at');
  });

  it("prints a WebSocket send's frames, one a line, in place of a body", () => {
    const text = formatHuman('send', {
      item: 'Chat/Echo',
      kind: 'websocket',
      outcome: 'passed',
      unasserted: true,
      method: 'GET',
      url: 'ws://127.0.0.1:9/echo',
      status: 101,
      statusText: 'Switching Protocols',
      durationMs: 12,
      headers: { upgrade: 'websocket' },
      body: '["hi"]',
      bodyTruncated: false,
      frames: [
        { index: 0, direction: 'sent', opcode: 'text', at: 1, size: 2, text: 'hi' },
        { index: 1, direction: 'received', opcode: 'binary', at: 2, size: 3, base64: 'AQID' },
        { index: 2, direction: 'received', opcode: 'text', at: 3, size: 2, text: 'hi' },
        { index: 3, direction: 'sent', opcode: 'close', at: 4, size: 2, close: { code: 1000, reason: '' } },
      ],
      framesTruncated: true,
      assertions: [],
    });
    expect(text).toBe(
      [
        'PASSED  GET ws://127.0.0.1:9/echo -> 101 Switching Protocols (12 ms)',
        '  (no assertions)',
        '',
        'upgrade: websocket',
        '',
        '> hi',
        '< (binary, 3 bytes)',
        '< hi',
        '> close 1000',
        '(frames cut: some were left out)',
        '',
      ].join('\n'),
    );
  });

  it('refuses a flag the verb does not take, as a usage error', async () => {
    const fixture = await soapProject();
    const foreign = await cli(['operations', '--project', fixture.dir, '--body', 'x']);
    expect(foreign).toMatchObject({ code: ExitCode.Usage, stdout: '' });
    expect(foreign.stderr).toContain('--body does not apply to wirebench operations');
  });
});

describe('the op verbs, exit codes, warnings and help', () => {
  it('exits 3 for an errored send and for an op error that is not a usage code', async () => {
    const fixture = await soapProject();
    server = await startServer(() => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: envelope('5') }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation) => ({
          ...operation,
          requests: operation.requests.map((request) => ({
            ...request,
            assertions: [{ type: 'match', language: 'xpath', expression: '((', equals: '1' }],
          })),
        })),
      })),
    }));
    const where = ['--project', fixture.dir, '--history-dir', fixture.historyDir];
    const errored = await cli(['send', SOAP_ITEM, '-e', 'local', ...where]);
    expect(errored.code).toBe(ExitCode.RunError);
    expect(errored.stdout).toContain('ERRORED');

    await server.close();
    const refused = await cli(['send', SOAP_ITEM, '-e', 'local', ...where]);
    expect(refused).toMatchObject({ code: ExitCode.RunError, stdout: '' });
    expect(refused.stderr).toContain('connection-refused:');
    server = undefined;
  });

  it('sends the History-busy warning to stderr and keeps stdout pure JSON under --json', async () => {
    const fixture = await soapProject();
    server = await startServer(() => ({ status: 200, headers: { 'Content-Type': 'text/xml' }, body: envelope('5') }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
    // A fresh lock file is a live writer's: the append waits for it, then gives up.
    await writeFile(join(fixture.historyDir, 'mcp-fixture.jsonl.lock'), 'held-by-a-test');

    const sent = await cli([
      'send',
      SOAP_ITEM,
      '-e',
      'local',
      '--project',
      fixture.dir,
      '--history-dir',
      fixture.historyDir,
      '--json',
    ]);

    expect(sent.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(sent.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ outcome: 'passed', status: 200 });
    expect(parsed).not.toHaveProperty('historyId');
    expect(sent.stderr).toMatch(/^warning: History not written: history-busy/);
  }, 15_000);

  it('says no file exists either when a path-shaped source is no History id', async () => {
    const fixture = await soapProject();
    const where = ['--project', fixture.dir, '--history-dir', fixture.historyDir];
    const path = await cli(['query', '//a', join(fixture.dir, 'missing.xml'), ...where]);
    expect(path.code).toBe(ExitCode.Usage);
    expect(path.stderr).toContain('history-entry-not-found:');
    expect(path.stderr).toContain(' (no file exists at that path either)');
    const id = await cli(['query', '//a', 'deadbeef', ...where]);
    expect(id.code).toBe(ExitCode.Usage);
    expect(id.stderr).toContain('history-entry-not-found:');
    expect(id.stderr).not.toContain('no file exists');
  });

  it('prints no results for an empty query result', () => {
    expect(formatHuman('query', { language: 'xpath', results: [], truncated: false })).toBe('(no results)\n');
  });

  it('has help for every verb and lists every op in the overview', () => {
    const ops: OpName[] = [
      'import',
      'operations',
      'generate',
      'send',
      'validate',
      'query',
      'history_list',
      'history_diff',
    ];
    for (const op of ops) {
      const verb = op.startsWith('history_') ? 'history' : op;
      expect(Object.hasOwn(VERB_HELP, verb)).toBe(true);
      expect(OPS_HELP_TEXT).toContain(op.startsWith('history_') ? `history ${op.slice(8)}` : `wirebench ${op}`);
    }
  });
});
