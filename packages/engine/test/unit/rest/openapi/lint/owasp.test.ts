import { describe, expect, it } from 'vitest';
import { OWASP_RULES, loopback, plainHttpHost } from '../../../../../src/rest/openapi/lint/owasp.js';
import { lintWithRules } from '../../../../../src/rest/openapi/lint/run.js';
import { brief, fixture, recordingFetch } from './helpers.js';

const owasp = async (name: string) =>
  lintWithRules(await fixture(name), OWASP_RULES, { fetchDocument: recordingFetch().fetchDocument });

const inline = (text: string) =>
  lintWithRules({ text, location: 'inline:test' }, OWASP_RULES, { fetchDocument: recordingFetch().fetchDocument });

describe('owasp rules', () => {
  it.each(['clean-2.0.yaml', 'clean-3.0.yaml', 'clean-3.1.yaml', 'clean-3.2.yaml'])(
    'finds nothing in %s (loopback http and a deliberate security: [] included)',
    async (name) => {
      expect(brief((await owasp(name)).findings)).toEqual([]);
    },
  );

  it('finds plain HTTP, undefined schemes and undefined scopes in a 3.1 document', async () => {
    const report = await owasp('noisy-3.1.yaml');
    expect(brief(report.findings)).toEqual([
      'owasp-plain-http /servers/0/url',
      'owasp-operation-security /paths/~1things/get',
      'owasp-operation-security /paths/~1things/post',
      'owasp-security-scheme-undefined /paths/~1things~1{id}/get/security/0/missing',
      'owasp-oauth-scope-undefined /paths/~1things~1{id}/get/security/2/oauth/0',
      'owasp-plain-http /components/securitySchemes/oauth/flows/authorizationCode/authorizationUrl',
    ]);
    expect(report.findings.find((finding) => finding.rule === 'owasp-plain-http')?.severity).toBe('error');
    expect(report.findings.find((finding) => finding.rule === 'owasp-operation-security')?.severity).toBe('warning');
  });

  it('finds no security scheme at all, and Swagger 2.0 served over http', async () => {
    const report = await owasp('noisy-2.0.yaml');
    expect(brief(report.findings)).toEqual(['owasp-security-defined ', 'owasp-plain-http-scheme /schemes/0']);
    // Most specs define no scheme by design: a warning, so an import does not read as broken (N05).
    expect(report.findings.find((finding) => finding.rule === 'owasp-security-defined')?.severity).toBe('warning');
  });

  it('does not flag a Swagger 2.0 API on localhost', async () => {
    const report = await inline(
      'swagger: "2.0"\ninfo: { title: t, version: "1" }\nhost: localhost:8080\nschemes: [http]\npaths: {}\nsecurityDefinitions: { k: { type: apiKey, in: header, name: K } }\n',
    );
    expect(brief(report.findings)).toEqual([]);
  });

  it('checks 2.0 OAuth scopes defined on the scheme itself', async () => {
    const report = await inline(
      [
        'swagger: "2.0"',
        'info: { title: t, version: "1" }',
        'host: api.test',
        'schemes: [https]',
        'security: [{ o: [read, admin] }]',
        'paths: {}',
        'securityDefinitions:',
        '  o: { type: oauth2, flow: application, tokenUrl: "https://a.test/t", scopes: { read: Read } }',
      ].join('\n'),
    );
    expect(brief(report.findings)).toEqual(['owasp-oauth-scope-undefined /security/0/o/1']);
  });

  it('reads the host of an http URL, templates included', () => {
    expect(plainHttpHost('http://{env}.api.test/v1')).toBe('{env}.api.test');
    expect(plainHttpHost('HTTP://user@Host.test:80/x')).toBe('host.test');
    expect(plainHttpHost('http://[::1]:8080/')).toBe('[::1]');
    expect(plainHttpHost('https://api.test')).toBeUndefined();
    expect(['localhost', 'a.localhost', '127.0.0.1', '[::1]'].every(loopback)).toBe(true);
    expect(loopback('127.example.test')).toBe(false);
  });
});
