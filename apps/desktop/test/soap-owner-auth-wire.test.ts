import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '@wirebench/engine';
import type { Interface, Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findRequest } from '../src/main/project-wire.js';
import { projectChangeSchema } from '../src/shared/wire-types.js';
import type { AuthConfigWire } from '../src/shared/wire-types.js';

const deps: MutationDeps = {
  generate: () => Promise.resolve({ envelopeXml: '<Add/>', soapVersion: '1.1', soapAction: 'urn:Add' }),
};

function build(): Project {
  const iface: Interface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://example.test/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'Primary', url: 'http://a.test/soap', authMode: 'complement' }],
    operations: [
      {
        name: 'Add',
        bindingName: '{http://tempuri.org/}CalculatorSoap',
        slug: 'Add',
        order: 0,
        requests: [createRequest('Request 1', { id: 'req-1', envelopeXml: '<Add/>', soapVersion: '1.1' })],
      },
    ],
  });
  return { ...createProject('P'), interfaces: [iface] };
}

/** The three SOAP auth mutations, each carrying `auth`. */
const sites = (auth: AuthConfigWire) =>
  [
    { kind: 'update-request-auth', requestId: 'req-1', auth },
    { kind: 'update-interface-auth', interfaceId: 'iface-1', auth },
    { kind: 'update-endpoint-auth', interfaceId: 'iface-1', endpointId: 'ep-1', auth },
  ] as const;

const TOKEN_SCHEMES: readonly AuthConfigWire[] = [
  { type: 'bearer', tokenRef: 'ref-t' },
  { type: 'api-key', name: 'X-Key', in: 'header', valueRef: 'ref-v' },
  { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'https://t', clientId: 'c', scopes: [] },
];

describe('the SOAP owner auth wire schema', () => {
  it('accepts bearer, api-key and oauth2 at every SOAP mutation', () => {
    for (const auth of TOKEN_SCHEMES) {
      for (const change of sites(auth)) {
        expect(projectChangeSchema.safeParse(change).success).toBe(true);
      }
    }
  });

  it('rejects inherit at every SOAP mutation', () => {
    for (const change of sites({ type: 'inherit' })) {
      const parsed = projectChangeSchema.safeParse(change);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('a SOAP interface, endpoint or request cannot inherit');
    }
  });
});

describe('the SOAP auth normaliser', () => {
  it('leaves absent optional fields absent, not undefined', async () => {
    const result = await applyChange(
      build(),
      {
        kind: 'update-request-auth',
        requestId: 'req-1',
        auth: { type: 'bearer', tokenRef: 'ref-t', scheme: undefined, tokenEnv: undefined },
      },
      deps,
    );
    const auth = findRequest(result.project, 'req-1')?.request.auth;
    expect(auth).toEqual({ type: 'bearer', tokenRef: 'ref-t' });
    expect(Object.keys(auth ?? {})).toEqual(['type', 'tokenRef']);
  });

  it('stores an api-key on an endpoint as sent', async () => {
    const result = await applyChange(
      build(),
      {
        kind: 'update-endpoint-auth',
        interfaceId: 'iface-1',
        endpointId: 'ep-1',
        auth: { type: 'api-key', name: 'X-Key', in: 'query', valueRef: 'ref-v' },
      },
      deps,
    );
    expect(result.project.interfaces[0]?.endpoints[0]?.auth).toEqual({
      type: 'api-key',
      name: 'X-Key',
      in: 'query',
      valueRef: 'ref-v',
    });
  });
});
