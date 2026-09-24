import { describe, expect, it } from 'vitest';
import { isSensitiveHeaderName, isSensitiveQueryParam } from '../../../../src/redact/index.js';
import { detectInText, SECRET_TEXT_SCAN_LIMIT, shannonEntropy } from '../../../../src/secrets/scan/rules.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEsignatureFAKEsignature';
const GH = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';

function found(text: string, context = {}): [string, string][] {
  return detectInText(text, context).map((m) => [m.rule, text.slice(m.start, m.end)]);
}

describe('redaction predicates', () => {
  it('match the redaction header and query sets, case-insensitively', () => {
    expect(isSensitiveHeaderName('Authorization')).toBe(true);
    expect(isSensitiveHeaderName('X-API-Key')).toBe(true);
    expect(isSensitiveHeaderName('Accept')).toBe(false);
    expect(isSensitiveQueryParam('API_KEY')).toBe(true);
    expect(isSensitiveQueryParam('page')).toBe(false);
  });
});

describe('shape rules', () => {
  it('jwt: three base64url segments starting eyJ', () => {
    expect(found(`token is ${JWT} here`)).toEqual([['jwt', JWT]]);
  });
  it('jwt near miss: a lone eyJ segment is not a JWT', () => {
    expect(found('value eyJhbGciOiJIUzI1NiJ9 only')).toEqual([]);
  });
  it('bearer: the credential part only', () => {
    expect(found('Authorization: Bearer abc123def456ghi789')).toEqual([['bearer', 'abc123def456ghi789']]);
  });
  it('bearer carrying a JWT reports the JWT', () => {
    expect(found(`Bearer ${JWT}`)).toEqual([['jwt', JWT]]);
  });
  it('bearer near misses: a token reference, prose', () => {
    expect(found('Bearer ${secret:billing_token}')).toEqual([]);
    expect(found('Send a Bearer token to log in')).toEqual([]);
  });
  it('basic: base64 of user:password', () => {
    const encoded = Buffer.from('alice:FAKEpass').toString('base64');
    expect(found(`Basic ${encoded}`)).toEqual([['basic', encoded]]);
  });
  it('basic near miss: prose', () => {
    expect(found('Basic information about the API')).toEqual([]);
  });
  it('aws-key: AKIA/ASIA plus 16', () => {
    expect(found('id=AKIAFAKEFAKEFAKEFAKE;')).toEqual([['aws-key', 'AKIAFAKEFAKEFAKEFAKE']]);
    expect(found('ASIAFAKEFAKEFAKEFAKE')).toEqual([['aws-key', 'ASIAFAKEFAKEFAKEFAKE']]);
  });
  it('aws-key near miss: too short or part of a longer word', () => {
    expect(found('AKIAFAKE')).toEqual([]);
    expect(found('XAKIAFAKEFAKEFAKEFAKEX')).toEqual([]);
  });
  it('private-key: a whole PEM block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKE\n-----END RSA PRIVATE KEY-----';
    expect(found(`x\n${pem}\ny`)).toEqual([['private-key', pem]]);
  });
  it('private-key near miss: a public key or certificate', () => {
    expect(found('-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----')).toEqual([]);
  });
  it('vendor-token: GitHub and Slack', () => {
    expect(found(`t=${GH}`)).toEqual([['vendor-token', GH]]);
    expect(found('github_pat_FAKEFAKEFAKEFAKEFAKEFAKE_x')).toEqual([
      ['vendor-token', 'github_pat_FAKEFAKEFAKEFAKEFAKEFAKE_x'],
    ]);
    expect(found('xoxb-FAKE-FAKE-FAKE12')).toEqual([['vendor-token', 'xoxb-FAKE-FAKE-FAKE12']]);
  });
  it('vendor-token near miss: prefix alone', () => {
    expect(found('ghp_short xoxz-FAKEFAKEFAKE')).toEqual([]);
  });
});

