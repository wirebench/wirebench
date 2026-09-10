import { describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { isSoapFault, parseFault } from '../../../src/soap/fault.js';

const FAULT_11 = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
   <soapenv:Body>
      <soapenv:Fault>
         <faultcode>soapenv:Server</faultcode>
         <faultstring>Division by zero</faultstring>
         <faultactor>http://example.invalid/calc</faultactor>
         <detail>
            <e:CalcError xmlns:e="urn:wb:err"><e:code>DIV0</e:code></e:CalcError>
            <e:Hint xmlns:e="urn:wb:err">try a non-zero divisor</e:Hint>
         </detail>
      </soapenv:Fault>
   </soapenv:Body>
</soapenv:Envelope>`;

const FAULT_12 = `<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:e="urn:wb:err">
   <env:Body>
      <env:Fault>
         <env:Code>
            <env:Value>env:Receiver</env:Value>
            <env:Subcode>
               <env:Value>e:ProcessingError</env:Value>
               <env:Subcode>
                  <env:Value>e:DivideByZero</env:Value>
               </env:Subcode>
            </env:Subcode>
         </env:Code>
         <env:Reason>
            <env:Text xml:lang="en">Division by zero</env:Text>
            <env:Text xml:lang="nl">Deling door nul</env:Text>
         </env:Reason>
         <env:Node>http://example.invalid/calc</env:Node>
         <env:Role>http://www.w3.org/2003/05/soap-envelope/role/ultimateReceiver</env:Role>
         <env:Detail>
            <e:CalcError><e:code>DIV0</e:code></e:CalcError>
         </env:Detail>
      </env:Fault>
   </env:Body>
</env:Envelope>`;

describe('parseFault (SOAP 1.1)', () => {
  const fault = parseFault(parseXml(FAULT_11));

  it('reads code, reason, actor and detail', () => {
    expect(fault?.version).toBe('1.1');
    expect(fault?.code).toBe('soapenv:Server');
    expect(fault?.reason).toBe('Division by zero');
    expect(fault?.actor).toBe('http://example.invalid/calc');
    expect(fault?.subcodes).toEqual([]);
    expect(fault?.reasons).toBeUndefined();
    expect(fault?.role).toBeUndefined();
    expect(fault?.node).toBeUndefined();
    expect(fault?.element.localName).toBe('Fault');
  });

  it('serializes every child of detail', () => {
    expect(fault?.detailXml).toContain('<e:CalcError');
    expect(fault?.detailXml).toContain('<e:Hint');
    expect(fault?.detailXml?.split('\n')).toHaveLength(2);
  });

  it('omits detailXml when detail is absent or has no element children', () => {
    const noDetail = parseFault(
      parseXml(
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>` +
          `<faultcode>s:Client</faultcode><faultstring>bad</faultstring><detail>  </detail>` +
          `</s:Fault></s:Body></s:Envelope>`,
      ),
    );
    expect(noDetail?.detailXml).toBeUndefined();
    expect(noDetail?.actor).toBeUndefined();
  });
});

describe('parseFault (SOAP 1.2)', () => {
  const fault = parseFault(parseXml(FAULT_12));

  it('reads the code value and the nested subcode chain, outermost first', () => {
    expect(fault?.version).toBe('1.2');
    expect(fault?.code).toBe('env:Receiver');
    expect(fault?.subcodes).toEqual(['e:ProcessingError', 'e:DivideByZero']);
  });

  it('reads every localised reason and uses the first as the summary', () => {
    expect(fault?.reason).toBe('Division by zero');
    expect(fault?.reasons).toEqual([
      { lang: 'en', text: 'Division by zero' },
      { lang: 'nl', text: 'Deling door nul' },
    ]);
  });

  it('reads Node, Role and Detail', () => {
    expect(fault?.node).toBe('http://example.invalid/calc');
    expect(fault?.role).toBe('http://www.w3.org/2003/05/soap-envelope/role/ultimateReceiver');
    // Serialization re-declares the inherited prefix, so detailXml stands alone.
    expect(fault?.detailXml).toBe('<e:CalcError xmlns:e="urn:wb:err"><e:code>DIV0</e:code></e:CalcError>');
  });

  it('tolerates a fault with no Code and no Reason', () => {
    const bare = parseFault(
      parseXml(
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault/></e:Body></e:Envelope>',
      ),
    );
    expect(bare?.code).toBe('');
    expect(bare?.reason).toBe('');
    expect(bare?.subcodes).toEqual([]);
    expect(bare?.reasons).toEqual([]);
  });

  it('keeps a reason without xml:lang', () => {
    const noLang = parseFault(
      parseXml(
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault>' +
          '<e:Reason><e:Text>boom</e:Text></e:Reason></e:Fault></e:Body></e:Envelope>',
      ),
    );
    expect(noLang?.reasons).toEqual([{ text: 'boom' }]);
    expect(noLang?.reason).toBe('boom');
  });
});

describe('parseFault (non-faults)', () => {
  const NOT_A_FAULT =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<AddResponse xmlns="http://tempuri.org/"><AddResult>3</AddResult></AddResponse></s:Body></s:Envelope>';

  it('returns undefined for a body with no Fault', () => {
    expect(parseFault(parseXml(NOT_A_FAULT))).toBeUndefined();
    expect(isSoapFault(parseXml(NOT_A_FAULT))).toBe(false);
  });

  it('returns undefined for a non-envelope, an unknown namespace, and an envelope with no Body', () => {
    expect(parseFault(parseXml('<html/>'))).toBeUndefined();
    expect(parseFault(parseXml('<Envelope xmlns="urn:nope"><Body/></Envelope>'))).toBeUndefined();
    expect(
      parseFault(parseXml('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header/></s:Envelope>')),
    ).toBeUndefined();
  });

  it('is true for a fault document', () => {
    expect(isSoapFault(parseXml(FAULT_11))).toBe(true);
    expect(isSoapFault(parseXml(FAULT_12))).toBe(true);
  });
});
