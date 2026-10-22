import { describe, expect, it } from 'vitest';
import { generatedRequestName, type NamedOperation } from '#protocol-soap/soap/request-name';

const op = (name: string, binding: string, soapVersion: NamedOperation['soapVersion']): NamedOperation => ({
  name,
  binding: `{urn:t}${binding}`,
  bindingLocal: binding,
  soapVersion,
});

describe('generatedRequestName (#726)', () => {
  it('uses the operation name when one binding offers it', () => {
    const add = op('Add', 'CalcSoap', '1.1');
    expect(generatedRequestName(add, [add, op('Subtract', 'CalcSoap', '1.1')])).toBe('Add');
  });

  it('adds the SOAP version when two bindings differ by version', () => {
    const a = op('Add', 'CalcSoap', '1.1');
    const b = op('Add', 'CalcSoap12', '1.2');
    expect(generatedRequestName(a, [a, b])).toBe('Add (SOAP 1.1)');
    expect(generatedRequestName(b, [a, b])).toBe('Add (SOAP 1.2)');
  });

  it('adds the binding name when two bindings share a version', () => {
    const a = op('Add', 'CalcA', '1.1');
    const b = op('Add', 'CalcB', '1.1');
    expect(generatedRequestName(a, [a, b])).toBe('Add (CalcA)');
    expect(generatedRequestName(b, [a, b])).toBe('Add (CalcB)');
  });
});
