/**
 * SOAP mock services over real HTTP (spec §Validation → SOAP): routing by SOAPAction and by Body,
 * every validation mode, the fault in each SOAP version, and generation from the binding.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createMock, createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockDef, MockValidation } from '../../../src/mock/model.js';
import { startMock } from '../../../src/mock/server.js';
import type { MockExchangeEvent, RunningMock } from '../../../src/mock/server.js';
import { nodeFs } from '../../../src/project/fs.js';
import { soapMocking } from '../../../src/soap/mock.js';
import { mockProject, wsdlFixture } from '../mock/fixture.js';
import { soapInterfacesOf } from '../../../src/soap/model.js';

const CALCULATOR = wsdlFixture('public/calculator/service.wsdl');
const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

function envelope(version: '1.1' | '1.2', body: string): string {
  return `<s:Envelope xmlns:s="${version === '1.1' ? SOAP11 : SOAP12}" xmlns:t="http://tempuri.org/"><s:Body>${body}</s:Body></s:Envelope>`;
}

const add = (a: string, b = '2') => `<t:Add><t:intA>${a}</t:intA><t:intB>${b}</t:intB></t:Add>`;

function calculatorMock(binding: string, validation: MockValidation = 'reject'): MockDef {
  return createMock(
    'Calc',
    { containerId: 'I1', binding: `{http://tempuri.org/}${binding}` },
    {
      id: 'M1',
      path: '/calc',
      validation,
      operations: [
        createMockOperation('Add', 'Add', {
          id: 'O1',
          dispatch: 'match',
          defaultResponseId: 'R1',
          responses: [
            createMockResponse('Nine', {
              id: 'R2',
              order: 0,
              body: 'xml',
              bodyText: '<nine/>',
              match: [
                {
                  from: 'body',
                  language: 'xpath',
                  expression: '//t:intA',
                  namespaces: { t: 'http://tempuri.org/' },
                  equals: '9',
                },
              ],
            }),
            createMockResponse('Sum', { id: 'R1', order: 1, body: 'xml', bodyText: '<sum/>' }),
          ],
        }),
      ],
    },
  );
}

const running: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((m) => m.stop()));
});

async function start(mock: MockDef, events: MockExchangeEvent[] = []): Promise<RunningMock> {
  const { dir, project } = await mockProject({ wsdl: CALCULATOR, mocks: [mock] });
  const started = await startMock({ project, root: dir, mockId: mock.id, onExchange: (e) => events.push(e) });
  running.push(started);
  return started;
}

async function post(
  m: RunningMock,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string; type: string | null }> {
  const res = await fetch(m.url, { method: 'POST', body, headers });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
}

const SOAP11_HEADERS = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '"http://tempuri.org/Add"' };

describe('SOAP mock services', () => {
  it('route by SOAPAction and Body, then dispatch by XPath', async () => {
    const m = await start(calculatorMock('CalculatorSoap'));
    expect((await post(m, envelope('1.1', add('1')), SOAP11_HEADERS)).text).toBe('<sum/>');
    const nine = await post(m, envelope('1.1', add('9')), { 'Content-Type': 'text/xml' });
    expect(nine.text).toBe('<nine/>');
    expect(nine.type).toBe('text/xml; charset=utf-8');
  });

  it('refuse a request that does not conform with a Client fault listing the problems', async () => {
    const events: MockExchangeEvent[] = [];
    const m = await start(calculatorMock('CalculatorSoap'), events);
    const reply = await post(m, envelope('1.1', add('abc')), SOAP11_HEADERS);
    expect(reply.status).toBe(500);
    expect(reply.text).toContain('<faultcode>soap:Client</faultcode>');
    expect(reply.text).toContain('urn:wirebench:mock');
    expect(reply.text).toContain('<wb:problem');
    expect(events[0]?.problems.length).toBeGreaterThan(0);
    expect(events[0]?.operation).toBe('Add');
  });

  it('report mode answers anyway and logs the problems; off mode checks nothing', async () => {
    const events: MockExchangeEvent[] = [];
    const report = await start(calculatorMock('CalculatorSoap', 'report'), events);
    expect((await post(report, envelope('1.1', add('abc')), SOAP11_HEADERS)).text).toBe('<sum/>');
    expect(events[0]?.problems.length).toBeGreaterThan(0);
    const off = await start({ ...calculatorMock('CalculatorSoap', 'off'), id: 'M2' });
    const unchecked = await post(off, envelope('1.1', add('abc')), { 'Content-Type': 'application/json' });
    expect(unchecked.text).toBe('<sum/>');
  });

  it('a SOAPAction that disagrees with the Body is a problem; the Body wins', async () => {
    const events: MockExchangeEvent[] = [];
    const m = await start(calculatorMock('CalculatorSoap', 'report'), events);
    const reply = await post(m, envelope('1.1', add('1')), {
      ...SOAP11_HEADERS,
      SOAPAction: '"http://tempuri.org/Subtract"',
    });
    expect(reply.text).toBe('<sum/>');
    expect(events[0]?.operation).toBe('Add');
    expect(events[0]?.problems.map((p) => p.message).join(' ')).toContain('SOAPAction');
  });

  it('refuse the wrong Content-Type with 415, a DTD, and a request no operation matches', async () => {
    const m = await start(calculatorMock('CalculatorSoap'));
    expect((await post(m, envelope('1.1', add('1')), { 'Content-Type': 'application/json' })).status).toBe(415);
    const dtd = await post(m, `<!DOCTYPE x [<!ENTITY a "aaaa">]>${envelope('1.1', add('1'))}`, SOAP11_HEADERS);
    expect(dtd.status).toBe(500);
    expect(dtd.text).toContain('document type declaration');
    const unknown = await post(m, envelope('1.1', '<t:Nope/>'), { 'Content-Type': 'text/xml' });
    expect(unknown.text).toContain('No operation of CalculatorSoap matches');
    expect((await fetch(m.url)).status).toBe(405);
  });

  it('a SOAP 1.2 binding answers with a Sender fault and reads the action from the Content-Type', async () => {
    const m = await start(calculatorMock('CalculatorSoap12'));
    const ok = await post(m, envelope('1.2', add('9')), {
      'Content-Type': 'application/soap+xml; charset=utf-8; action="http://tempuri.org/Add"',
    });
    expect(ok.text).toBe('<nine/>');
    expect(ok.type).toBe('application/soap+xml; charset=utf-8');
    const bad = await post(m, envelope('1.2', add('abc')), { 'Content-Type': 'application/soap+xml' });
    expect(bad.text).toContain('<env:Value>env:Sender</env:Value>');
  });

  it('an operation without stubs answers with a Server fault', async () => {
    const m = await start(calculatorMock('CalculatorSoap'));
    const reply = await post(m, envelope('1.1', '<t:Divide><t:intA>1</t:intA><t:intB>1</t:intB></t:Divide>'), {
      'Content-Type': 'text/xml',
    });
    expect(reply.status).toBe(500);
    expect(reply.text).toContain('soap:Server');
  });

  it('generate one response per operation of the SOAP 1.1 binding, from the output message', async () => {
    const { dir, project } = await mockProject({ wsdl: CALCULATOR });
    const generated = await soapMocking.generate({ project, root: dir, fs: nodeFs, containerId: 'I1' });
    expect(generated.binding).toBe('{http://tempuri.org/}CalculatorSoap');
    expect(generated.operations.map((o) => o.key)).toEqual(['Add', 'Subtract', 'Multiply', 'Divide']);
    expect(generated.operations[0]?.response.bodyText).toContain('AddResponse');
    const v12 = await soapMocking.generate({
      project,
      root: dir,
      fs: nodeFs,
      containerId: 'I1',
      binding: '{http://tempuri.org/}CalculatorSoap12',
    });
    expect(v12.operations[0]?.response.bodyText).toContain(SOAP12);
  });

  it('refuse a binding the WSDL does not have, and an interface whose definition is not cached', async () => {
    const { dir, project } = await mockProject({ wsdl: CALCULATOR });
    await expect(
      soapMocking.generate({ project, root: dir, fs: nodeFs, containerId: 'I1', binding: '{urn:x}Nope' }),
    ).rejects.toMatchObject({ code: 'mock-binding-unknown' });
    const uncached = {
      ...project,
      containers: {
        ...project.containers,
        soap: soapInterfacesOf(project).map((i) => ({ ...i, cacheDefinition: false })),
      },
    };
    await expect(
      soapMocking.generate({ project: uncached, root: dir, fs: nodeFs, containerId: 'I1' }),
    ).rejects.toMatchObject({
      code: 'mock-definition-missing',
    });
  });
});
