import { describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import {
  environmentFileSchema,
  interfaceFileSchema,
  keystoresFileSchema,
  manifestSchema,
  parseFile,
  requestFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from '../../../src/project/schema.js';
import { migrate } from '../../../src/project/migrate.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_REQUEST_PROPERTIES,
  createInterface,
  createProject,
  createRequest,
  generateId,
} from '../../../src/project/model.js';
import { stringifyYaml, parseYaml } from '../../../src/project/yaml.js';

const validManifest = {
  formatVersion: 1,
  id: 'X',
  name: 'p',
  settings: { ...DEFAULT_PROJECT_SETTINGS },
  properties: {},
};

describe('parseFile', () => {
  it('returns the parsed document when valid', () => {
    expect(parseFile(manifestSchema, validManifest, 'wirebench.yaml')).toEqual(validManifest);
  });

  it('raises project-file-invalid carrying the file and the issues for a genuinely invalid document', () => {
    const error = (() => {
      try {
        parseFile(manifestSchema, { ...validManifest, id: '' }, 'wirebench.yaml');
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe('project-file-invalid');
    expect((error as ProjectError).details).toMatchObject({ file: 'wirebench.yaml' });
    expect(JSON.stringify((error as ProjectError).details)).toContain('id');
  });

  it('accepts (and ignores, at the model layer) an unknown top-level manifest key', () => {
    expect(() => parseFile(manifestSchema, { ...validManifest, extra: true }, 'wirebench.yaml')).not.toThrow();
  });
});

describe('loose schemas', () => {
  it('accepts and ignores an unknown key in an interface document, but still validates known fields', () => {
    const iface = {
      kind: 'soap',
      id: 'I',
      name: 'n',
      order: 0,
      definitionUrl: 'u',
      cacheDefinition: true,
      endpoints: [],
      wsa: { enabled: false, version: '2005/08' },
      operations: [],
    };
    expect(() => parseFile(interfaceFileSchema, iface, 'i.yaml')).not.toThrow();
    expect(() => parseFile(interfaceFileSchema, { ...iface, futureField: 'x' }, 'i.yaml')).not.toThrow();
    expect(() => parseFile(interfaceFileSchema, { ...iface, soapVersion: '1.1' }, 'i.yaml')).not.toThrow();
    expect(() => parseFile(interfaceFileSchema, { ...iface, kind: 'rest' }, 'i.yaml')).toThrow(ProjectError);
  });

  it('accepts an unknown key in a request document but rejects a bad soapVersion', () => {
    const request = {
      kind: 'soap',
      id: 'R',
      name: 'n',
      order: 0,
      soapVersion: '1.2',
      headers: [],
      attachments: [],
      properties: { ...DEFAULT_REQUEST_PROPERTIES },
    };
    expect(() => parseFile(requestFileSchema, request, 'r.yaml')).not.toThrow();
    expect(() => parseFile(requestFileSchema, { ...request, envelopeXml: '<x/>' }, 'r.yaml')).not.toThrow();
    expect(() => parseFile(requestFileSchema, { ...request, soapVersion: '1.0' }, 'r.yaml')).toThrow(ProjectError);
  });

  it('accepts an unknown key in an environment document', () => {
    const env = { id: 'E', name: 'dev', order: 0, endpoints: {}, properties: {} };
    expect(() => parseFile(environmentFileSchema, env, 'e.yaml')).not.toThrow();
    expect(() => parseFile(environmentFileSchema, { ...env, active: true }, 'e.yaml')).not.toThrow();
  });

  it('never accepts a plaintext password field, even though the rest of the object is loose', () => {
    const iface = {
      kind: 'soap',
      id: 'I',
      name: 'n',
      order: 0,
      definitionUrl: 'u',
      cacheDefinition: true,
      endpoints: [],
      wsa: { enabled: false, version: '2005/08' },
      operations: [],
      auth: { type: 'basic', username: 'u', password: 'hunter2' },
    };
    expect(() => parseFile(interfaceFileSchema, iface, 'i.yaml')).toThrow(ProjectError);
  });
});

describe('extension-point schemas', () => {
  it('keeps unknown keys in WS-Security documents for later tasks', () => {
    const parsed = parseFile(
      wssOutgoingFileSchema,
      { id: 'W', name: 'sig', entries: [{ type: 'Timestamp' }] },
      'w.yaml',
    );
    expect(parsed).toMatchObject({ id: 'W', entries: [{ type: 'Timestamp' }] });
    expect(parseFile(wssIncomingFileSchema, { id: 'W', name: 'in', decrypt: 'ks' }, 'w.yaml')).toMatchObject({
      decrypt: 'ks',
    });
    expect(
      parseFile(keystoresFileSchema, { keystores: [{ id: 'K', name: 'p12', path: 'a.p12' }] }, 'k.yaml'),
    ).toMatchObject({ keystores: [{ path: 'a.p12' }] });
  });
});

describe('migrate', () => {
  it('passes version 1 through unchanged', () => {
    expect(migrate(validManifest, 'wirebench.yaml')).toBe(validManifest);
  });

  it('rejects a newer format version', () => {
    const error = (() => {
      try {
        migrate({ formatVersion: 7 }, 'wirebench.yaml');
      } catch (e) {
        return e as ProjectError;
      }
      return undefined;
    })();
    expect(error?.code).toBe('project-format-too-new');
    expect(error?.details).toMatchObject({ formatVersion: 7, supported: 1 });
  });

  it.each([[{ formatVersion: 0 }], [{ formatVersion: '1' }], [{}], [{ formatVersion: 1.5 }]])(
    'rejects %j as project-file-invalid',
    (document) => {
      try {
        migrate(document, 'wirebench.yaml');
        expect.unreachable();
      } catch (e) {
        expect((e as ProjectError).code).toBe('project-file-invalid');
      }
    },
  );

  it('rejects a non-mapping document', () => {
    for (const document of [null, 'text', [1, 2]]) {
      try {
        migrate(document, 'wirebench.yaml');
        expect.unreachable();
      } catch (e) {
        expect((e as ProjectError).code).toBe('project-file-invalid');
      }
    }
  });
});

describe('yaml helpers', () => {
  it('sorts keys and does not wrap long scalars', () => {
    const long = `https://example.test/${'x'.repeat(200)}`;
    const text = stringifyYaml({ z: 1, a: long });
    expect(text).toBe(`a: ${long}\nz: 1\n`);
  });

  it('raises project-file-invalid with the file for malformed yaml', () => {
    try {
      parseYaml('a: [1\n', 'bad.yaml');
      expect.unreachable();
    } catch (e) {
      expect((e as ProjectError).code).toBe('project-file-invalid');
      expect((e as ProjectError).details).toMatchObject({ file: 'bad.yaml' });
    }
  });
});

describe('factories', () => {
  it('creates a project with defaults and a ULID id', () => {
    const project = createProject('Demo');
    expect(project).toMatchObject({ formatVersion: 1, name: 'Demo', settings: DEFAULT_PROJECT_SETTINGS });
    expect(project.id).toHaveLength(26);
    expect(generateId()).toHaveLength(26);
  });

  it('accepts an injected id generator', () => {
    let n = 0;
    const newId = () => `id-${(n += 1)}`;
    expect(createProject('Demo', { newId }).id).toBe('id-1');
    expect(createProject('Demo', { id: 'fixed' }).id).toBe('fixed');
  });

  it('slugifies the interface name and defaults the endpoint', () => {
    const iface = createInterface('Orders: v2', {
      definitionUrl: 'u',
      id: 'I',
      endpoints: [{ id: 'E1', name: 'prod', url: 'https://x', authMode: 'override' }],
      targetNamespace: 'urn:x',
    });
    expect(iface).toMatchObject({
      kind: 'soap',
      slug: 'Orders_ v2',
      defaultEndpointId: 'E1',
      cacheDefinition: true,
      targetNamespace: 'urn:x',
      wsa: { enabled: false, version: '2005/08' },
    });
    expect(createInterface('Plain', { definitionUrl: 'u', id: 'I' }).defaultEndpointId).toBeUndefined();
  });

  it('applies the default request properties, overridable per field', () => {
    const request = createRequest('Request 1', {
      envelopeXml: '<x/>',
      soapVersion: '1.1',
      id: 'R',
      soapAction: 'urn:a',
      endpointId: 'E1',
      properties: { prettyPrint: true },
    });
    expect(request.properties).toEqual({ ...DEFAULT_REQUEST_PROPERTIES, prettyPrint: true });
    expect(request).toMatchObject({ kind: 'soap', slug: 'Request 1', order: 0, attachments: [], headers: [] });
  });
});
