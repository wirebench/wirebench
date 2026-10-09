import { describe, expect, it } from 'vitest';
import { isHttpsUpgrade, upgradedOrigin } from '../../../src/http/https-upgrade.js';

const from = new URL('http://soap.example/svc/Calc.asmx?wsdl=no');

function to(location: string): URL {
  return new URL(location, from);
}

describe('isHttpsUpgrade', () => {
  it.each([301, 302, 307, 308])('accepts a %i to the same host, path and query over https', (status) => {
    expect(isHttpsUpgrade(status, from, to('https://soap.example/svc/Calc.asmx?wsdl=no'))).toBe(true);
  });

  it('accepts explicit default ports and a differently cased host', () => {
    const explicit = new URL('http://soap.example:80/svc');
    expect(isHttpsUpgrade(301, explicit, new URL('https://SOAP.example:443/svc'))).toBe(true);
  });

  it('ignores a fragment', () => {
    expect(isHttpsUpgrade(301, from, to('https://soap.example/svc/Calc.asmx?wsdl=no#top'))).toBe(true);
  });

  it.each([
    ['a 303', 303, 'https://soap.example/svc/Calc.asmx?wsdl=no'],
    ['a 300', 300, 'https://soap.example/svc/Calc.asmx?wsdl=no'],
    ['another host', 301, 'https://www.soap.example/svc/Calc.asmx?wsdl=no'],
    ['another path', 301, 'https://soap.example/svc/Calc.asmx/?wsdl=no'],
    ['another query', 301, 'https://soap.example/svc/Calc.asmx'],
    ['a non-default https port', 301, 'https://soap.example:8443/svc/Calc.asmx?wsdl=no'],
    ['added user info', 301, 'https://user@soap.example/svc/Calc.asmx?wsdl=no'],
    ['a plain http hop', 301, 'http://soap.example/svc/Calc.asmx?wsdl=no'],
  ])('rejects %s', (_label, status, location) => {
    expect(isHttpsUpgrade(status, from, to(location))).toBe(false);
  });

  it('rejects a hop from a non-default http port', () => {
    expect(isHttpsUpgrade(301, new URL('http://soap.example:8080/svc'), new URL('https://soap.example/svc'))).toBe(
      false,
    );
  });

  it('rejects a hop that is already https', () => {
    expect(isHttpsUpgrade(301, new URL('https://soap.example/svc'), new URL('https://soap.example/svc'))).toBe(false);
  });
});

describe('upgradedOrigin', () => {
  it('is the https origin of a default-port http URL', () => {
    expect(upgradedOrigin(new URL('http://Soap.Example:80/svc'))).toBe('https://soap.example');
  });

  it('is undefined for any other URL', () => {
    expect(upgradedOrigin(new URL('http://soap.example:8080/svc'))).toBeUndefined();
    expect(upgradedOrigin(new URL('https://soap.example/svc'))).toBeUndefined();
  });
});
