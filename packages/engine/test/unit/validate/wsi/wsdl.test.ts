import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../../src/import.js';
import { WSI_WSDL_ASSERTIONS } from '../../../../src/validate/wsi/assertions/index.js';
import { runWsdlAssertions, wsiProblems, wsiWsdlContext } from '../../../../src/validate/wsi/run-wsdl.js';
import type { WsiWsdlContext } from '../../../../src/validate/wsi/types.js';

const fixtureRoot = fileURLToPath(new URL('../../../../../../fixtures/wsdl/crafted/', import.meta.url));

async function contextFor(path: string): Promise<WsiWsdlContext> {
  const result = await importDefinition({ kind: 'file', path });
  return wsiWsdlContext(result);
}

const compliantPath = `${fixtureRoot}wsi-compliant/service.wsdl`;

describe('WS-I BP 1.1 WSDL assertions', () => {
  let compliant: WsiWsdlContext;

  beforeAll(async () => {
    compliant = await contextFor(compliantPath);
  });

  it('registers a catalogue of at least 30 assertions with unique, ordered ids', () => {
    const ids = WSI_WSDL_ASSERTIONS.map((assertion) => assertion.id);
    expect(ids.length).toBeGreaterThanOrEqual(30);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('reports no failure for the compliant fixture', () => {
    const report = runWsdlAssertions(compliant, { verbose: true });
    const offenders = report.assertions.filter(
      (assertion) => assertion.result !== 'passed' && assertion.result !== 'notApplicable',
    );
    expect(offenders).toEqual([]);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.warning).toBe(0);
    expect(report.summary.passed + report.summary.notApplicable).toBe(WSI_WSDL_ASSERTIONS.length);
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.summary.notApplicable).toBeGreaterThan(0);
    expect(report.target).toContain('wsi-compliant');
    expect(report.profile).toBe('BP1.1');
  });

  describe.each(WSI_WSDL_ASSERTIONS.map((assertion) => [assertion.id, assertion] as const))('%s', (id, assertion) => {
    it('passes or does not apply to the compliant fixture', () => {
      const [report] = runWsdlAssertions(compliant, { ids: [id], verbose: true }).assertions;
      expect(report?.result === 'passed' || report?.result === 'notApplicable').toBe(true);
    });

    it('reports exactly one finding for its violation fixture', async () => {
      const context = await contextFor(`${fixtureRoot}wsi-violations/${id}.wsdl`);
      const [report] = runWsdlAssertions(context, { ids: [id], verbose: true }).assertions;
      expect(report?.result).toBe(assertion.level === 'REQUIRED' ? 'failed' : 'warning');
      expect(report?.findings).toHaveLength(1);
      expect(report?.findings[0]?.message).not.toBe('');
      expect(report?.findings[0]?.location?.document).toContain(`${id}.wsdl`);
      expect(report?.findings[0]?.location?.xpath).toContain('definitions');
    });

    it('is the only assertion its violation fixture trips', async () => {
      const context = await contextFor(`${fixtureRoot}wsi-violations/${id}.wsdl`);
      const report = runWsdlAssertions(context, { verbose: true });
      const collateral = report.assertions.filter(
        (entry) => entry.id !== id && entry.result !== 'passed' && entry.result !== 'notApplicable',
      );
      expect(collateral.map((entry) => entry.id)).toEqual([]);
    });
  });

  it('fails R2105 for an inline schema whose targetNamespace is empty', async () => {
    const context = await contextFor(`${fixtureRoot}wsi-compliant/service.wsdl`);
    const empty = await importDefinition({
      kind: 'text',
      location: 'inline:empty-tns.wsdl',
      text: `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions name="S" targetNamespace="urn:wb:wsi"
                  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <wsdl:types>
    <xsd:schema targetNamespace=""/>
  </wsdl:types>
</wsdl:definitions>`,
    });
    const [report] = runWsdlAssertions(wsiWsdlContext(empty), { ids: ['R2105'], verbose: true }).assertions;
    expect(report?.result).toBe('failed');
    expect(report?.findings[0]?.message).toContain('empty targetNamespace');
    // The compliant fixture, which declares a real one, still passes.
    const [ok] = runWsdlAssertions(context, { ids: ['R2105'], verbose: true }).assertions;
    expect(ok?.result).toBe('passed');
  });

  it('counts a header-bound part as bound for R2209', async () => {
    const context = await contextFor(`${fixtureRoot}soap-headers/service.wsdl`);
    const [report] = runWsdlAssertions(context, { ids: ['R2209'], verbose: true }).assertions;
    expect(report?.findings).toEqual([]);
    expect(report?.result).toBe('passed');
  });

  it('still reports a part bound to no SOAP construct at all', async () => {
    const context = await contextFor(`${fixtureRoot}wsi-violations/R2209.wsdl`);
    const [report] = runWsdlAssertions(context, { ids: ['R2209'], verbose: true }).assertions;
    expect(report?.result).toBe('warning');
    expect(report?.findings[0]?.message).toContain('extra');
  });

  it('flags a fault part bound to no soapbind:fault, and passes when one binds it', async () => {
    const unbound = await contextFor(`${fixtureRoot}wsi-fault-parts/unbound-fault.wsdl`);
    const [report] = runWsdlAssertions(unbound, { ids: ['R2209'], verbose: true }).assertions;
    expect(report?.result).toBe('warning');
    expect(report?.findings.map((finding) => finding.message).join('\n')).toContain('detail');
    // The compliant fixture binds the very same fault message with a soapbind:fault.
    const [ok] = runWsdlAssertions(compliant, { ids: ['R2209'], verbose: true }).assertions;
    expect(ok?.result).toBe('passed');
  });

  it('omits passing rows unless verbose, but always counts them', async () => {
    const context = await contextFor(`${fixtureRoot}wsi-violations/R2204.wsdl`);
    const quiet = runWsdlAssertions(context);
    const verbose = runWsdlAssertions(context, { verbose: true });
    expect(quiet.summary).toEqual(verbose.summary);
    expect(quiet.assertions.every((assertion) => assertion.result !== 'passed')).toBe(true);
    expect(quiet.assertions.length).toBeLessThan(verbose.assertions.length);
    expect(quiet.assertions.some((assertion) => assertion.id === 'R2204')).toBe(true);
  });

  it('runs only the requested assertion ids', () => {
    const report = runWsdlAssertions(compliant, { ids: ['R2702', 'R9999'], verbose: true });
    expect(report.assertions.map((assertion) => assertion.id)).toEqual(['R2702']);
  });

  it('flattens findings into validation problems', async () => {
    const context = await contextFor(`${fixtureRoot}wsi-violations/R2112.wsdl`);
    const problems = wsiProblems(runWsdlAssertions(context, { ids: ['R2112'] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ severity: 'warning', code: 'R2112', source: 'ws-i' });
    expect(problems[0]?.message).toContain('R2112');
    expect(problems[0]?.path).toContain('R2112.wsdl#/definitions');
    expect(problems[0]?.path).toContain('schema');
    expect(problems[0]?.line).toBeGreaterThan(0);
  });

  it.each([
    'nested-imports',
    'chameleon-include',
    'rpc-literal',
    'rpc-encoded',
    'soap-headers',
    'attachments',
    'schema-constructs',
    'ws-addressing',
  ])('analyses the %s fixture without throwing', async (name) => {
    const context = await contextFor(`${fixtureRoot}${name}/service.wsdl`);
    const report = runWsdlAssertions(context, { verbose: true });
    expect(report.assertions).toHaveLength(WSI_WSDL_ASSERTIONS.length);
    const { passed, failed, warning, notApplicable } = report.summary;
    expect(passed + failed + warning + notApplicable).toBe(WSI_WSDL_ASSERTIONS.length);
  });

  it('reports the SOAP-encoded fixture as out of profile', async () => {
    const context = await contextFor(`${fixtureRoot}rpc-encoded/service.wsdl`);
    const report = runWsdlAssertions(context);
    const failedIds = report.assertions.map((assertion) => assertion.id);
    expect(failedIds).toContain('R2706');
    expect(failedIds).toContain('R2110');
    expect(failedIds).toContain('R2111');
  });

  it('keeps a finding without a location out of the problem positions', () => {
    const problems = wsiProblems({
      target: 'inline:wsdl',
      profile: 'BP1.1',
      summary: { passed: 0, failed: 1, warning: 0, notApplicable: 0 },
      assertions: [
        {
          id: 'R2001',
          title: 'title',
          level: 'REQUIRED',
          section: 'section',
          result: 'failed',
          findings: [{ message: 'no position' }],
        },
      ],
    });
    expect(problems[0]).toEqual({
      severity: 'error',
      code: 'R2001',
      message: 'R2001: no position',
      source: 'ws-i',
    });
  });

  it('flattens a required-level finding as an error', async () => {
    const context = await contextFor(`${fixtureRoot}wsi-violations/R2702.wsdl`);
    const problems = wsiProblems(runWsdlAssertions(context, { ids: ['R2702'] }));
    expect(problems[0]?.severity).toBe('error');
  });
});