describe('name rules on a stored value', () => {
  it('a sensitive header is a finding whatever the value', () => {
    expect(found('opaque', { fieldName: 'X-Api-Key', nameKind: 'header' })).toEqual([['sensitive-name', 'opaque']]);
  });
  it('a scheme prefix stays outside the range', () => {
    expect(found('Token opaque', { fieldName: 'Authorization', nameKind: 'header' })).toEqual([
      ['sensitive-name', 'opaque'],
    ]);
  });
  it('a low-entropy value under password is still a sensitive-name finding', () => {
    expect(found('changeme', { fieldName: 'password', nameKind: 'property' })).toEqual([
      ['sensitive-name', 'changeme'],
    ]);
  });
  it('a value that is a reference is not a finding', () => {
    expect(found('${secret:x}', { fieldName: 'password', nameKind: 'property' })).toEqual([]);
    expect(found('Bearer ${secret:x}', { fieldName: 'Authorization', nameKind: 'header' })).toEqual([]);
    expect(found('${#Project#pw}', { fieldName: 'password', nameKind: 'property' })).toEqual([]);
  });
  it('an empty or blank value is not a finding', () => {
    expect(found('  ', { fieldName: 'password', nameKind: 'property' })).toEqual([]);
  });
  it('high-entropy only under a secret-sounding name', () => {
    const random = 'q8Zr2LmX0vNf7TkPw3Yh9sBd';
    expect(shannonEntropy(random)).toBeGreaterThanOrEqual(3.5);
    expect(found(random, { fieldName: 'stripeApiKey', nameKind: 'field' })).toEqual([['high-entropy', random]]);
    expect(found(random, { fieldName: 'customerRef', nameKind: 'field' })).toEqual([]);
    expect(found('aaaaaaaaaaaaaaaaaaaaaaaa', { fieldName: 'stripeApiKey', nameKind: 'field' })).toEqual([]);
    expect(found('q8Zr2LmX', { fieldName: 'stripeApiKey', nameKind: 'field' })).toEqual([]);
  });
});

describe('name rules in a body', () => {
  it('JSON keys', () => {
    expect(
      found('{"user":"a","Password":"changeme","token":"${secret:t}"}', { contentType: 'application/json' }),
    ).toEqual([['sensitive-name', 'changeme']]);
  });
  it('XML element local names; a password digest is left alone', () => {
    const xml =
      '<wsse:Password Type="#PasswordText">FAKEpass</wsse:Password><wsse:Password Type="x#PasswordDigest">abc=</wsse:Password>';
    expect(found(xml, { contentType: 'text/xml' })).toEqual([['sensitive-name', 'FAKEpass']]);
  });
  it('form fields only for a form content type', () => {
    expect(found('user=a&client_secret=FAKEs3cret', { contentType: 'application/x-www-form-urlencoded' })).toEqual([
      ['sensitive-name', 'FAKEs3cret'],
    ]);
    expect(found('user=a&client_secret=FAKEs3cret', { contentType: 'text/plain' })).toEqual([]);
  });
  it('scans only the first 1 MiB', () => {
    const pad = 'x'.repeat(SECRET_TEXT_SCAN_LIMIT);
    expect(found(`${pad} ${GH}`)).toEqual([]);
    expect(found(`${GH} ${pad}`)).toEqual([['vendor-token', GH]]);
  });
});

