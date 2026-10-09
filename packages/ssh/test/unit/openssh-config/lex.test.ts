import { describe, expect, it } from 'vitest';
import { lexSshConfig } from '../../../src/openssh-config/lex.js';

const F = '~/.ssh/config';

describe('lexSshConfig', () => {
  it('splits keyword and arguments on whitespace or =', () => {
    const { lines, problems } = lexSshConfig('Host a b\nHostName=x.example\nPort = 22\n  User\tdeploy\n', F);
    expect(problems).toEqual([]);
    expect(lines).toEqual([
      { file: F, line: 1, keyword: 'host', args: ['a', 'b'] },
      { file: F, line: 2, keyword: 'hostname', args: ['x.example'] },
      { file: F, line: 3, keyword: 'port', args: ['22'] },
      { file: F, line: 4, keyword: 'user', args: ['deploy'] },
    ]);
  });

  it('lower-cases the keyword, never the arguments', () => {
    expect(lexSshConfig('hOsTnAmE Web.Example', F).lines[0]).toMatchObject({
      keyword: 'hostname',
      args: ['Web.Example'],
    });
  });

  it('keeps a double-quoted argument with spaces as one argument', () => {
    expect(lexSshConfig('IdentityFile "~/My Keys/id one"', F).lines[0]?.args).toEqual(['~/My Keys/id one']);
  });

  it('skips comments and blank lines, keeps # inside quotes and inside a word', () => {
    const { lines } = lexSshConfig('# top\n\n   \nHost a # trailing\nUser "x#y"\nHostName h#1\n', F);
    expect(lines.map((l) => [l.line, l.keyword, l.args])).toEqual([
      [4, 'host', ['a']],
      [5, 'user', ['x#y']],
      [6, 'hostname', ['h#1']],
    ]);
  });

  it('handles CRLF and a byte order mark', () => {
    const { lines } = lexSshConfig('﻿Host a\r\nPort 2222\r\n', F);
    expect(lines.map((l) => [l.keyword, l.args])).toEqual([
      ['host', ['a']],
      ['port', ['2222']],
    ]);
  });

  it('reports a line that does not lex by number only, never its text', () => {
    const result = lexSshConfig('Host a\nProxyCommand "MARKER-7f3 unclosed\nPort 22\n', F);
    expect(result.lines.map((l) => l.keyword)).toEqual(['host', 'port']);
    expect(result.problems).toEqual([{ file: F, line: 2, why: 'line could not be read' }]);
    expect(JSON.stringify(result)).not.toContain('MARKER-7f3');
  });

  it('reports a keyword with no arguments', () => {
    const result = lexSshConfig('HostName\n', F);
    expect(result.lines).toEqual([]);
    expect(result.problems).toEqual([{ file: F, line: 1, why: 'keyword without a value' }]);
  });
});
