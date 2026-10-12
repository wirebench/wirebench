import { describe, expect, it } from 'vitest';
import {
  EMPTY_SNIPPETS_FILE,
  findSnippet,
  listSnippets,
  parseSnippetsFile,
  serializeSnippetsFile,
  SshModelError,
} from '../../src/index.js';
import type { SnippetsFile } from '../../src/index.js';

const EXAMPLE = `
version: 1
packages:
  - id: deploy
    name: Deploy
    snippets:
      - id: restart-api
        name: Restart API
        tags: [deploy]
        script: sudo systemctl restart api
        confirm: true
      - id: tail-log
        name: Tail service log
        description: Follows a unit's journal
        tags: [logs]
        variables:
          - name: service
            default: api
          - name: lines
            label: Lines to show
            default: '200'
        script: journalctl -u \${service} -n \${lines} -f
snippets:
  - id: call-health
    name: Health with token
    script: |
      curl -s -H "Authorization: Bearer \${secret:api_token}" https://localhost/health
      echo
    enter: true
`;

function expectCode(fn: () => unknown, code: string): SshModelError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SshModelError);
    expect((error as SshModelError).code).toBe(code);
    return error as SshModelError;
  }
  throw new Error(`expected ${code}`);
}

const one = (snippet: string): string => `version: 1\nsnippets:\n  - ${snippet}\n`;

describe('parseSnippetsFile', () => {
  it('parses the spec example with its defaults', () => {
    const file = parseSnippetsFile(EXAMPLE);
    expect(file.packages[0]?.snippets.map((s) => s.id)).toEqual(['restart-api', 'tail-log']);
    expect(file.packages[0]?.snippets[0]).toMatchObject({ enter: true, confirm: true, variables: [] });
    expect(file.snippets[0]).toMatchObject({ id: 'call-health', tags: [], enter: true, confirm: false });
    expect(file.packages[0]?.snippets[1]?.variables).toEqual([
      { name: 'service', default: 'api' },
      { name: 'lines', label: 'Lines to show', default: '200' },
    ]);
  });
  it('an empty or comments-only text is the empty file', () => {
    expect(parseSnippetsFile('')).toEqual(EMPTY_SNIPPETS_FILE);
    expect(parseSnippetsFile('# none yet\n')).toEqual(EMPTY_SNIPPETS_FILE);
  });
  it('refuses schema violations with snippets-invalid and the path', () => {
    const cases: [string, string][] = [
      [one('{ id: a, name: a, script: x, colour: red }'), 'snippets[0]'],
      ['version: 2\n', 'version'],
      [one(`{ id: a, name: a, script: '' }`), 'snippets[0].script'],
      [one(`{ id: a, name: a, script: '   ' }`), 'snippets[0].script'],
      [one('{ id: Deploy, name: a, script: x }'), 'snippets[0].id'],
      [
        `version: 1\npackages:\n  - { id: p, name: p, snippets: [{ id: a, name: a }] }\n`,
        'packages[0].snippets[0].script',
      ],
      [one('{ id: a, name: a, script: x, variables: [{ name: v, default: 3 }] }'), 'snippets[0].variables[0].default'],
    ];
    for (const [text, path] of cases) {
      expect(expectCode(() => parseSnippetsFile(text), 'snippets-invalid').details).toMatchObject({ path });
    }
  });
  it('malformed YAML is reported without echoing the source', () => {
    const e = expectCode(
      () => parseSnippetsFile(`version: 1\nscript: hunter2\n  bad: [unclosed\n`),
      'snippets-invalid',
    );
    expect(e.message).toMatch(/snippets\.yaml: YAML syntax error/);
    expect(e.message + JSON.stringify(e.details)).not.toContain('hunter2');
  });
  it('refuses an id used twice anywhere in the file, naming both paths', () => {
    const packageClash = expectCode(
      () =>
        parseSnippetsFile(
          `version: 1\npackages:\n  - { id: x, name: p }\nsnippets:\n  - { id: x, name: s, script: ls }\n`,
        ),
      'snippet-duplicate-id',
    );
    expect(packageClash.details).toMatchObject({
      id: 'x',
      paths: ['packages[0]', 'snippets[0]'],
      path: 'snippets[0]',
    });
    const acrossPackages = expectCode(
      () =>
        parseSnippetsFile(
          `version: 1\npackages:\n  - { id: p, name: p, snippets: [{ id: s, name: s, script: ls }] }\n  - { id: q, name: q, snippets: [{ id: s, name: s, script: ls }] }\n`,
        ),
      'snippet-duplicate-id',
    );
    expect(acrossPackages.details).toMatchObject({ paths: ['packages[0].snippets[0]', 'packages[1].snippets[0]'] });
  });
  it('refuses a variable named secret, malformed or declared twice', () => {
    for (const [variables, at] of [
      ['[{ name: secret }]', 0],
      ['[{ name: 1x }]', 0],
      ['[{ name: a-b }]', 0],
      ['[{ name: v }, { name: v }]', 1],
    ] as const) {
      const e = expectCode(
        () => parseSnippetsFile(one(`{ id: a, name: a, script: x, variables: ${variables} }`)),
        'snippet-variable-invalid',
      );
      expect(e.details).toMatchObject({ snippet: 'a', path: `snippets[0].variables[${at}].name` });
    }
  });
  it('refuses a malformed secret token in a script and any secret token in a default', () => {
    for (const script of [
      'echo ${secret:bad-name}',
      'echo ${secret:}',
      'echo ${secret:x',
      'echo ${secret:ok} ${secret:9}',
    ]) {
      const e = expectCode(
        () => parseSnippetsFile(one(`{ id: a, name: a, script: '${script}' }`)),
        'snippet-secret-invalid',
      );
      expect(e.details).toMatchObject({ snippet: 'a', field: 'script', path: 'snippets[0].script' });
    }
    const d = expectCode(
      () =>
        parseSnippetsFile(
          one(`{ id: a, name: a, script: 'x \${v}', variables: [{ name: v, default: '\${secret:x}' }] }`),
        ),
      'snippet-secret-invalid',
    );
    expect(d.details).toMatchObject({ path: 'snippets[0].variables[0].default' });
  });
  it('leaves other ${…} and $name alone at parse time', () => {
    expect(() =>
      parseSnippetsFile(one(`{ id: a, name: a, script: 'echo \${HOME} $USER $(date) \${1}' }`)),
    ).not.toThrow();
  });
});

