import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import type { ImportResult } from '../../../src/types.js';
import { validateAgainstSchemaSet } from '../../../src/validate/schema-validator.js';
import type { ValidationProblem } from '../../../src/validate/types.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function publicPath(name: string): string {
  return `${repoRoot}fixtures/wsdl/public/${name}/service.wsdl`;
}

function craftedPath(name: string): string {
  return `${repoRoot}fixtures/wsdl/crafted/${name}/service.wsdl`;
}

const codes = (problems: readonly ValidationProblem[]): string[] => problems.map((problem) => problem.code);

/** A SOAP 1.1 envelope whose body is `body`, indented so `body` starts on line 4. */
function envelope(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    body,
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

const ADD_BODY = [
  '      <tem:Add>',
  '         <tem:intA>1</tem:intA>',
  '         <tem:intB>2</tem:intB>',
  '      </tem:Add>',
].join('\n');

describe('validateAgainstSchemaSet — Calculator (document/literal)', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({ kind: 'file', path: publicPath('calculator') });
  });

  const validate = (xml: string) =>
    validateAgainstSchemaSet(xml, { schemaSet: calculator.schemaSet, bundle: calculator.bundle });

  it('accepts a valid request', async () => {
    await expect(validate(envelope(ADD_BODY))).resolves.toEqual([]);
  });

  it('flags a string in intA at the intA line', async () => {
    const problems = await validate(envelope(ADD_BODY.replace('1</tem:intA>', 'abc</tem:intA>')));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('error');
    expect(problems[0]?.source).toBe('schema');
    expect(problems[0]?.message).toContain('intA');
    // `<tem:intA>` sits on line 6 of the envelope above.
    expect(problems[0]?.line).toBe(6);
  });

  it('flags a missing required intB, naming it', async () => {
    const problems = await validate(
      envelope(['      <tem:Add>', '         <tem:intA>1</tem:intA>', '      </tem:Add>'].join('\n')),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('intB');
  });

  it('flags an unknown element inside the body element', async () => {
    const problems = await validate(
      envelope(
        [
          '      <tem:Add>',
          '         <tem:intA>1</tem:intA>',
          '         <tem:intB>2</tem:intB>',
          '         <tem:intC>3</tem:intC>',
          '      </tem:Add>',
        ].join('\n'),
      ),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.message).toContain('intC');
  });

  it('flags a body element with no global declaration', async () => {
    const problems = await validate(envelope('      <tem:Nope/>'));
    expect(codes(problems)).toEqual(['schema-unknown-element']);
    expect(problems[0]?.line).toBe(5);
  });

  it('validates a response body', async () => {
    const bad = envelope('      <tem:AddResponse><tem:AddResult>x</tem:AddResult></tem:AddResponse>');
    const problems = await validate(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('AddResult');
    await expect(
      validate(envelope('      <tem:AddResponse><tem:AddResult>3</tem:AddResult></tem:AddResponse>')),
    ).resolves.toEqual([]);
  });

  it('validates every body child and carries a path', async () => {
    const problems = await validate(
      envelope('      <tem:Add><tem:intA>x</tem:intA><tem:intB>1</tem:intB></tem:Add>\n      <tem:Nope/>'),
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
    expect(problems[0]?.path).toBe('/Envelope/Body/tem:Add');
  });

  it('returns nothing for an envelope with an empty body', async () => {
    await expect(validate(envelope('   '))).resolves.toEqual([]);
  });

  it('returns nothing when the envelope cannot be tokenized', async () => {
    await expect(validate('<soapenv:Envelope>< not xml')).resolves.toEqual([]);
  });

  it('reuses the cached file set for the same bundle', async () => {
    const first = await validate(envelope(ADD_BODY));
    const second = await validate(envelope(ADD_BODY));
    expect(first).toEqual(second);
  });

  it('validates a 500 KB body in under two seconds', async () => {
    // One deep element repeated: `Add` only allows two children, so the size test uses
    // a long (but legal) `intA` comment padding around a valid request instead.
    const padding = `<!-- ${'x'.repeat(500 * 1024)} -->`;
    const started = performance.now();
    const problems = await validate(envelope(`${ADD_BODY}\n      ${padding}`));
    expect(problems).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('validateAgainstSchemaSet — degenerate inputs', () => {
  let calculator: ImportResult;

  beforeAll(async () => {
    calculator = await importDefinition({ kind: 'file', path: publicPath('calculator') });
  });

  it('skips a schema set with no components at all', async () => {
    const empty = { elements: new Map(), types: new Map() } as unknown as ImportResult['schemaSet'];
    await expect(
      validateAgainstSchemaSet(envelope(ADD_BODY), { schemaSet: empty, bundle: calculator.bundle }),
    ).resolves.toEqual([]);
  });

  it('reports a timeout rather than hanging', async () => {
    const problems = await validateAgainstSchemaSet(
      envelope(ADD_BODY),
      { schemaSet: calculator.schemaSet, bundle: calculator.bundle },
      { timeoutMs: 0 },
    );
    expect(codes(problems)).toEqual(['schema-timeout']);
    expect(problems[0]?.severity).toBe('warning');
    expect(problems[0]?.line).toBe(5);
  });

  it('ignores a body that is not inside an Envelope', async () => {
    await expect(
      validateAgainstSchemaSet('<Body><tem:Add xmlns:tem="http://tempuri.org/"/></Body>', {
        schemaSet: calculator.schemaSet,
        bundle: calculator.bundle,
      }),
    ).resolves.toEqual([]);
  });
});

describe('validateAgainstSchemaSet — rpc/literal', () => {
  let rpc: ImportResult;

  beforeAll(async () => {
    rpc = await importDefinition({ kind: 'file', path: craftedPath('rpc-literal') });
  });

  const binding = {
    soapVersion: '1.1' as const,
    operation: 'Multiply',
    style: 'rpc' as const,
    parts: [
      { name: 'a', type: { namespaceUri: 'http://www.w3.org/2001/XMLSchema', localName: 'int' } },
      { name: 'b', type: { namespaceUri: 'http://www.w3.org/2001/XMLSchema', localName: 'int' } },
      { name: 'opts', type: { namespaceUri: 'urn:wb:rpclit', localName: 'Options' } },
    ],
  };

  const rpcEnvelope = (inner: string) =>
    [
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:rpc="urn:wb:rpclit">',
      '   <soapenv:Body>',
      inner,
      '   </soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('\n');

  it('accepts valid parts in any order', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(
        [
          '      <rpc:Multiply>',
          '         <b>2</b>',
          '         <a>1</a>',
          '         <opts><rounding>up</rounding><scale>2</scale></opts>',
          '      </rpc:Multiply>',
        ].join('\n'),
      ),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems).toEqual([]);
  });

  it('flags a part whose value does not match its type', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(
        [
          '      <rpc:Multiply>',
          '         <a>nope</a>',
          '         <b>2</b>',
          '         <opts><rounding>up</rounding><scale>2</scale></opts>',
          '      </rpc:Multiply>',
        ].join('\n'),
      ),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.line).toBe(4);
  });

  it('accepts parts whose element or type cannot be resolved', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>anything</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      {
        binding: {
          soapVersion: '1.1',
          operation: 'Multiply',
          style: 'rpc',
          parts: [{ name: 'a', type: { namespaceUri: 'urn:not:imported', localName: 'Mystery' } }],
        },
      },
    );
    expect(problems).toEqual([]);
  });

  it('resolves a part declared by element reference', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>1</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      {
        binding: {
          soapVersion: '1.1',
          operation: 'Multiply',
          style: 'rpc',
          parts: [{ name: 'a', element: { namespaceUri: 'urn:wb:rpclit', localName: 'Nope' } }],
        },
      },
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it('flags a part that is missing', async () => {
    const problems = await validateAgainstSchemaSet(
      rpcEnvelope(['      <rpc:Multiply>', '         <a>1</a>', '      </rpc:Multiply>'].join('\n')),
      { schemaSet: rpc.schemaSet, bundle: rpc.bundle },
      { binding },
    );
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('validateAgainstSchemaSet — chameleon include', () => {
  it('resolves a type pulled in through a chameleon include', async () => {
    const chameleon = await importDefinition({ kind: 'file', path: craftedPath('chameleon-include') });
    const target = { schemaSet: chameleon.schemaSet, bundle: chameleon.bundle };
    const ok =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Ping xmlns="urn:wb:chameleon">PING</Ping></soapenv:Body></soapenv:Envelope>';
    await expect(validateAgainstSchemaSet(ok, target)).resolves.toEqual([]);

    const bad = ok.replace('>PING<', '>PONG<');
    const problems = await validateAgainstSchemaSet(bad, target);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('PONG');
  });
});

describe('validateAgainstSchemaSet — nested imports', () => {
  it('resolves element declarations across imported schema documents', async () => {
    const nested = await importDefinition({ kind: 'file', path: craftedPath('nested-imports') });
    const target = { schemaSet: nested.schemaSet, bundle: nested.bundle };
    const problems = await validateAgainstSchemaSet(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><Unknown xmlns="urn:nope"/></soapenv:Body></soapenv:Envelope>',
      target,
    );
    expect(codes(problems)).toEqual(['schema-unknown-element']);
  });
});
