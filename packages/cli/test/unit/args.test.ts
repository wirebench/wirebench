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
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' });
    expect(parseCliArgs([])).toEqual({ command: 'help' });
  });

  it.each([
    [['run']],
    [['run', './p', '--reporter', 'junit']],
    [['run', './p', '--reporter', 'xml=a']],
    [['run', './p', '--var', 'novalue']],
    [['run', './p', '--sla', 'abc']],
    [['run', './p', '--timeout', '0']],
    [['run', './p', '--nope']],
    [['frobnicate']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
