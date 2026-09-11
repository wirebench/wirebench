import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { findPortType } from '../../../src/wsdl/model.js';
import type { Binding, WsdlDefinition } from '../../../src/wsdl/model.js';
import { defaultAction, detectWsaDefaults, summarizeWsa } from '../../../src/wsa/policy-detect.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const location = `${repoRoot}fixtures/wsdl/crafted/ws-addressing/service.wsdl`;

let definition: WsdlDefinition;

function bindingNamed(name: string): Binding {
  const binding = definition.bindings.find((candidate) => candidate.name.localName === name);
  if (binding === undefined) {
    throw new Error(`no binding ${name}`);
  }
  return binding;
}

function operationNamed(binding: Binding, name: string) {
  const operation = binding.operations.find((candidate) => candidate.name === name);
  if (operation === undefined) {
    throw new Error(`no operation ${name}`);
  }
  return operation;
}

beforeAll(async () => {
  definition = await parseWsdl(
    { location, text: readFileSync(location, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: false },
  );
});

describe('detectWsaDefaults', () => {
  it('detects wsaw:UsingAddressing on the binding', () => {
    const binding = bindingNamed('WsaBinding');
    expect(detectWsaDefaults(definition, binding, operationNamed(binding, 'Ping'))).toEqual({
      usingAddressing: true,
      version: '2005/08',
    });
  });

  it('detects a wsp:PolicyReference to a wsam:Addressing policy', () => {
    const binding = bindingNamed('WsaPolicyBinding');
    expect(detectWsaDefaults(definition, binding, operationNamed(binding, 'Ping')).usingAddressing).toBe(true);
  });

  it('reports wsam:Action as the operation’s declared action', () => {
    const binding = bindingNamed('WsaBinding');
    expect(detectWsaDefaults(definition, binding, operationNamed(binding, 'Echo')).action).toBe(
      'urn:wb:wsa:EchoAction',
    );
  });

  it('stays off for a binding that declares nothing', () => {
    const binding = bindingNamed('PlainBinding');
    expect(detectWsaDefaults(definition, binding, operationNamed(binding, 'Ping')).usingAddressing).toBe(false);
  });

  it('an operation with wsam:Action alone still counts as using addressing', () => {
    const binding = bindingNamed('PlainBinding');
    const echo = { ...operationNamed(binding, 'Ping'), name: 'Echo' };
    expect(detectWsaDefaults(definition, binding, echo)).toEqual({
      usingAddressing: true,
      version: '2005/08',
      action: 'urn:wb:wsa:EchoAction',
    });
  });

  it('reads the 2004 flavour as 2004/08', async () => {
    const text = readFileSync(location, 'utf-8')
      .replace(
        'xmlns:wsaw="http://www.w3.org/2006/05/addressing/wsdl"',
        'xmlns:wsaw="http://schemas.xmlsoap.org/ws/2004/08/addressing/policy"',
      )
      .replace(/ wsam:Action="[^"]*"/g, '');
    const legacy = await parseWsdl(
      { location, text },
      { fetchDocument: createDefaultFetchDocument(), resolveImports: false },
    );
    const binding = legacy.bindings.find((b) => b.name.localName === 'WsaBinding');
    expect(binding).toBeDefined();
    expect(detectWsaDefaults(legacy, binding as Binding, (binding as Binding).operations[0] as never)).toEqual({
      usingAddressing: true,
      version: '2004/08',
    });
  });
});

describe('defaultAction', () => {
  it('prefers the declared wsam:Action', () => {
    const portType = findPortType(definition, bindingNamed('WsaBinding').type);
    const echo = portType?.operations.find((op) => op.name === 'Echo');
    expect(defaultAction(definition, portType as never, echo as never, { soapAction: 'urn:soap' })).toBe(
      'urn:wb:wsa:EchoAction',
    );
  });

  it('falls back to a non-empty soapAction', () => {
    const portType = findPortType(definition, bindingNamed('WsaBinding').type);
    const ping = portType?.operations.find((op) => op.name === 'Ping');
    expect(defaultAction(definition, portType as never, ping as never, { soapAction: 'urn:wb:wsa:Ping' })).toBe(
      'urn:wb:wsa:Ping',
    );
  });

  it('falls back to <tns>/<portType>/<operation>Request, joining with a single slash', () => {
    const portType = findPortType(definition, bindingNamed('WsaBinding').type);
    const ping = portType?.operations.find((op) => op.name === 'Ping');
    expect(defaultAction(definition, portType as never, ping as never, { soapAction: '' })).toBe(
      'urn:wb:wsa/WsaPortType/PingRequest',
    );
    expect(defaultAction(definition, portType as never, ping as never)).toBe('urn:wb:wsa/WsaPortType/PingRequest');
    const trailing = { ...portType, name: { namespaceUri: 'http://example.invalid/', localName: 'P' } };
    expect(defaultAction(definition, trailing as never, ping as never)).toBe('http://example.invalid/P/PingRequest');
  });
});

describe('summarizeWsa', () => {
  it('enables addressing and maps every operation to its default action', () => {
    const summary = summarizeWsa(definition);
    expect(summary.enabled).toBe(true);
    expect(summary.version).toBe('2005/08');
    expect(summary.defaultActionByOperation['Echo']).toBe('urn:wb:wsa:EchoAction');
    expect(summary.defaultActionByOperation['Ping']).toBe('urn:wb:wsa:Ping');
  });
});
