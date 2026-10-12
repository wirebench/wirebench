import { describe, expect, it } from 'vitest';
import type { LintRulesetFile } from '../../../../../src/rest/openapi/lint/model.js';
import { planLintRules } from '../../../../../src/rest/openapi/lint/ruleset.js';
import { lintWithRules } from '../../../../../src/rest/openapi/lint/run.js';
import { brief, fixture, recordingFetch } from './helpers.js';

const file = (text: string, name = 'lint/team.yaml'): LintRulesetFile => ({ name, text });

const lint = async (files: readonly LintRulesetFile[], name = 'noisy-3.1.yaml', patternTimeoutMs?: number) =>
  lintWithRules(await fixture(name), planLintRules(files, patternTimeoutMs === undefined ? {} : { patternTimeoutMs }), {
    fetchDocument: recordingFetch().fetchDocument,
  });

const ids = (files: readonly LintRulesetFile[]) => planLintRules(files).map((rule) => rule.id);

describe('planLintRules', () => {
  it('runs both built-in rule sets when there are no files', () => {
    const rules = planLintRules([]);
    expect(rules.some((rule) => rule.ruleset === 'hygiene')).toBe(true);
    expect(rules.some((rule) => rule.ruleset === 'owasp')).toBe(true);
  });

  it('picks the built-ins a file names; [] runs none', () => {
    expect(planLintRules([file('builtin: [owasp]')]).every((rule) => rule.ruleset === 'owasp')).toBe(true);
    expect(ids([file('builtin: []')])).toEqual([]);
  });

  it('switches a built-in rule off or re-grades it, the later file winning', () => {
    const rules = planLintRules([
      file('rules: { info-description: off, owasp-plain-http: hint }', 'lint/a.yaml'),
      file('rules: { owasp-plain-http: info }', 'lint/b.yaml'),
    ]);
    expect(rules.map((rule) => rule.id)).not.toContain('info-description');
    expect(rules.find((rule) => rule.id === 'owasp-plain-http')?.severity).toBe('info');
  });

  it('names the file and the field of an invalid rule set', () => {
    const cases: [string, RegExp][] = [
      ['rules: [', /lint\/team\.yaml: not valid YAML/],
      ['extends: x', /lint\/team\.yaml: the file: .*extends/i],
      ['rules: { info-description: loud }', /rules\.info-description/],
      ['rules: { nope: error }', /no built-in or project rule is called "nope"/],
      ['rules: { info-description: { target: info, field: x, check: present } }', /is a built-in rule/],
      ['rules: { a: { target: path, field: x, check: present } }', /rules\.a\.target/],
      ['rules: { a: { target: info, field: "x..y", check: present } }', /rules\.a\.field/],
      ['rules: { a: { target: info, field: x, check: max-length } }', /max-length takes a whole number/],
      ['rules: { a: { target: info, field: x, check: present, value: 3 } }', /present takes no value/],
      [
        'rules: { a: { target: info, field: x, check: pattern, value: "(" } }',
        /rules\.a\.value: Invalid regular expression/,
      ],
      ['rules: { Bad_Id: off }', /a rule id is letters, digits and hyphens/],
    ];
    for (const [text, message] of cases) {
      expect(() => planLintRules([file(text)]), text).toThrowError(message);
      try {
        planLintRules([file(text)]);
      } catch (error) {
        expect(error).toMatchObject({ code: 'lint-ruleset-invalid', details: { file: 'lint/team.yaml' } });
      }
    }
  });
});

describe('project rules', () => {
  const only = (rules: string) => [file(`builtin: []\nrules:\n${rules}`)];

  it('checks present and absent', async () => {
    const report = await lint(
      only(
        [
          '  op-tags: { target: operation, field: tags, check: present, severity: error }',
          '  no-x: { target: info, field: title, check: absent, message: Do not set a title }',
        ].join('\n'),
      ),
    );
    expect(brief(report.findings)).toEqual([
      'no-x /info/title',
      'op-tags /paths/~1things/get',
      'op-tags /paths/~1things/post',
      'op-tags /paths/~1things~1{id}/get',
    ]);
    expect(report.findings[0]).toMatchObject({ message: 'Do not set a title', severity: 'warning' });
    expect(report.findings[1]?.severity).toBe('error');
    expect(report.rules.find((rule) => rule.id === 'op-tags')).toMatchObject({
      ruleset: 'lint/team.yaml',
      description: 'operation tags is set',
    });
  });

  it('checks lengths and allowed values, on dotted fields', async () => {
    const report = await lint(
      only(
        [
          '  short-summary: { target: operation, field: summary, check: max-length, value: 5 }',
          '  long-title: { target: info, field: title, check: min-length, value: 10 }',
          '  key-in: { target: security-scheme, field: in, check: one-of, value: [query] }',
          '  flow-url: { target: security-scheme, field: flows.authorizationCode.tokenUrl, check: max-length, value: 3 }',
        ].join('\n'),
      ),
    );
    expect(brief(report.findings)).toEqual([
      'long-title /info/title',
      'short-summary /paths/~1things~1{id}/get/summary',
      'key-in /components/securitySchemes/keyAuth/in',
      'flow-url /components/securitySchemes/oauth/flows/authorizationCode/tokenUrl',
    ]);
    expect(report.findings[2]?.message).toBe('in is not one of query');
  });

  it('checks patterns on the regex worker, kebab-case included', async () => {
    const report = await lint(
      only(
        [
          '  camel-ids: { target: operation, field: operationId, check: pattern, value: "^[a-z][a-zA-Z0-9]*$" }',
          '  kebab-tags: { target: operation, field: summary, check: not-pattern, value: "^[a-z]+(?:-[a-z]+)*$" }',
          '  no-thing: { target: operation, field: operationId, check: not-pattern, value: "Thing" }',
        ].join('\n'),
      ),
    );
    expect(brief(report.findings)).toEqual([
      'no-thing /paths/~1things/post/operationId',
      'no-thing /paths/~1things~1{id}/get/operationId',
    ]);
    expect(report.findings[0]?.message).toBe('operationId matches /Thing/');
  });

  it('turns a pattern that backtracks past its budget into a finding, not a hang', async () => {
    const started = Date.now();
    const report = await lintWithRules(
      {
        text: `openapi: 3.0.3\ninfo: { title: "${'a'.repeat(40)}!", version: "1" }\npaths: {}\n`,
        location: 'inline:test',
      },
      planLintRules(
        [file('builtin: []\nrules:\n  evil: { target: info, field: title, check: pattern, value: "^(a+)+$" }')],
        { patternTimeoutMs: 300 },
      ),
      { fetchDocument: recordingFetch().fetchDocument },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.message).toMatch(/title could not be checked: .*timed out/);
  });
});
