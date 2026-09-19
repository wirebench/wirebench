import { describe, expect, it } from 'vitest';
import { soapToCurl, fromCurl } from '../../../src/http/curl.js';
import type { SoapSendInput } from '../../../src/types.js';

const INPUT: SoapSendInput = {
  endpoint: 'https://example.com/calc?wsdl',
  envelopeXml:
    "<soapenv:Envelope><soapenv:Body><tem:Add><tem:intA>it's 5</tem:intA></tem:Add></soapenv:Body></soapenv:Envelope>",
  soapVersion: '1.1',
  soapAction: 'http://tempuri.org/Add',
  headers: { 'X-Custom': 'value' },
};

describe('toCurl', () => {
  it('builds a POSIX curl command with heredoc body', () => {
    const cmd = soapToCurl(INPUT);
    expect(cmd).toContain("curl --request POST 'https://example.com/calc?wsdl'");
    expect(cmd).toContain("--header 'Content-Type: text/xml;charset=UTF-8'");
    expect(cmd).toContain(`--header 'SOAPAction: "http://tempuri.org/Add"'`);
    expect(cmd).toContain("--header 'X-Custom: value'");
    expect(cmd).toContain("--data-binary @- <<'EOF'");
    expect(cmd).toContain(INPUT.envelopeXml);
    expect(cmd).toContain('EOF');
  });

  it('escapes single quotes for posix shell', () => {
    const cmd = soapToCurl({ ...INPUT, endpoint: "https://example.com/it's" });
    expect(cmd).toContain("https://example.com/it'\\''s");
  });

  it('builds a PowerShell variant with here-string', () => {
    const cmd = soapToCurl(INPUT, { shell: 'powershell' });
    expect(cmd).toContain('curl.exe --request POST');
    expect(cmd).toContain('`');
    expect(cmd).toContain("@'");
    expect(cmd).toContain("'@");
  });

  it('uses SOAP 1.2 content type action param, no SOAPAction header', () => {
    const cmd = soapToCurl({ ...INPUT, soapVersion: '1.2' });
    expect(cmd).toContain('application/soap+xml;charset=UTF-8;action="http://tempuri.org/Add"');
    expect(cmd).not.toContain('SOAPAction');
  });
});

describe('fromCurl', () => {
  it('round-trips endpoint/envelope/headers/soapAction through toCurl', () => {
    const cmd = soapToCurl(INPUT);
    const { input, problems } = fromCurl(cmd);
    expect(input.endpoint).toBe(INPUT.endpoint);
    expect(input.envelopeXml).toBe(INPUT.envelopeXml);
    expect(input.soapAction).toBe(INPUT.soapAction);
    expect(input.soapVersion).toBe('1.1');
    expect(input.headers?.['X-Custom']).toBe('value');
    expect(problems).toEqual([]);
  });

  it('flags @file data as unsupported', () => {
    const { input, problems } = fromCurl(`curl -X POST 'https://example.com' -d @body.xml`);
    expect(input.envelopeXml).toBeUndefined();
    expect(problems).toContain('data-from-file-unsupported');
  });

  it('flags -u basic auth as ignored and never imports the secret', () => {
    const { input, problems } = fromCurl(`curl -u user:pass 'https://example.com' -d '<x/>'`);
    expect(problems).toContain('basic-auth-ignored');
    expect(JSON.stringify(input)).not.toContain('pass');
  });

  it('flags unknown flags', () => {
    const { problems } = fromCurl(`curl --compressed 'https://example.com' -d '<x/>'`);
    expect(problems).toContain('ignored-flag:--compressed');
  });

  it('skips the value of a flag it ignores, so the value is not read as the endpoint', () => {
    const { input, problems } = fromCurl(`curl -o out.xml 'https://example.com/soap' -d '<x/>'`);
    expect(input.endpoint).toBe('https://example.com/soap');
    expect(problems).toContain('ignored-flag:-o');
  });

  it('keeps the endpoint after value-less flags, bundled or not', () => {
    for (const command of [
      `curl --ntlm 'https://example.com/soap' -d '<x/>'`,
      `curl -sSL 'https://example.com/soap' -d '<x/>'`,
    ]) {
      expect(fromCurl(command).input.endpoint).toBe('https://example.com/soap');
    }
  });

  it('detects SOAP 1.2 from Content-Type', () => {
    const { input } = fromCurl(
      `curl 'https://example.com' -H 'Content-Type: application/soap+xml;charset=UTF-8;action="Foo"' -d '<x/>'`,
    );
    expect(input.soapVersion).toBe('1.2');
  });

  it('parses --url and double-quoted data', () => {
    const { input } = fromCurl(`curl --url "https://example.com" -d "<x><y>1</y></x>"`);
    expect(input.endpoint).toBe('https://example.com');
    expect(input.envelopeXml).toBe('<x><y>1</y></x>');
  });
});

describe('heredoc scan (SOAP parser)', () => {
  it('is linear with many openers and no closing line', () => {
    const time = (n: number): number => {
      const input = "curl https://s.test/soap --data-binary @- <<'EOF'\n" + '<<a\n'.repeat(n);
      const started = performance.now();
      fromCurl(input);
      return performance.now() - started;
    };
    time(10_000);
    expect(time(100_000)).toBeLessThan(400);
  });

  it('reads a CRLF heredoc body verbatim', () => {
    const crlf = ["curl https://s.test/soap --data-binary @- <<'EOF'", '<a>', '  <b/>', '</a>', 'EOF'].join('\r\n');
    expect(fromCurl(crlf).input.envelopeXml).toBe('<a>\r\n  <b/>\r\n</a>');
  });
});
