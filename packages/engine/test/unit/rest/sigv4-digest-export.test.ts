/**
 * AWS Signature v4 and Digest in what a send is shown as before it is made: the Headers preview
 * (#346) and the cURL export.
 */
import { describe, expect, it } from 'vitest';
import type { SendAuth } from '#core/http/auth/send-auth';
import { CURL_REDACTED, restToCurl } from '#protocol-rest/rest/curl';
import { previewRestHeaders } from '#protocol-rest/rest/header-preview';
import { entry } from '#protocol-rest/rest/model';
import type { RestSendInput } from '#protocol-rest/rest/send';

const SIGV4: SendAuth = {
  type: 'aws-sigv4',
  region: 'eu-west-1',
  service: 's3',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  sessionToken: 'TOKEN',
  placement: 'header',
};
const DIGEST: SendAuth = { type: 'digest', username: 'admin', password: 'pw' };

function input(auth: SendAuth, headers = [entry('Content-Type', 'application/json')]): RestSendInput {
  return {
    baseUrl: 'https://bucket.s3.eu-west-1.amazonaws.com',
    request: {
      method: 'PUT',
      url: '/key.json',
      pathParams: [],
      query: [],
      headers,
      body: { kind: 'raw', language: 'json', text: '{}' },
    },
    settings: { timeoutMs: 1_000, followRedirects: false },
    auth,
  };
}

describe('previewRestHeaders', () => {
  it('lists the headers a SigV4 signature adds, computed at the given time', async () => {
    const rows = await previewRestHeaders(input(SIGV4), { now: Date.UTC(2026, 9, 12, 8, 0, 0) });
    const auth = rows.filter((row) => row.source === 'auth');
    expect(auth.map((row) => row.name)).toEqual([
      'X-Amz-Date',
      'X-Amz-Security-Token',
      'X-Amz-Content-Sha256',
      'Authorization',
    ]);
    expect(auth[0]?.value).toBe('20261012T080000Z');
    expect(auth[3]?.value).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261012\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
    );
  });

  it('marks the signature overridden by a typed Authorization, and shows none when presigned', async () => {
    const typed = await previewRestHeaders(input(SIGV4, [entry('Authorization', 'Bearer x')]));
    expect(typed.find((row) => row.source === 'auth' && row.name === 'Authorization')?.state).toBe('overridden');
    const presigned = await previewRestHeaders(input({ ...SIGV4, placement: 'query' }));
    expect(presigned.some((row) => row.source === 'auth')).toBe(false);
  });

  it('shows Digest as a handshake row', async () => {
    const rows = await previewRestHeaders(input(DIGEST));
    expect(rows.find((row) => row.source === 'handshake')).toMatchObject({ name: 'Authorization', value: 'Digest' });
  });
});

describe('restToCurl', () => {
  it('exports Digest as --digest, masked unless asked', () => {
    expect(restToCurl(input(DIGEST))).toContain(`--digest --user 'admin:${CURL_REDACTED}'`);
    expect(restToCurl(input(DIGEST), { redactSecrets: false })).toContain("--digest --user 'admin:pw'");
  });

  it('exports a SigV4 header signature as --aws-sigv4 with the session token header', () => {
    const shown = restToCurl(input(SIGV4), { redactSecrets: false });
    expect(shown).toContain("--aws-sigv4 'aws:amz:eu-west-1:s3' --user 'AKID:SECRET'");
    expect(shown).toContain("--header 'X-Amz-Security-Token: TOKEN'");
    const masked = restToCurl(input(SIGV4));
    expect(masked).not.toContain('SECRET');
    expect(masked).not.toContain('TOKEN');
    expect(masked).not.toContain('AKID');
  });

  it('leaves a presigned SigV4 out of the command', () => {
    expect(restToCurl(input({ ...SIGV4, placement: 'query' }))).not.toContain('--aws-sigv4');
  });
});
