import { describe, expect, it } from 'vitest';
import { recreateRequest } from '../../../src/soap/recreate.js';

const CURRENT = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:Add>
         <tem:intA>5</tem:intA>
         <tem:intB>?</tem:intB>
      </tem:Add>
   </soapenv:Body>
</soapenv:Envelope>`;

const GENERATED = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:Add>
         <tem:intA>?</tem:intA>
         <tem:intB>?</tem:intB>
      </tem:Add>
   </soapenv:Body>
</soapenv:Envelope>`;

describe('recreateRequest', () => {
  it('keeps an edited value present in both structures', () => {
    const result = recreateRequest(CURRENT, GENERATED, { keepValues: true, keepHeaders: false });
    expect(result.xml).toContain('<tem:intA>5</tem:intA>');
    expect(result.kept).toBe(2);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });

  it('adds a new optional element present only in the generated structure', () => {
    const generatedWithExtra = GENERATED.replace(
      '<tem:intB>?</tem:intB>',
      '<tem:intB>?</tem:intB>\n         <tem:intC>?</tem:intC>',
    );
    const result = recreateRequest(CURRENT, generatedWithExtra, { keepValues: true, keepHeaders: false });
    expect(result.xml).toContain('<tem:intC>?</tem:intC>');
    expect(result.added).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.removed).toBe(0);
  });

  it('removes an element present in current but absent from generated, and counts it', () => {
    const currentWithExtra = CURRENT.replace(
      '<tem:intB>?</tem:intB>',
      '<tem:intB>?</tem:intB>\n         <tem:intC>99</tem:intC>',
    );
    const result = recreateRequest(currentWithExtra, GENERATED, { keepValues: true, keepHeaders: false });
    expect(result.xml).not.toContain('intC');
    expect(result.removed).toBe(1);
    expect(result.kept).toBe(2);
  });

  it('produces the pure generated envelope when keepValues is false', () => {
    const result = recreateRequest(CURRENT, GENERATED, { keepValues: false, keepHeaders: false });
    expect(result.xml).toContain('<tem:intA>?</tem:intA>');
    expect(result.kept).toBe(0);
  });

  it('keeps the current header block verbatim when keepHeaders is true', () => {
    const currentWithHeader = CURRENT.replace(
      '<soapenv:Header/>',
      '<soapenv:Header><wsse:Security xmlns:wsse="urn:x"><wsse:Token>abc</wsse:Token></wsse:Security></soapenv:Header>',
    );
    const result = recreateRequest(currentWithHeader, GENERATED, { keepValues: true, keepHeaders: true });
    expect(result.xml).toContain('wsse:Security');
    expect(result.xml).toContain('abc');
  });

  it('does not keep the current header when keepHeaders is false', () => {
    const currentWithHeader = CURRENT.replace(
      '<soapenv:Header/>',
      '<soapenv:Header><wsse:Security xmlns:wsse="urn:x"><wsse:Token>abc</wsse:Token></wsse:Security></soapenv:Header>',
    );
    const result = recreateRequest(currentWithHeader, GENERATED, { keepValues: true, keepHeaders: false });
    expect(result.xml).not.toContain('wsse:Security');
  });
});
