/**
 * The signer against AWS's published Signature Version 4 test suite (`aws-sig-v4-test-suite`, the
 * `get-vanilla` … `post-sts-header-before` cases) and the S3 documentation's presigned-URL example.
 * Every case signs all the headers it lists, as the suite does; the canonical request, the string to
 * sign and the `Authorization` must match the suite byte for byte.
 */
import { describe, expect, it } from 'vitest';
import { signSigV4, sigV4SignedHeaderNames } from '#core/http/auth/sigv4';

const SUITE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
};
const AT = Date.UTC(2015, 7, 30, 12, 36, 0);
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SCOPE = 'AKIDEXAMPLE/20150830/us-east-1/service/aws4_request';

interface SuiteCase {
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly sessionToken?: string;
  readonly creq: string;
  readonly signedHeaders: string;
  readonly signature: string;
}

const TOKEN =
  'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==';
const UNRESERVED = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const CASES: readonly SuiteCase[] = [
  {
    name: 'get-vanilla',
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: {},
    creq: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date',
    signature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  },
  {
    name: 'post-vanilla',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: {},
    creq: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date',
    signature: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
  },
  {
    name: 'get-vanilla-query-order-key-case',
    method: 'GET',
    url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
    headers: {},
    creq: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date',
    signature: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
  },
  {
    name: 'get-vanilla-query-unreserved',
    method: 'GET',
    url: `https://example.amazonaws.com/?${UNRESERVED}=${UNRESERVED}`,
    headers: {},
    creq: `GET\n/\n${UNRESERVED}=${UNRESERVED}\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date',
    signature: '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197',
  },
  {
    name: 'post-x-www-form-urlencoded',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'Param1=value1',
    creq: `POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e`,
    signedHeaders: 'content-type;host;x-amz-date',
    signature: 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
  },
  {
    name: 'get-header-value-trim',
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' },
    creq: `GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\nhost;my-header1;my-header2;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;my-header1;my-header2;x-amz-date',
    signature: 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736',
  },
  {
    name: 'get-utf8',
    method: 'GET',
    url: 'https://example.amazonaws.com/ሴ',
    headers: {},
    creq: `GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date',
    signature: '8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85',
  },
  {
    name: 'post-header-key-sort',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: { 'My-Header1': 'value1' },
    creq: `POST\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nx-amz-date:20150830T123600Z\n\nhost;my-header1;x-amz-date\n${EMPTY_HASH}`,
    signedHeaders: 'host;my-header1;x-amz-date',
    signature: 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c',
  },
  {
    name: 'post-sts-header-before',
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: {},
    sessionToken: TOKEN,
    creq: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\nx-amz-security-token:${TOKEN}\n\nhost;x-amz-date;x-amz-security-token\n${EMPTY_HASH}`,
    signedHeaders: 'host;x-amz-date;x-amz-security-token',
    signature: '85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead',
  },
];

describe('signSigV4 against the AWS test suite', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const signed = signSigV4(
        {
          method: testCase.method,
          url: testCase.url,
          headers: testCase.headers,
          body: new TextEncoder().encode(testCase.body ?? ''),
        },
        { ...SUITE, ...(testCase.sessionToken !== undefined ? { sessionToken: testCase.sessionToken } : {}) },
        { now: AT, signHeader: () => true },
      );
      expect(signed.canonicalRequest).toBe(testCase.creq);
      expect(signed.stringToSign.split('\n').slice(0, 3)).toEqual([
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
      ]);
      expect(signed.headers['Authorization']).toBe(
        `AWS4-HMAC-SHA256 Credential=${SCOPE}, SignedHeaders=${testCase.signedHeaders}, Signature=${testCase.signature}`,
      );
      expect(signed.headers['X-Amz-Date']).toBe('20150830T123600Z');
      expect(signed.url).toBe(testCase.url);
    });
  }

  it('produces the suite string to sign for get-vanilla', () => {
    const signed = signSigV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {} }, SUITE, {
      now: AT,
    });
    expect(signed.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    );
  });
});

describe('signSigV4 S3', () => {
  const S3 = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
  };
  const S3_AT = Date.UTC(2013, 4, 24, 0, 0, 0);

  it('matches the S3 documentation presigned URL example', () => {
    const signed = signSigV4(
      { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: {} },
      S3,
      { now: S3_AT, placement: 'query', expiresSeconds: 86400 },
    );
    expect(signed.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
    expect(signed.headers).toEqual({});
    expect(signed.canonicalRequest.endsWith('\nhost\nUNSIGNED-PAYLOAD')).toBe(true);
  });

  it('matches the S3 documentation GET Object example and sends the payload hash', () => {
    const signed = signSigV4(
      {
        method: 'GET',
        url: 'https://examplebucket.s3.amazonaws.com/test.txt',
        headers: { Range: 'bytes=0-9' },
      },
      S3,
      { now: S3_AT },
    );
    expect(signed.headers['X-Amz-Content-Sha256']).toBe(EMPTY_HASH);
    expect(signed.headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('encodes an S3 key once and keeps its dot segments', () => {
    const signed = signSigV4({ method: 'GET', url: 'https://b.s3.amazonaws.com/a%20b/./c', headers: {} }, S3, {
      now: S3_AT,
    });
    // The WHATWG URL parser drops `/./`, so the signer must read the path as written.
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/a%20b/./c');
  });
});

describe('signSigV4 encoding and header choice', () => {
  it('encodes a path segment twice for a service other than s3', () => {
    const signed = signSigV4({ method: 'GET', url: 'https://example.amazonaws.com/a%20b/c', headers: {} }, SUITE, {
      now: AT,
    });
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/a%2520b/c');
  });

  it('sorts repeated query names by value and encodes reserved characters', () => {
    const signed = signSigV4(
      { method: 'GET', url: 'https://example.amazonaws.com/?b=2&a=z&a=y&c=a%2Fb&d', headers: {} },
      SUITE,
      { now: AT },
    );
    expect(signed.canonicalRequest.split('\n')[2]).toBe('a=y&a=z&b=2&c=a%2Fb&d=');
  });

  it('by default signs host, content-type, range and x-amz-* only', () => {
    expect(
      sigV4SignedHeaderNames({
        'User-Agent': 'x',
        Connection: 'keep-alive',
        'Content-Type': 'application/json',
        'X-Amz-Target': 'DynamoDB_20120810.ListTables',
        Accept: '*/*',
      }),
    ).toEqual(['content-type', 'x-amz-target']);
  });

  it('presigns with the session token among the signed query parameters', () => {
    const signed = signSigV4(
      { method: 'GET', url: 'https://example.amazonaws.com/?z=1', headers: {} },
      { ...SUITE, sessionToken: 'tok/en+' },
      { now: AT, placement: 'query', expiresSeconds: 60 },
    );
    const query = new URL(signed.url).searchParams;
    expect(query.get('X-Amz-Security-Token')).toBe('tok/en+');
    expect(query.get('X-Amz-Expires')).toBe('60');
    expect(query.get('z')).toBe('1');
    expect(signed.canonicalRequest).toContain('X-Amz-Security-Token=tok%2Fen%2B');
    expect(signed.canonicalRequest.endsWith(`\nhost\n${EMPTY_HASH}`)).toBe(true);
  });

  it('keeps a non-default port in the host it signs', () => {
    const signed = signSigV4({ method: 'GET', url: 'http://127.0.0.1:8080/x', headers: {} }, SUITE, { now: AT });
    expect(signed.canonicalRequest).toContain('\nhost:127.0.0.1:8080\n');
  });
});