describe('fix round 1: name parts and false positives', () => {
  const json = { contentType: 'application/json' };
  it('plain English and non-credential names are not high-entropy findings', () => {
    expect(found('{"keywords": "wireless noise cancelling headphones"}', json)).toEqual([]);
    expect(found('<secretaryName>Jane Q Example Person</secretaryName>', { contentType: 'text/xml' })).toEqual([]);
    expect(found('{"passwordPolicy": "At least 8 characters, one digit"}', json)).toEqual([]);
    expect(found('{"idempotencyKey": "3f2b8c1e-9a4d-4e7f-b6a2-1c5d8e9f0a3b"}', json)).toEqual([]);
    expect(found('{"cacheKey": "3f2b8c1e-9a4d-4e7f-b6a2-1c5d8e9f0a3b"}', json)).toEqual([]);
    expect(found('{"publicKeyPath": "/etc/ssl/certs/FakeExampleCert9.pem"}', json)).toEqual([]);
    expect(found('{"privateKeyFile": "C:\\\\keys\\\\FakeExample9Key.pem"}', json)).toEqual([]);
    expect(found('{"clientSecretUrl": "https://example.test/Fake9Path/x"}', json)).toEqual([]);
  });
  it('credential-like name parts are high-entropy findings', () => {
    const random = 'q8Zr2LmX0vNf7TkPw3Yh9sBd';
    expect(found(`{"dbPassword": "${random}"}`, json)).toEqual([['high-entropy', random]]);
    expect(found(`{"clientSecret": "${random}"}`, json)).toEqual([['high-entropy', random]]);
    expect(found('{"accessKey": "3f2b8c1e-9a4d-4e7f-b6a2-1c5d8e9f0a3b"}', json)).toEqual([
      ['high-entropy', '3f2b8c1e-9a4d-4e7f-b6a2-1c5d8e9f0a3b'],
    ]);
  });
  it('properties match sensitive names by word part', () => {
    expect(found('changeme', { fieldName: 'dbPassword', nameKind: 'property' })).toEqual([
      ['sensitive-name', 'changeme'],
    ]);
    expect(found('changeme', { fieldName: 'api_key', nameKind: 'property' })).toEqual([['sensitive-name', 'changeme']]);
    expect(found('x', { fieldName: 'keywords', nameKind: 'property' })).toEqual([]);
    expect(found('Jane', { fieldName: 'secretaryName', nameKind: 'property' })).toEqual([]);
  });
  it('a long alphabetic-only bearer token is a credential', () => {
    expect(found('Bearer xyzKQPabcdefghijklmnop')).toEqual([['bearer', 'xyzKQPabcdefghijklmnop']]);
  });
  it('Bearer in prose is not a credential', () => {
    expect(found('Send Bearer tokens/credentials here')).toEqual([]);
    expect(found('Bearer credentials')).toEqual([]);
  });
});

