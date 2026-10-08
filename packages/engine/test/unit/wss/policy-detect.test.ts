import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { createDefaultFetchDocument } from '../../../src/http/fetch-document.js';
import type { Binding, WsdlDefinition } from '../../../src/wsdl/model.js';
import { detectWssPolicy, summarizeWssPolicy } from '../../../src/wss/policy/detect.js';
import type { WssPolicy } from '../../../src/wss/policy/model.js';
import { NS } from '../../../src/xml/namespaces.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const location = `${repoRoot}fixtures/wsdl/crafted/ws-security-policy/service.wsdl`;

let definition: WsdlDefinition;

beforeAll(async () => {
  definition = await parseWsdl(
    { location, text: readFileSync(location, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: false },
  );
});

function bindingNamed(name: string): Binding {
  const binding = definition.bindings.find((candidate) => candidate.name.localName === name);
  if (binding === undefined) {
    throw new Error(`no binding ${name}`);
  }
  return binding;
}

function policyOf(bindingName: string, operationName: string): WssPolicy | undefined {
  const binding = bindingNamed(bindingName);
  const operation = binding.operations.find((candidate) => candidate.name === operationName);
  if (operation === undefined) {
    throw new Error(`no operation ${operationName}`);
  }
  return detectWssPolicy(definition, binding, operation);
}

describe('detectWssPolicy', () => {
  it('reads a transport binding with a hashed username token', () => {
    expect(policyOf('TransportUtBinding', 'Echo')).toEqual({
      version: '1.2',
      soapVersion: '1.1',
      binding: 'transport',
      requiresTls: true,
      includeTimestamp: true,
      encryptBeforeSigning: false,
      algorithmSuite: 'Basic128',
      tokens: [{ kind: 'username', role: 'signed-supporting', password: 'digest' }],
      signedParts: [],
      encryptedParts: [],
      unsupported: [],
      notes: [],
    });
  });

  it('reads an asymmetric binding attached by reference, in the binding’s SOAP 1.2 namespace', () => {
    expect(policyOf('AsymmetricBinding', 'Echo')).toEqual({
      version: '1.2',
      soapVersion: '1.2',
      binding: 'asymmetric',
      requiresTls: false,
      includeTimestamp: true,
      encryptBeforeSigning: false,
      algorithmSuite: 'Basic256Sha256',
      tokens: [
        { kind: 'x509', role: 'initiator', reference: 'Thumbprint' },
        { kind: 'x509', role: 'recipient', reference: 'IssuerSerial' },
      ],
      signedParts: [
        { name: 'Body', namespace: NS.SOAP12_ENV },
        { name: 'To', namespace: NS.WSA_200508 },
      ],
      encryptedParts: [{ name: 'Body', namespace: NS.SOAP12_ENV }],
      unsupported: [],
      notes: [],
    });
  });

  it('merges a message policy on the operation’s input into the endpoint policy', () => {
    const policy = policyOf('AsymmetricBinding', 'Secure');
    expect(policy?.encryptBeforeSigning).toBe(true);
    expect(policy?.binding).toBe('asymmetric');
    expect(policy?.tokens).toHaveLength(2);
  });

  it('takes the first alternative of WS-SP 1.1 under WS-Policy 2004 and notes the rest', () => {
    expect(policyOf('AlternativesBinding', 'Echo')).toEqual({
      version: '1.1',
      soapVersion: '1.1',
      binding: 'none',
      requiresTls: false,
      includeTimestamp: false,
      encryptBeforeSigning: false,
      tokens: [
        { kind: 'username', role: 'supporting', password: 'text' },
        { kind: 'issued', role: 'supporting', issuer: 'https://sts.example.invalid/trust' },
      ],
      signedParts: [],
      encryptedParts: [],
      unsupported: [],
      notes: ['The policy offers 2 alternatives; the first one is used.'],
    });
  });

  it('reports what a configuration cannot express', () => {
    const policy = policyOf('SymmetricBinding', 'Echo');
    expect(policy?.binding).toBe('symmetric');
    expect(policy?.algorithmSuite).toBe('TripleDesRsa15');
    expect(policy?.unsupported).toEqual([
      'The symmetric binding (a shared, derived key) is not offered; only asymmetric signing and encryption are.',
      'sp:SignedElements names its parts by XPath, which a configuration cannot express.',
    ]);
  });

  it('finds nothing on a binding without a security policy', () => {
    expect(policyOf('PlainBinding', 'Echo')).toBeUndefined();
  });
});

describe('summarizeWssPolicy', () => {
  it('keys each operation with a policy by binding and operation, and leaves the rest out', () => {
    expect(Object.keys(summarizeWssPolicy(definition)).sort()).toEqual([
      '{urn:wb:sp}AlternativesBinding|Echo',
      '{urn:wb:sp}AsymmetricBinding|Echo',
      '{urn:wb:sp}AsymmetricBinding|Secure',
      '{urn:wb:sp}SymmetricBinding|Echo',
      '{urn:wb:sp}TransportUtBinding|Echo',
    ]);
  });
});
