/**
 * Interop against the live public SOAP services Wirebench's fixtures were captured from.
 *
 * Every other test in the repo is hermetic; this project is the one place that talks to the
 * internet, and it only runs when `WIREBENCH_NETWORK_TESTS=1` is set (`pnpm test:interop`,
 * and `.github/workflows/nightly.yml` on a schedule). The point is the part a local fixture
 * can never prove: that a real WSDL, fetched over the wire today, still imports, still
 * generates a request the *service* accepts, and still answers it the way the contract says.
 *
 * Every operation used here is read-only — a calculator, two converters, a country lookup.
 * Nothing in this file creates, changes or deletes state on somebody else's server, and that
 * is a hard rule for anything added to it: these are other people's machines, run as a
 * courtesy.
 *
 * A fifth service, `soapdemo` (https://www.crcind.com/csp/samples/SOAP.Demo.cls?WSDL=1), is
 * deliberately absent: it was unreachable when the fixtures were captured (2026-09-10) and
 * again when this suite was written (2026-09-11, connection failure). If it comes back, it is
 * a read-only demo too and belongs in the table below.
 */
import { expect, it } from 'vitest';
import { generateRequest } from '../../src/generate.js';
import { importDefinition } from '../../src/import.js';
import { sendSoapRequest } from '../../src/send.js';
import { describeNetwork } from '../helpers/network-gate.js';
import type { GenerateOptions } from '../../src/xsd/sample-generator.js';

/** Generous: these are public servers on a shared internet, not a loopback socket. */
const TIMEOUT_MS = 60_000;

interface InteropService {
  /** Fixture directory name under `fixtures/wsdl/public/`, and the test's name. */
  readonly name: string;
  /** The live WSDL URL, the same one `scripts/fixtures-refresh.ts` captured from. */
  readonly wsdlUrl: string;
  /** A read-only operation on that service. */
  readonly operationName: string;
  /** SOAP version to exercise; each service offers both a 1.1 and a 1.2 binding. */
  readonly soapVersion: '1.1' | '1.2';
  /** Endpoint to POST to, when the address in the WSDL is not the one that answers. */
  readonly endpoint?: string;
  /** Generator options, when the defaults leave out an element the call needs. */
  readonly generateOptions?: Partial<GenerateOptions>;
  /** Leaf element name → the value to send, substituted into the generated envelope. */
  readonly values: Readonly<Record<string, string>>;
  /** Must appear in the response envelope; the service's actual answer, not just a 200. */
  readonly expect: RegExp;
}

const SERVICES: readonly InteropService[] = [
  {
    name: 'calculator',
    wsdlUrl: 'http://www.dneonline.com/calculator.asmx?WSDL',
    operationName: 'Add',
    soapVersion: '1.1',
    values: { intA: '2', intB: '3' },
    expect: /<AddResult>5<\/AddResult>/,
  },
  {
    name: 'numberconversion',
    wsdlUrl: 'https://www.dataaccess.com/webservicesserver/NumberConversion.wso?WSDL',
    operationName: 'NumberToWords',
    soapVersion: '1.1',
    values: { ubiNum: '13' },
    expect: /thirteen/i,
  },
  {
    name: 'tempconvert',
    wsdlUrl: 'https://www.w3schools.com/xml/tempconvert.asmx?WSDL',
    operationName: 'CelsiusToFahrenheit',
    soapVersion: '1.1',
    // The WSDL still advertises `http://www.w3schools.com/...`, but w3schools answers that
    // with a 301 to https. Wirebench does not follow redirects on a send by default (fetch
    // semantics downgrade a redirected POST to GET, which would silently turn a SOAP call
    // into a page fetch), so the test posts to the endpoint the redirect names. That gap
    // between the advertised address and the working one is itself a real-world fact worth
    // keeping visible here.
    endpoint: 'https://www.w3schools.com/xml/tempconvert.asmx',
    // `Celsius` is a `minOccurs="0"` element, so the default (required-only) generation
    // produces an empty `<CelsiusToFahrenheit/>` — correct, but not a call worth making.
    generateOptions: { includeOptional: true },
    values: { Celsius: '100' },
    expect: /212/,
  },
  {
    name: 'countryinfo',
    wsdlUrl: 'http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso?WSDL',
    operationName: 'CountryName',
    soapVersion: '1.1',
    values: { sCountryISOCode: 'BE' },
    expect: /Belgium/i,
  },
];

/**
 * Replaces the text of the named leaf elements in a generated envelope, whatever prefix the
 * generator chose and whether the element came out empty (`<x/>`) or as a `?` placeholder.
 *
 * Throws when an element is not found: that means the live contract moved under us, which is
 * exactly the news this suite exists to deliver — far better than silently sending `?`.
 */
function withValues(envelopeXml: string, values: Readonly<Record<string, string>>): string {
  let xml = envelopeXml;
  for (const [name, value] of Object.entries(values)) {
    const element = new RegExp(
      `<((?:[\\w.-]+:)?)${name}((?:\\s[^>]*?)?)\\s*(?:/>|>[\\s\\S]*?</(?:[\\w.-]+:)?${name}>)`,
      'u',
    );
    if (!element.test(xml)) {
      throw new Error(`generated envelope has no <${name}> element to fill:\n${envelopeXml}`);
    }
    xml = xml.replace(element, `<$1${name}$2>${value}</$1${name}>`);
  }
  return xml;
}

describeNetwork.each(SERVICES)('interop: $name', (service) => {
  it(
    `imports, generates and sends ${service.operationName}`,
    async () => {
      const imported = await importDefinition({ kind: 'url', url: service.wsdlUrl });
      expect(imported.problems).toEqual([]);

      const operation = imported.operations.find(
        (candidate) =>
          candidate.operationName === service.operationName && candidate.soapVersion === service.soapVersion,
      );
      expect(operation, `${service.operationName} (SOAP ${service.soapVersion}) is missing`).toBeDefined();

      const advertised = operation?.ports[0]?.address;
      expect(advertised, 'the service port has no address').toBeDefined();
      const endpoint = service.endpoint ?? advertised;

      const generated = generateRequest(
        imported,
        { bindingName: operation!.bindingName, operationName: service.operationName },
        service.generateOptions,
      );
      expect(generated.problems).toEqual([]);

      const exchange = await sendSoapRequest({
        endpoint: endpoint!,
        envelopeXml: withValues(generated.envelopeXml, service.values),
        soapVersion: service.soapVersion,
        soapAction: generated.soapAction ?? '',
      });

      expect(exchange.http.status).toBe(200);
      expect(exchange.response?.isSoap).toBe(true);
      expect(exchange.response?.fault).toBeUndefined();
      expect(exchange.response?.envelopeXml ?? '').toMatch(service.expect);
    },
    TIMEOUT_MS,
  );
});
