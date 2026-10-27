import { describe, expect, it } from 'vitest';
import { findExistingInterface } from '../../src/renderer/features/explorer/existing-interface.js';
import type { InterfaceWire } from '@wirebench/wire/kinds/soap/wire';

function iface(id: string, definitionUrl: string): InterfaceWire {
  return { id, name: id, definitionUrl } as InterfaceWire;
}

const interfaces = {
  a: iface('a', 'http://example.test/service?wsdl'),
  b: iface('b', 'file:///Users/me/My%20Service/calc.wsdl'),
  c: iface('c', 'file:///C:/wsdl/calc.wsdl'),
};
const projectOf = { a: 'p1', b: 'p1', c: 'p1' };

describe('findExistingInterface (#727)', () => {
  it('matches the same URL in the same project only', () => {
    const source = { kind: 'url', url: 'http://example.test/service?wsdl' } as const;
    expect(findExistingInterface(interfaces, projectOf, 'p1', source)?.id).toBe('a');
    expect(findExistingInterface(interfaces, projectOf, 'p2', source)).toBeUndefined();
    expect(
      findExistingInterface(interfaces, projectOf, 'p1', { kind: 'url', url: 'http://example.test/other?wsdl' }),
    ).toBeUndefined();
  });

  it('matches a file path against a file: URL, POSIX and Windows alike', () => {
    expect(
      findExistingInterface(interfaces, projectOf, 'p1', { kind: 'file', path: '/Users/me/My Service/calc.wsdl' })?.id,
    ).toBe('b');
    expect(findExistingInterface(interfaces, projectOf, 'p1', { kind: 'file', path: 'C:\\wsdl\\calc.wsdl' })?.id).toBe(
      'c',
    );
  });

  it('never matches pasted text', () => {
    expect(findExistingInterface(interfaces, projectOf, 'p1', { kind: 'text', text: '<x/>' })).toBeUndefined();
  });
});