describe('issue 145: URL userinfo, CDATA, JSON numbers', () => {
  const json = { contentType: 'application/json' };
  const xml = { contentType: 'text/xml' };
  it('url-credentials: the password of a URL userinfo, anywhere', () => {
    expect(found('https://alice:FAKEpass@h.example/x?y=1')).toEqual([['url-credentials', 'FAKEpass']]);
    expect(found('{"dsn": "postgres://svc:FAKEpw%21@db:5432/app"}', json)).toEqual([['url-credentials', 'FAKEpw%21']]);
    expect(found('redis://:FAKEredis@cache:6379')).toEqual([['url-credentials', 'FAKEredis']]);
  });
  it('url-credentials near misses: no password, a port, a reference', () => {
    expect(found('https://alice@h.example/x')).toEqual([]);
    expect(found('https://alice:@h.example/x')).toEqual([]);
    expect(found('http://h.example:8080/a@b')).toEqual([]);
    expect(found('https://alice:${secret:pw}@h.example/x')).toEqual([]);
    expect(found('git@github.com:org/repo.git')).toEqual([]);
  });
  it('a sensitive element holding one CDATA section: the value inside it', () => {
    const text = '<wsse:Password Type="#PasswordText">\n  <![CDATA[ FAKE<pw> ]]>\n</wsse:Password>';
    const [m] = detectInText(text, xml);
    expect(m).toMatchObject({ rule: 'sensitive-name' });
    expect(text.slice(m!.start, m!.end)).toBe('FAKE<pw>');
    expect(found('<password><![CDATA[FAKEpw]]></password>', xml)).toEqual([['sensitive-name', 'FAKEpw']]);
  });
  it('CDATA near misses: a non-sensitive element, a digest, an empty section, a different close tag', () => {
    expect(found('<note><![CDATA[FAKEpw]]></note>', xml)).toEqual([]);
    expect(found('<Password Type="x#PasswordDigest"><![CDATA[abc=]]></Password>', xml)).toEqual([]);
    expect(found('<password><![CDATA[]]></password>', xml)).toEqual([]);
    expect(found('<password><![CDATA[FAKEpw]]></other>', xml)).toEqual([]);
    expect(found('<password>x<![CDATA[FAKEpw]]></password>', xml)).toEqual([]);
  });
  it('a sensitive element nested in a non-sensitive one is found; a sensitive parent of other elements is not', () => {
    expect(found('<Credentials><User>a</User><Password>FAKEpw</Password></Credentials>', xml)).toEqual([
      ['sensitive-name', 'FAKEpw'],
    ]);
    expect(found('<token><value>FAKEtok</value></token>', xml)).toEqual([]);
  });
  it('scans unclosed CDATA sections in linear time', () => {
    const text = '<password><![CDATA['.repeat(60_000);
    const started = performance.now();
    expect(found(text, xml)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
  it('scans a long run of scheme-like characters before a URL in linear time', () => {
    for (const run of ['a-', 'a.', 'a+']) {
      const text = `${run.repeat(150_000)} see https://example.com`;
      const started = performance.now();
      expect(found(text)).toEqual([]);
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
  it('url-credentials: an empty user, a scheme with a dash, a scheme after another scheme', () => {
    expect(found('redis://:FAKEpw@cache')).toEqual([['url-credentials', 'FAKEpw']]);
    expect(found('x-postgres://u:FAKEpw@h/db')).toEqual([['url-credentials', 'FAKEpw']]);
    expect(found('jdbc:mysql://u:FAKEpw@h/db')).toEqual([['url-credentials', 'FAKEpw']]);
  });
  it('url-credentials: the password after a user that is a ${…} expansion', () => {
    expect(found('https://${env:user}:FAKEpw@h.example/x')).toEqual([['url-credentials', 'FAKEpw']]);
    expect(found('https://pre${user}post:FAKEpw@h.example/x')).toEqual([['url-credentials', 'FAKEpw']]);
    expect(found('https://${env:user}:${secret:pw}@h.example/x')).toEqual([]);
  });
  it('url-credentials near miss: an obvious placeholder password', () => {
    for (const pw of ['password', 'PASSWORD', 'Pass', 'passwd', 'secret', '****', 'x', 'xxxx', 'XXXXXX']) {
      expect(found(`postgres://user:${pw}@localhost/db`)).toEqual([]);
    }
    expect(found('https://u:****@h')).toEqual([]);
    expect(found('postgres://user:FAKEpassword1@localhost/db')).toEqual([['url-credentials', 'FAKEpassword1']]);
    expect(found('postgres://user:xX*x@localhost/db')).toEqual([['url-credentials', 'xX*x']]);
  });
  it('a query pair in a URL carries its key as the match name', () => {
    const text = 'wss://h/socket?page=2&access%5Ftoken=FAKEtok';
    const matches = detectInText(text, { contentType: 'application/x-www-form-urlencoded', nameKind: 'query' });
    expect(matches).toEqual([
      { rule: 'sensitive-name', start: text.length - 7, end: text.length, name: 'access_token' },
    ]);
  });
  it('a number under a sensitive JSON key; booleans, null and other keys are not', () => {
    expect(found('{"password": 123456, "page": 2, "token": true, "secret": null}', json)).toEqual([
      ['sensitive-name', '123456'],
    ]);
    expect(found('{"token":-1.5e3}', json)).toEqual([['sensitive-name', '-1.5e3']]);
    expect(found('{"password": 12ab}', json)).toEqual([]);
  });
});
