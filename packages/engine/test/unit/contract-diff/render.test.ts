import { describe, expect, it } from 'vitest';
import type { ContractDiff } from '../../../src/contract-diff/model.js';
import {
  contractDiffJson,
  escapeMarkdownCell,
  renderContractDiffHtml,
  renderContractDiffMarkdown,
  summaryLine,
} from '../../../src/contract-diff/render.js';

const DIFF: ContractDiff = {
  format: 'openapi',
  old: { label: 'v1.yaml', title: 'Orders', version: '1.0.0' },
  new: { label: 'v2.yaml', title: 'Orders', version: '2.0.0' },
  operationsCompared: 2,
  changes: [
    {
      kind: 'field-required',
      severity: 'breaking',
      operation: 'GET /orders',
      location: 'request.query.limit',
      message: 'limit is now required',
    },
    { kind: 'endpoint-moved', severity: 'breaking', message: 'endpoint https://a moved to https://b' },
    {
      kind: 'field-added',
      severity: 'compatible',
      operation: 'POST /orders',
      location: 'response.201.eta',
      message: 'eta added, optional',
    },
  ],
  notes: ['v1.yaml: a <note>'],
};

const EMPTY: ContractDiff = { ...DIFF, changes: [], notes: [], operationsCompared: 1 };

const TOOL = { name: 'wirebench', version: '9.9.9' };

describe('contract diff reports', () => {
  it('counts changes and operations in one line', () => {
    expect(summaryLine(DIFF)).toBe('2 breaking, 1 compatible changes in 2 operations compared');
    expect(summaryLine(EMPTY)).toBe('0 breaking, 0 compatible changes in 1 operation compared');
  });

  it('renders Markdown with the sides, the counts and a table per severity', () => {
    const markdown = renderContractDiffMarkdown(DIFF);
    expect(markdown).toContain('# OpenAPI contract diff');
    expect(markdown).toContain('| Version | 1.0.0 | 2.0.0 |');
    expect(markdown).toContain('**2 breaking, 1 compatible changes in 2 operations compared.**');
    expect(markdown).toContain('## Breaking changes');
    expect(markdown).toContain('| GET /orders | request.query.limit | limit is now required |');
    expect(markdown).toContain('| (contract) |  | endpoint https://a moved to https://b |');
    expect(markdown).toContain('## Compatible changes');
    expect(markdown).toContain('- v1.yaml: a \\<note\\>');
    expect(markdown.indexOf('## Breaking')).toBeLessThan(markdown.indexOf('## Compatible'));
  });

  it('says so when nothing changed, with no empty sections', () => {
    const markdown = renderContractDiffMarkdown(EMPTY);
    expect(markdown).toContain('No differences');
    expect(markdown).not.toContain('## ');
  });

  it('escapes what a Markdown cell would read as formatting', () => {
    expect(escapeMarkdownCell('a|b `c` *d* <e>\nf')).toBe('a\\|b \\`c\\` \\*d\\* \\<e\\> f');
  });

  it('renders a self-contained HTML page with every text escaped', () => {
    const html = renderContractDiffHtml({ ...DIFF, old: { label: '<script>alert(1)</script>' } }, TOOL);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h2 class="danger">Breaking changes (2)</h2>');
    expect(html).toContain('<h2 class="success">Compatible changes (1)</h2>');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('a &lt;note&gt;');
  });

  it('adds the counts to the JSON report', () => {
    expect(contractDiffJson(DIFF).summary).toEqual({ breaking: 2, compatible: 1 });
  });
});
