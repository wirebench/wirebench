import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HYGIENE_RULES } from '#protocol-rest/rest/openapi/lint/hygiene';
import { lintWithRules } from '#protocol-rest/rest/openapi/lint/run';
import { referenceLocation, runnerSource } from '#protocol-rest/rest/openapi/lint/resolver';
import { FIXTURES, fixture, recordingFetch } from './helpers.js';

const REMOTE = 'https://remote.test/paths.yaml';
const REMOTE_TEXT = 'get:\n  summary: Remote.\n  responses:\n    "200": { description: ok }\n';

describe('the reference fence', () => {
  it('follows a reference inside the root folder and lints what it pulls in', async () => {
    const { fetchDocument, asked } = recordingFetch({ [REMOTE]: REMOTE_TEXT });
    const report = await lintWithRules(await fixture('multi/root.yaml'), HYGIENE_RULES, { fetchDocument });
    // Canonical, as findings spell it: on Windows the fixture folder's drive letter may come either case.
    const inside = referenceLocation(pathToFileURL(`${FIXTURES}multi/paths/pets.yaml`).href);
    expect(asked.map(referenceLocation)).toContain(inside);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: 'operation-operationId', source: inside, path: '/get' }),
    );
  });

  it('never reads a file outside the root folder, and says why', async () => {
    const { fetchDocument, asked } = recordingFetch({ [REMOTE]: REMOTE_TEXT });
    const report = await lintWithRules(await fixture('multi/root.yaml'), HYGIENE_RULES, { fetchDocument });
    expect(asked.some((location) => location.endsWith('/lint/outside.yaml'))).toBe(false);
    const refused = report.findings.find((finding) => finding.path === '/paths/~1escape/$ref');
    expect(refused).toMatchObject({ rule: 'invalid-ref', severity: 'error' });
  });

  it('never fetches a remote reference from a local document unless allowed', async () => {
    const { fetchDocument, asked } = recordingFetch({ [REMOTE]: REMOTE_TEXT });
    const report = await lintWithRules(await fixture('multi/root.yaml'), HYGIENE_RULES, { fetchDocument });
    expect(asked).not.toContain(REMOTE);
    const refused = report.findings.find((finding) => finding.path === '/paths/~1remote/$ref');
    expect(refused?.rule).toBe('invalid-ref');
    expect(refused?.message).toContain('remote reference');
  });

  it('fetches a remote reference when allowRemoteRefs is set, still refusing the escape', async () => {
    const { fetchDocument, asked } = recordingFetch({ [REMOTE]: REMOTE_TEXT });
    const report = await lintWithRules(await fixture('multi/root.yaml'), HYGIENE_RULES, {
      fetchDocument,
      allowRemoteRefs: true,
    });
    expect(asked).toContain(REMOTE);
    expect(report.findings.some((finding) => finding.source === REMOTE)).toBe(true);
    expect(asked.some((location) => location.endsWith('/lint/outside.yaml'))).toBe(false);
  });

  it('lets a remote document reference other remote documents, never a local file', async () => {
    const root = 'https://api.test/openapi.yaml';
    const text = [
      'openapi: 3.0.3',
      'info: { title: t, version: "1", description: d }',
      'paths:',
      `  /remote: { $ref: "${REMOTE}" }`,
      '  /local: { $ref: "file:///etc/hosts" }',
    ].join('\n');
    const { fetchDocument, asked } = recordingFetch({ [REMOTE]: REMOTE_TEXT });
    const report = await lintWithRules({ text, location: root }, HYGIENE_RULES, { fetchDocument });
    expect(asked).toContain(REMOTE);
    expect(asked).not.toContain('file:///etc/hosts');
    expect(report.findings.find((finding) => finding.path === '/paths/~1local/$ref')?.rule).toBe('invalid-ref');
  });

  it('maps the runner names of documents back to locations', () => {
    // Built from the platform's own temp folder, so the path is native everywhere (a drive on Windows).
    const path = join(tmpdir(), 'a b.yaml');
    const href = pathToFileURL(path).href;
    expect(runnerSource(href)).toBe(path);
    expect(referenceLocation(path)).toBe(referenceLocation(href));
    expect(referenceLocation(REMOTE)).toBe(REMOTE);
    expect(runnerSource(REMOTE)).toBe(REMOTE);
  });

  it('spells a Windows drive letter one way, whatever case the runner used', () => {
    expect(referenceLocation('file:///d:/a/x.yaml')).toBe(referenceLocation('file:///D:/a/x.yaml'));
    expect(referenceLocation('file:///D:/a/x.yaml')).toMatch(/^file:\/\/\/D:/);
  });
});
