// @vitest-environment node
/**
 * An AWS Signature v4 send's canonical request on its way to the HTTP Log (#339): the session token
 * and a presign's credential are masked unless the session shows secrets.
 */
import { describe, expect, it } from 'vitest';
import { toAuthSummaryWire } from '../src/main/engine-wire.js';
import { containsRedaction, recordAuthValues, redactSecretText } from '../src/main/redact.js';

const HEADER_CREQ = [
  'GET',
  '/',
  '',
  'host:example.amazonaws.com',
  'x-amz-date:20261012T000000Z',
  'x-amz-security-token:TOKEN-339',
  '',
  'host;x-amz-date;x-amz-security-token',
  'e3b0',
].join('\n');

describe('toAuthSummaryWire', () => {
  const auth = {
    scheme: 'aws-sigv4' as const,
    challenged: false,
    attempts: 1 as const,
    signature: { canonicalRequest: HEADER_CREQ, stringToSign: 'AWS4-HMAC-SHA256\n20261012T000000Z' },
  };

  it('masks the session token line unless secrets are shown', () => {
    const masked = toAuthSummaryWire(auth, false);
    expect(masked.signature?.canonicalRequest).not.toContain('TOKEN-339');
    expect(masked.signature?.canonicalRequest).toContain('x-amz-security-token:<redacted>');
    expect(masked.signature?.stringToSign).toBe(auth.signature.stringToSign);
    expect(toAuthSummaryWire(auth, true).signature?.canonicalRequest).toContain('TOKEN-339');
  });

  it('masks a presign credential and token in the canonical query', () => {
    const presigned = {
      ...auth,
      signature: {
        canonicalRequest:
          'GET\n/k\nX-Amz-Credential=AKID339%2F20261012&X-Amz-Security-Token=TOK339&X-Amz-Date=1\nhost:h',
        stringToSign: 's',
      },
    };
    const text = toAuthSummaryWire(presigned, false).signature?.canonicalRequest ?? '';
    expect(text).not.toContain('AKID339');
    expect(text).not.toContain('TOK339');
    expect(text).toContain('X-Amz-Date=1');
  });

  it('carries no signature for any other scheme', () => {
    expect(toAuthSummaryWire({ scheme: 'digest', challenged: true, attempts: 2 }, false)).toEqual({
      scheme: 'digest',
      challenged: true,
      attempts: 2,
    });
  });
});

describe('recordAuthValues', () => {
  it('records the AWS access key id and session token, never the secret key', () => {
    recordAuthValues({
      type: 'aws-sigv4',
      region: 'r',
      service: 's',
      accessKeyId: 'AKIDRECORD339',
      secretAccessKey: 'SECRETRECORD339',
      sessionToken: 'TOKENRECORD339',
      placement: 'header',
    });
    expect(containsRedaction(redactSecretText('echo AKIDRECORD339', { show: false }))).toBe(true);
    expect(containsRedaction(redactSecretText('echo TOKENRECORD339', { show: false }))).toBe(true);
    expect(redactSecretText('echo SECRETRECORD339', { show: false })).toBe('echo SECRETRECORD339');
  });
});
