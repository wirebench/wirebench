import { describe, expect, it } from 'vitest';
import { OpenApiError } from '../../../../../src/errors.js';
import { lintOpenApi } from '../../../../../src/rest/openapi/lint/run.js';
import { HYGIENE_RULES } from '../../../../../src/rest/openapi/lint/hygiene.js';
import { lintWithRules } from '../../../../../src/rest/openapi/lint/run.js';
import { brief, fixture, recordingFetch } from './helpers.js';

const hygiene = async (name: string) =>
  lintWithRules(await fixture(name), HYGIENE_RULES, { fetchDocument: recordingFetch().fetchDocument });

describe('hygiene rules', () => {
  it.each(['clean-2.0.yaml', 'clean-3.0.yaml', 'clean-3.1.yaml', 'clean-3.2.yaml'])(
    'finds nothing in %s',
    async (name) => {
      const report = await hygiene(name);
      expect(brief(report.findings)).toEqual([]);
    },
  );

  it('reports the version it read', async () => {
    const report = await hygiene('clean-3.2.yaml');
    expect(report).toMatchObject({ version: '3.2', declaredVersion: '3.2.0' });
  });

  it('finds every hygiene problem in a 3.1 document, sorted by position', async () => {
    const report = await hygiene('noisy-3.1.yaml');
    expect(brief(report.findings)).toEqual([
      'info-description /info',
      'operation-description /paths/~1things/get',
      'operation-operationId /paths/~1things/get',
      'operation-success-response /paths/~1things/get',
      'operation-description /paths/~1things/post',
      'parameter-description /paths/~1things/post/parameters/0',
      'media-example /paths/~1things/post/requestBody/content/application~1json',
      'inline-object-schema /paths/~1things/post/requestBody/content/application~1json/schema',
      'operation-operationId-unique /paths/~1things~1{id}/get/operationId',
      'schema-description /components/schemas/Thing',
    ]);
  });

  it('flags a Swagger 2.0 body parameter declared inline, and not a 3.x query parameter', async () => {
    const report = await hygiene('noisy-2.0.yaml');
    expect(brief(report.findings)).toContain('inline-object-schema /paths/~1things/post/parameters/0/schema');
  });

  it('gives each finding a 1-based range in the root document', async () => {
    const input = await fixture('noisy-3.1.yaml');
    const report = await lintWithRules(input, HYGIENE_RULES, { fetchDocument: recordingFetch().fetchDocument });
    const info = report.findings.find((finding) => finding.rule === 'info-description');
    expect(info).toMatchObject({ severity: 'warning', source: input.location, range: { start: { line: 2 } } });
    const unique = report.findings.find((finding) => finding.rule === 'operation-operationId-unique');
    expect(unique?.severity).toBe('error');
  });

  it('lists every rule it ran', async () => {
    const report = await hygiene('clean-3.0.yaml');
    expect(report.rules.map((rule) => rule.id)).toEqual(HYGIENE_RULES.map((rule) => rule.id));
    expect(report.rules.every((rule) => rule.ruleset === 'hygiene')).toBe(true);
  });

  it('refuses Swagger 1.x', async () => {
    const input = await fixture('swagger-1.2.json');
    await expect(lintOpenApi(input, { fetchDocument: recordingFetch().fetchDocument })).rejects.toMatchObject({
      code: 'lint-unsupported-version',
    });
  });

  it('refuses text that is not a document', async () => {
    const error = await lintOpenApi(
      { text: '{ nope', location: 'inline:x' },
      {
        fetchDocument: recordingFetch().fetchDocument,
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenApiError);
    expect(error).toMatchObject({ code: 'openapi-malformed' });
  });
});