describe('serializeSnippetsFile', () => {
  it('round-trips the example and writes a multi-line script as a block', () => {
    const file = parseSnippetsFile(EXAMPLE);
    const text = serializeSnippetsFile(file);
    expect(parseSnippetsFile(text)).toEqual(file);
    expect(text).toContain('    script: |\n      curl -s');
    expect(text).toContain('script: sudo systemctl restart api');
    expect(text).not.toContain('enter: true');
    expect(text).toContain('confirm: true');
  });
  it('a script without a trailing line break round-trips too', () => {
    const file: SnippetsFile = {
      version: 1,
      packages: [],
      snippets: [{ id: 'a', name: 'a', tags: [], variables: [], script: 'one\ntwo', enter: false, confirm: false }],
    };
    expect(parseSnippetsFile(serializeSnippetsFile(file))).toEqual(file);
  });
  it('the empty file serialises to the version alone', () => {
    expect(serializeSnippetsFile(EMPTY_SNIPPETS_FILE)).toBe('version: 1\n');
  });
});

describe('listSnippets', () => {
  const list = listSnippets(parseSnippetsFile(EXAMPLE));
  it('lists every snippet flat, packages first', () => {
    expect(list.map((s) => [s.id, s.packageId, s.packageName])).toEqual([
      ['restart-api', 'deploy', 'Deploy'],
      ['tail-log', 'deploy', 'Deploy'],
      ['call-health', undefined, undefined],
    ]);
  });
  it('gives the first line, its literal start, secrets and line count', () => {
    const [restart, tail, health] = list;
    expect(tail).toMatchObject({
      firstLine: 'journalctl -u ${service} -n ${lines} -f',
      literalStart: 'journalctl -u ',
      secrets: [],
      lineCount: 1,
      description: "Follows a unit's journal",
    });
    expect(restart).toMatchObject({ literalStart: 'sudo systemctl restart api', confirm: true, enter: true });
    expect(health).toMatchObject({
      firstLine: 'curl -s -H "Authorization: Bearer ${secret:api_token}" https://localhost/health',
      literalStart: 'curl -s -H "Authorization: Bearer ',
      secrets: ['api_token'],
      lineCount: 2,
    });
  });
  it('lists a secret once in order of first use', () => {
    const [item] = listSnippets(
      parseSnippetsFile(one(`{ id: a, name: a, script: 'x \${secret:b} \${secret:a} \${secret:b}' }`)),
    );
    expect(item?.secrets).toEqual(['b', 'a']);
  });
  it('revision changes with the snippet and not with another one', () => {
    const file = parseSnippetsFile(EXAMPLE);
    const health = file.snippets[0];
    if (!health) throw new Error('example has a loose snippet');
    const after = listSnippets({ ...file, snippets: [{ ...health, script: 'echo changed' }] });
    expect(after[2]?.revision).not.toBe(list[2]?.revision);
    expect(after[0]?.revision).toBe(list[0]?.revision);
    expect(after[1]?.revision).toBe(list[1]?.revision);
    expect(list[0]?.revision).toMatch(/^[0-9a-f]{64}$/);
  });
  it('findSnippet finds by id in a package or not', () => {
    const file = parseSnippetsFile(EXAMPLE);
    expect(findSnippet(file, 'tail-log')?.name).toBe('Tail service log');
    expect(findSnippet(file, 'call-health')?.name).toBe('Health with token');
    expect(findSnippet(file, 'deploy')).toBeUndefined();
  });
});
