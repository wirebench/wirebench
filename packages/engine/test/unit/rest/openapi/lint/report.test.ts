import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countFindings, failsAt } from '../../../../../src/rest/openapi/lint/model.js';
import type { LintFinding } from '../../../../../src/rest/openapi/lint/model.js';
import { readProjectLintRulesets } from '../../../../../src/rest/openapi/lint/project.js';
import { lintReportJson, lintReportSarif } from '../../../../../src/rest/openapi/lint/report.js';
import { lintOpenApi } from '../../../../../src/rest/openapi/lint/run.js';
import { fixture, recordingFetch } from './helpers.js';

const tool = { name: 'wirebench', version: '9.9.9' };

type Sarif = {
  version: string;
  runs: {
    tool: {
      driver: { name: string; version: string; rules: { id: string; defaultConfiguration: { level: string } }[] };
    };
    results: {
      ruleId: string;
      ruleIndex: number;
      level: string;
      message: { text: string };
      locations: {
        physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number; startColumn: number } };
      }[];
    }[];
  }[];
};

describe('lint reports', () => {
  it('writes SARIF 2.1.0 with every rule that ran and one located result per finding', async () => {
    const input = await fixture('noisy-3.1.yaml');
    const report = await lintOpenApi(input, { fetchDocument: recordingFetch().fetchDocument });
    const sarif = lintReportSarif(report, {
      tool,
      document: 'noisy-3.1.yaml',
      displayLocation: (location) => (location === input.location ? 'specs/noisy-3.1.yaml' : location),
    }) as unknown as Sarif;
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0]!;
    expect(run.tool.driver).toMatchObject({ name: 'wirebench', version: '9.9.9' });
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual(report.rules.map((rule) => rule.id));
    expect(run.results).toHaveLength(report.findings.length);
    const plain = run.results.find((result) => result.ruleId === 'owasp-plain-http')!;
    expect(plain.level).toBe('error');
    expect(run.tool.driver.rules[plain.ruleIndex]?.id).toBe('owasp-plain-http');
    expect(plain.locations[0]?.physicalLocation.artifactLocation.uri).toBe('specs/noisy-3.1.yaml');
    expect(plain.locations[0]?.physicalLocation.region).toMatchObject({ startLine: 6 });
    expect(run.results.find((result) => result.ruleId === 'info-description')?.level).toBe('warning');
  });

  it('gives a runner finding without a rule of ours a driver rule too, and maps hint and info to note', () => {
    const findings: LintFinding[] = [
      { rule: 'invalid-ref', severity: 'error', message: 'x', path: '/a', source: 'inline:x' },
      { rule: 'r', severity: 'hint', message: 'y', path: '', source: 'inline:x' },
    ];
    const report = {
      version: '3.1' as const,
      declaredVersion: '3.1.0',
      findings,
      rules: [{ id: 'r', severity: 'info' as const, description: 'R', ruleset: 'lint/a.yaml' }],
    };
    const run = (lintReportSarif(report, { tool, document: 'x' }) as unknown as Sarif).runs[0]!;
    expect(run.tool.driver.rules.map((rule) => [rule.id, rule.defaultConfiguration.level])).toEqual([
      ['r', 'note'],
      ['invalid-ref', 'error'],
    ]);
    expect(run.results.map((result) => result.level)).toEqual(['error', 'note']);
  });

  it('writes the JSON report with counts and displayed sources', async () => {
    const input = await fixture('noisy-2.0.yaml');
    const report = await lintOpenApi(input, { fetchDocument: recordingFetch().fetchDocument });
    const json = lintReportJson(report, { tool, document: 'noisy-2.0.yaml', displayLocation: () => 'shown.yaml' });
    expect(json).toMatchObject({ tool, document: 'noisy-2.0.yaml', declaredVersion: 'Swagger 2.0' });
    expect(json.summary).toEqual(countFindings(report.findings));
    expect(json.findings.every((finding) => finding.source === 'shown.yaml')).toBe(true);
  });

  it('gates on a severity and counts each one', () => {
    const at = (severity: LintFinding['severity']): LintFinding => ({
      rule: 'r',
      severity,
      message: '',
      path: '',
      source: 's',
    });
    const findings = [at('warning'), at('hint')];
    expect(failsAt(findings, 'error')).toBe(false);
    expect(failsAt(findings, 'warning')).toBe(true);
    expect(failsAt(findings, 'info')).toBe(true);
    expect(failsAt([at('error')], 'none')).toBe(false);
    expect(countFindings(findings)).toEqual({ error: 0, warning: 1, info: 0, hint: 1 });
  });

  it("reads a project's lint/ folder in name order, YAML files only", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-lint-'));
    try {
      expect(await readProjectLintRulesets(dir)).toEqual([]);
      await mkdir(join(dir, 'lint'));
      await writeFile(join(dir, 'lint', 'b.yml'), 'b');
      await writeFile(join(dir, 'lint', 'a.yaml'), 'a');
      await writeFile(join(dir, 'lint', 'notes.md'), 'x');
      expect(await readProjectLintRulesets(dir)).toEqual([
        { name: 'lint/a.yaml', text: 'a' },
        { name: 'lint/b.yml', text: 'b' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
