import { describe, expect, it } from 'vitest';
import { UsageError, parseCliArgs } from '../../src/args.js';

describe('parseCliArgs', () => {
  it('parses a full run command', () => {
    expect(
      parseCliArgs([
        'run',
        './p',
        'sel1',
        'sel2',
        '-e',
        'staging',
        '--reporter',
        'junit=a.xml',
        '--reporter',
        'cli',
        '--var',
        'a=1',
        '--var',
        'b=x=y',
        '--bail',
        '--timeout',
        '5000',
        '--sla',
        '800',
        '--no-color',
      ]),
    ).toMatchObject({
      command: 'run',
      path: './p',
      selectors: ['sel1', 'sel2'],
      env: 'staging',
      vars: { a: '1', b: 'x=y' },
      reporters: [{ kind: 'junit', file: 'a.xml' }, { kind: 'cli' }],
      bail: true,
      timeoutMs: 5000,
      slaMs: 800,
      color: false,
    });
  });

  it('defaults to the cli reporter', () => {
    expect(parseCliArgs(['run', './p'])).toMatchObject({ reporters: [{ kind: 'cli' }], bail: false });
  });

  it('parses secrets list, help and version', () => {
    expect(parseCliArgs(['secrets', 'list', './p', '-e', 'x'])).toMatchObject({
      command: 'secrets-list',
      path: './p',
      env: 'x',
    });
    expect(parseCliArgs(['secrets', 'list', './p', '--var', 'k=${secret:x}', '--var', 'a=b'])).toMatchObject({
      command: 'secrets-list',
      vars: { k: '${secret:x}', a: 'b' },
    });
    expect(parseCliArgs(['secrets', 'list', './p'])).toMatchObject({ vars: {} });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' });
    expect(parseCliArgs([])).toEqual({ command: 'help' });
  });

  it.each([
    [['run']],
    [['run', './p', '--reporter', 'junit']],
    [['run', './p', '--reporter', 'xml=a']],
    [['run', './p', '--var', 'novalue']],
    [['secrets', 'list', './p', '--var', 'novalue']],
    [['run', './p', '--sla', 'abc']],
    [['run', './p', '--timeout', '0']],
    [['run', './p', '--nope']],
    [['frobnicate']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});

describe('parseCliArgs --sequence', () => {
  it('collects every --sequence for run and secrets list', () => {
    expect(parseCliArgs(['run', 'p', '--sequence', 'a', '--sequence', 'sequences/b.sequence.yaml'])).toMatchObject({
      command: 'run',
      selectors: [],
      sequences: ['a', 'sequences/b.sequence.yaml'],
    });
    expect(parseCliArgs(['secrets', 'list', 'p', '--sequence', 'a'])).toMatchObject({
      command: 'secrets-list',
      sequences: ['a'],
    });
    expect(parseCliArgs(['run', 'p'])).toMatchObject({ sequences: [] });
  });

  it('refuses --sequence together with request selectors', () => {
    expect(() => parseCliArgs(['run', 'p', 'demo/ok', '--sequence', 'a'])).toThrow(UsageError);
    expect(() => parseCliArgs(['secrets', 'list', 'p', 'demo/ok', '--sequence', 'a'])).toThrow(UsageError);
  });
});

describe('parseCliArgs — the op verbs', () => {
  it('parses each verb into its op and input', () => {
    expect(parseCliArgs(['import', 'a.wsdl', '--name', 'Calc', '--project', 'p'])).toEqual({
      command: 'op',
      op: 'import',
      project: 'p',
      json: false,
      input: { source: 'a.wsdl', name: 'Calc' },
    });
    expect(parseCliArgs(['operations', 'Pets', '--json'])).toMatchObject({
      op: 'operations',
      project: '.',
      json: true,
      input: { container: 'Pets' },
    });
    expect(parseCliArgs(['generate', 'Calc/Add', '--optional', 'all'])).toMatchObject({
      op: 'generate',
      input: { operation: 'Calc/Add', optional: 'all' },
    });
    expect(
      parseCliArgs(['send', 'Calc/Add/Request 1', '-e', 'local', '--body-file', 'b.xml', '--history-dir', 'h']),
    ).toEqual({
      command: 'op',
      op: 'send',
      project: '.',
      historyDir: 'h',
      json: false,
      input: { item: 'Calc/Add/Request 1', environment: 'local' },
      bodyFile: 'b.xml',
    });
    expect(parseCliArgs(['validate', 'x.xml', '--operation', 'Calc/Add', '--direction', 'request'])).toMatchObject({
      op: 'validate',
      source: 'x.xml',
      input: { operation: 'Calc/Add', direction: 'request' },
    });
    expect(parseCliArgs(['query', '//a', 'x.xml', '--namespace', 'c=urn:c', '--namespace', 'd=urn:d'])).toMatchObject({
      op: 'query',
      source: 'x.xml',
      input: { expression: '//a', namespaces: { c: 'urn:c', d: 'urn:d' } },
    });
    expect(parseCliArgs(['history', 'list', '--item', 'Pets', '--limit', '5'])).toMatchObject({
      op: 'history_list',
      input: { item: 'Pets', limit: 5 },
    });
    expect(parseCliArgs(['history', 'diff', 'a', 'b', '--ignore', '/0/seen'])).toMatchObject({
      op: 'history_diff',
      input: { from: 'a', to: 'b', ignore: ['/0/seen'] },
    });
  });

  it('still accepts and ignores every run option on secrets list, as before the verbs', () => {
    expect(
      parseCliArgs(['secrets', 'list', './p', '--no-color', '-q', '-v', '--insecure', '--bail', '--reporter', 'cli']),
    ).toMatchObject({ command: 'secrets-list', path: './p' });
    expect(
      parseCliArgs(['secrets', 'list', './p', '--timeout', '5', '--sla', '5', '--require-assertions']),
    ).toMatchObject({ command: 'secrets-list' });
  });

  it('does not look a help topic up on the prototype', () => {
    expect(parseCliArgs(['toString', '--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['constructor', '--help'])).toEqual({ command: 'help' });
  });

  it('gives each verb its own help', () => {
    expect(parseCliArgs(['send', '--help'])).toEqual({ command: 'help', topic: 'send' });
    expect(parseCliArgs(['history', 'diff', '--help'])).toEqual({ command: 'help', topic: 'history' });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
  });

  it.each([
    [['import']],
    [['import', 'a', 'b']],
    [['generate']],
    [['send', 'x', '--body', 'a', '--body-file', 'b']],
    [['query', '//a']],
    [['history']],
    [['history', 'show']],
    [['history', 'list', '--limit', 'ten']],
    [['query', '//a', 'x', '--namespace', 'nouri']],
    [['operations', '--name', 'x']],
    [['run', './p', '--json']],
    [['secrets', 'list', './p', '--json']],
    [['run', './p', '--project', 'x']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});

describe('parseCliArgs — mcp', () => {
  it('parses the gates, the environment list and the History folder', () => {
    expect(
      parseCliArgs([
        'mcp',
        '--project',
        'p',
        '--allow-write',
        '--allow-send',
        '-e',
        'local, staging',
        '--history-dir',
        'h',
      ]),
    ).toEqual({
      command: 'mcp',
      project: 'p',
      historyDir: 'h',
      allowWrite: true,
      allowSend: true,
      environments: ['local', 'staging'],
    });
    expect(parseCliArgs(['mcp'])).toEqual({ command: 'mcp', project: '.', allowWrite: false, allowSend: false });
    expect(parseCliArgs(['mcp', '--help'])).toEqual({ command: 'help', topic: 'mcp' });
  });

  it.each([
    [['mcp', 'extra']],
    [['mcp', '--json']],
    [['mcp', '-e', ' , ']],
    [['send', 'x', '--allow-send']],
    [['run', 'p', '--allow-send']],
    [['run', 'p', '--allow-write']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
