import { describe, expect, it } from 'vitest';
import { mapOcAuth } from '../../../../src/import/opencollection/auth.js';
import { ReportBuilder } from '../../../../src/import/report.js';

describe('mapOcAuth: digest and AWS Signature', () => {
  it('maps digest with its user name, and warns about a literal password', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth({ type: 'digest', username: '{{user}}', password: 'hunter2' }, 'D', report).auth).toEqual({
      type: 'digest',
      username: '${user}',
    });
    expect(report.build().warnings).toEqual(['D: the digest credential was not imported; set it on the request or API.']);
  });

  it('maps digest without a password quietly', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth({ type: 'digest', username: 'u' }, 'D', report).auth).toEqual({ type: 'digest', username: 'u' });
    expect(report.build().warnings).toEqual([]);
  });

  it('maps awsv4 to AWS Signature v4 with region and service, never its keys', () => {
    const report = new ReportBuilder();
    const auth = mapOcAuth(
      {
        type: 'awsv4',
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        sessionToken: '',
        region: '{{region}}',
        service: 'execute-api',
      },
      'A',
      report,
    ).auth;
    expect(auth).toEqual({ type: 'aws-sigv4', region: '${region}', service: 'execute-api' });
    expect(JSON.stringify(auth)).not.toContain('secret');
    expect(report.build().warnings).toEqual(['A: the awsv4 credential was not imported; set it on the request or API.']);
  });
});
