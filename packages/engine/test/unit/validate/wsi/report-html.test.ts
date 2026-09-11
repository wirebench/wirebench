import { describe, expect, it } from 'vitest';
import { escapeHtml, renderWsiReportHtml } from '../../../../src/validate/wsi/report-html.js';
import type { WsiReport } from '../../../../src/validate/wsi/types.js';

const REPORT: WsiReport = {
  target: 'http://example.invalid/wsi?a=1&b=2',
  profile: 'BP1.1',
  summary: { passed: 12, failed: 2, warning: 1, notApplicable: 8 },
  assertions: [
    {
      id: 'R1015',
      title: 'A literal message carries no soap:encodingStyle attribute',
      level: 'REQUIRED',
      section: '3.1 XML Representation of SOAP Messages',
      result: 'failed',
      findings: [
        {
          message: '"tns:Echo" carries soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"',
          location: { document: 'request', line: 5, column: 5, xpath: '/Envelope/Body/Echo' },
        },
      ],
    },
    {
      id: 'R1109',
      title: 'The SOAPAction request header is a quoted string',
      level: 'REQUIRED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'failed',
      findings: [{ message: 'SOAPAction: urn:<script>alert(1)</script> is not a quoted string' }],
    },
    {
      id: 'R1124',
      title: 'A non-fault response carries HTTP status 200 or 202',
      level: 'RECOMMENDED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'warning',
      findings: [{ message: 'the HTTP status is 418', location: { document: 'response' } }],
    },
    {
      id: 'R1141',
      title: 'Content-Type states a charset parameter',
      level: 'REQUIRED',
      section: '3.4 Use of SOAP in HTTP',
      result: 'passed',
      findings: [],
    },
    {
      id: 'R2211',
      title: 'An rpc-literal part accessor carries no xsi:nil',
      level: 'REQUIRED',
      section: '4.4 rpc-literal',
      result: 'notApplicable',
      findings: [],
    },
  ],
};

const OPTIONS = { title: 'Echo — Add', generatedAt: '2026-01-02T03:04:05.000Z' } as const;

describe('renderWsiReportHtml', () => {
  it('renders a self-contained document with no external references', () => {
    const html = renderWsiReportHtml(REPORT, { ...OPTIONS, verbose: true });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc=/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/https?:\/\/(?!example\.invalid|schemas\.xmlsoap\.org)/);
  });

  it('matches the snapshot for a fixed generatedAt', () => {
    expect(renderWsiReportHtml(REPORT, { ...OPTIONS, verbose: true })).toMatchSnapshot();
  });

  it('escapes every value that reaches the markup', () => {
    const html = renderWsiReportHtml(REPORT, { ...OPTIONS, verbose: true });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('example.invalid/wsi?a=1&amp;b=2');
    expect(html).toContain('soap:encodingStyle=&quot;http');
    expect(escapeHtml(`<a href='x'>&</a>`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('carries the summary counts and the heading', () => {
    const html = renderWsiReportHtml(REPORT, OPTIONS);
    expect(html).toContain('WS-I BP1.1 report — Echo — Add');
    expect(html).toContain('Passed: <span class="count">12</span>');
    expect(html).toContain('Not applicable: <span class="count">8</span>');
    expect(html).toContain('2026-01-02T03:04:05.000Z');
  });

  it('drops the non-failing rows unless verbose', () => {
    const quiet = renderWsiReportHtml(REPORT, OPTIONS);
    expect(quiet).toContain('R1015');
    expect(quiet).toContain('R1124');
    expect(quiet).not.toContain('R1141');
    expect(quiet).not.toContain('R2211');
    expect(renderWsiReportHtml(REPORT, { ...OPTIONS, verbose: true })).toContain('R2211');
  });

  it('renders a placeholder when there is nothing to show', () => {
    const empty = renderWsiReportHtml({ ...REPORT, assertions: [] }, OPTIONS);
    expect(empty).toContain('No assertions to show.');
    expect(empty).not.toContain('<table>');
  });

  it('renders a finding with a line but no xpath, and one with neither', () => {
    const html = renderWsiReportHtml(
      {
        ...REPORT,
        assertions: [
          {
            ...REPORT.assertions[0]!,
            findings: [
              { message: 'with a line', location: { document: 'request', line: 9 } },
              { message: 'with nothing' },
            ],
          },
        ],
      },
      { ...OPTIONS, verbose: true },
    );
    expect(html).toContain('(request:9)');
    expect(html).toContain('<li>with nothing</li>');
  });
});
