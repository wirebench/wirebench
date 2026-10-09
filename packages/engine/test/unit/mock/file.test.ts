/**
 * The mock files (ADR-0021): they round-trip, write nothing they do not define, and treat every file as
 * untrusted input — sizes and counts bounded, headers that could split a reply refused, a newer
 * `version` refused whole.
 */
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import {
  bodyFilePath,
  mockDocument,
  mockFiles,
  operationDocument,
  parseMockFile,
  parseOperationFile,
  parseResponseFile,
  responseDocument,
  responseSlugOf,
  validateMock,
} from '../../../src/mock/file.js';
import {
  createMock,
  createMockOperation,
  createMockResponse,
  MOCK_LIMITS,
  mockPathPrefix,
} from '../../../src/mock/model.js';
import type { MockDef } from '../../../src/mock/model.js';

function orders(): MockDef {
  const outOfStock = createMockResponse('Out of stock', {
    id: 'R2',
    order: 1,
    status: 500,
    headers: [
      { name: 'X-Trace', value: 'mock' },
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' },
    ],
    delayMs: 250,
    body: 'xml',
    bodyText: '<fault/>',
    match: [
      { from: 'body', language: 'xpath', expression: '//o:sku', namespaces: { o: 'urn:orders' }, equals: 'SKU-0' },
      { from: 'query', name: 'dryRun', exists: false },
      { from: 'path', name: 'id', matches: '^[0-9]+$' },
    ],
    scenario: { name: 'stock', state: 'Empty', next: 'Restocked' },
  });
  const accepted = createMockResponse('Accepted', { id: 'R1', body: 'json', bodyText: '{"ok":true}\n' });
  return createMock(
    'Orders mock',
    { containerId: 'I1', binding: '{urn:orders}OrderSoap' },
    {
      id: 'M1',
      order: 3,
      description: 'Stands in for orders.',
      port: 8089,
      path: '/orders',
      validation: 'report',
      operations: [
        createMockOperation('PlaceOrder', 'PlaceOrder', {
          id: 'O1',
          slug: 'place-order',
          dispatch: 'match',
          defaultResponseId: 'R1',
          script: 'respond("Accepted");\n',
          responses: [accepted, outOfStock],
        }),
      ],
    },
  );
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isWirebenchError(error) ? error.code : String(error);
  }
}

function roundTrip(mock: MockDef): MockDef {
  const files = mockFiles(mock);
  const settings = parseMockFile(files.get(`mocks/${mock.slug}/mock.yaml`) ?? '', 'mock.yaml', mock.slug);
  return {
    ...settings,
    operations: mock.operations.map((operation) => {
      const dir = `mocks/${mock.slug}/operations/${operation.slug}`;
      const parsed = parseOperationFile(files.get(`${dir}/operation.yaml`) ?? '', 'operation.yaml', operation.slug);
      return {
        ...parsed,
        ...(files.has(`${dir}/dispatch.ts`) ? { script: files.get(`${dir}/dispatch.ts`) ?? '' } : {}),
        responses: operation.responses.map((response) => {
          const settings = parseResponseFile(
            files.get(`${dir}/${response.slug}.response.yaml`) ?? '',
            'r.yaml',
            response.slug,
          );
          const body = bodyFilePath(dir, response.slug, settings.body);
          return { ...settings, bodyText: body === undefined ? '' : (files.get(body) ?? '') };
        }),
      };
    }),
  };
}

describe('mock files', () => {
  it('round-trip every field', () => {
    const mock = orders();
    expect(roundTrip(mock)).toEqual(mock);
  });

  it('write one file per response and its body beside it', () => {
    expect([...mockFiles(orders()).keys()]).toEqual([
      'mocks/Orders mock/mock.yaml',
      'mocks/Orders mock/operations/place-order/operation.yaml',
      'mocks/Orders mock/operations/place-order/dispatch.ts',
      'mocks/Orders mock/operations/place-order/Accepted.response.yaml',
      'mocks/Orders mock/operations/place-order/Accepted.body.json',
      'mocks/Orders mock/operations/place-order/Out of stock.response.yaml',
      'mocks/Orders mock/operations/place-order/Out of stock.body.xml',
    ]);
  });

  it('serialise deterministically with sorted keys and defaults left out', () => {
    const mock = orders();
    expect(mockDocument(mock)).toBe(mockDocument(orders()));
    expect(mockDocument(mock)).toBe(
      [
        'description: Stands in for orders.',
        'id: M1',
        'kind: mock',
        'name: Orders mock',
        'order: 3',
        'path: /orders',
        'port: 8089',
        'source:',
        '  binding: "{urn:orders}OrderSoap"',
        '  container: I1',
        'validation: report',
        'version: 1',
        '',
      ].join('\n'),
    );
    const accepted = mock.operations[0]?.responses[0];
    expect(accepted && responseDocument(accepted)).toBe(
      ['body: json', 'id: R1', 'name: Accepted', 'order: 0', 'status: 200', ''].join('\n'),
    );
    const operation = mock.operations[0];
    expect(operation && operationDocument(operation)).toContain('default: R1');
  });

  it('drop keys they do not define', () => {
    const response = parseResponseFile(
      'id: R1\nname: A\nstatus: 201\nbody: none\nfuture: 1\nmatch:\n  - from: query\n    name: q\n    extra: x\n',
      'r.yaml',
      'a',
    );
    expect(response).not.toHaveProperty('future');
    expect(response.match[0]).toEqual({ from: 'query', name: 'q' });
  });

  it('read a YAML scalar check as text', () => {
    const response = parseResponseFile(
      'id: R1\nname: A\nheaders:\n  - name: X-N\n    value: 7\nmatch:\n  - from: query\n    name: n\n    equals: 200\n',
      'r.yaml',
      'a',
    );
    expect(response.match[0]).toMatchObject({ equals: '200' });
    expect(response.headers[0]).toEqual({ name: 'X-N', value: '7' });
  });

  it('name response files by slug and body files by language', () => {
    expect(responseSlugOf('ok.response.yaml')).toBe('ok');
    expect(responseSlugOf('.response.yaml')).toBeUndefined();
    expect(responseSlugOf('ok.body.xml')).toBeUndefined();
    expect(bodyFilePath('d', 'ok', 'text')).toBe('d/ok.body.txt');
    expect(bodyFilePath('d', 'ok', 'none')).toBeUndefined();
  });

  it('refuse a mock written by a newer build, by name', () => {
    expect(codeOf(() => parseMockFile('kind: mock\nversion: 2\nid: M\nname: x\n', 'm.yaml', 'm'))).toBe(
      'mock-version-too-new',
    );
  });

  it.each([
    ['another kind', 'kind: sequence\nversion: 1\nid: M\nname: x\nsource: { container: I }\n'],
    ['no source', 'kind: mock\nversion: 1\nid: M\nname: x\n'],
    ['a bad port', 'kind: mock\nversion: 1\nid: M\nname: x\nsource: { container: I }\nport: 70000\n'],
    ['a relative path', 'kind: mock\nversion: 1\nid: M\nname: x\nsource: { container: I }\npath: orders\n'],
    ['a query in the path', 'kind: mock\nversion: 1\nid: M\nname: x\nsource: { container: I }\npath: /o?x=1\n'],
    ['malformed YAML', 'kind: [mock\n'],
    ['a list', '- 1\n'],
  ])('refuse %s', (_label, text) => {
    expect(codeOf(() => parseMockFile(text, 'm.yaml', 'm'))).toBe('mock-file-invalid');
  });

  it.each([
    ['a CR in a header value', 'headers:\n  - name: X\n    value: "a\\r\\nX-Injected: 1"\n'],
    ['a header name with a space', 'headers:\n  - name: "X Y"\n    value: v\n'],
    ['Content-Length', 'headers:\n  - name: content-length\n    value: "9"\n'],
    ['Transfer-Encoding', 'headers:\n  - name: Transfer-Encoding\n    value: chunked\n'],
    ['a status out of range', 'status: 99\n'],
    ['a delay over the cap', `delayMs: ${MOCK_LIMITS.maxDelayMs + 1}\n`],
    ['a scenario name with a slash', 'scenario: { name: a/b }\n'],
    ['an unknown body language', 'body: html\n'],
    ['an unknown match source', 'match:\n  - from: cookie\n    name: x\n'],
  ])('refuse a response with %s', (_label, extra) => {
    expect(codeOf(() => parseResponseFile(`id: R\nname: r\n${extra}`, 'r.yaml', 'r'))).toBe('mock-file-invalid');
  });

  it('bound the counts and the file size', () => {
    const tooManyMatches = Array.from(
      { length: MOCK_LIMITS.matchesPerResponse + 1 },
      () => '  - from: query\n    name: q\n',
    ).join('');
    expect(codeOf(() => parseResponseFile(`id: R\nname: r\nmatch:\n${tooManyMatches}`, 'r.yaml', 'r'))).toBe(
      'mock-file-invalid',
    );
    const big = `id: R\nname: r\n# ${'x'.repeat(MOCK_LIMITS.fileBytes)}\n`;
    expect(codeOf(() => parseResponseFile(big, 'r.yaml', 'r'))).toBe('mock-file-invalid');
  });

  it('refuse an operation with an unknown dispatch style', () => {
    expect(codeOf(() => parseOperationFile('id: O\nname: o\noperation: x\ndispatch: weighted\n', 'o.yaml', 'o'))).toBe(
      'mock-file-invalid',
    );
  });

  it('refuse to write a slug that leaves its folder', () => {
    const mock = { ...orders(), slug: '..' };
    expect(codeOf(() => mockFiles(mock))).toBe('project-path-invalid');
  });
});

describe('mockPathPrefix', () => {
  it('drops trailing slashes, and a lone slash is no prefix', () => {
    expect(mockPathPrefix('/')).toBe('');
    expect(mockPathPrefix('/orders')).toBe('/orders');
    expect(mockPathPrefix('/orders///')).toBe('/orders');
  });

  it('takes linear time over a path of many slashes', () => {
    const path = `/a${'/'.repeat(200_000)}b`;
    const started = performance.now();
    expect(mockPathPrefix(path)).toBe(path);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('validateMock', () => {
  const ok = (): MockDef =>
    createMock(
      'Orders',
      { containerId: 'C1' },
      {
        operations: [
          createMockOperation('Place', 'PlaceOrder', {
            responses: [createMockResponse('Accepted', { body: 'xml', bodyText: '<ok/>' })],
          }),
        ],
      },
    );

  it('accepts a mock its files would load', () => {
    expect(() => validateMock(ok())).not.toThrow();
  });

  it('refuses what a load would refuse: a split header, a server-computed one, a body too large', () => {
    const withResponse = (patch: Partial<MockDef['operations'][number]['responses'][number]>): MockDef => {
      const mock = ok();
      const operation = mock.operations[0]!;
      return { ...mock, operations: [{ ...operation, responses: [{ ...operation.responses[0]!, ...patch }] }] };
    };
    expect(codeOf(() => validateMock(withResponse({ headers: [{ name: 'X-A', value: 'a\r\nb' }] })))).toBe(
      'mock-file-invalid',
    );
    expect(codeOf(() => validateMock(withResponse({ headers: [{ name: 'Content-Length', value: '1' }] })))).toBe(
      'mock-file-invalid',
    );
    expect(codeOf(() => validateMock(withResponse({ bodyText: 'x'.repeat(MOCK_LIMITS.bodyBytes + 1) })))).toBe(
      'mock-file-invalid',
    );
    expect(codeOf(() => validateMock({ ...ok(), path: 'no-slash' }))).toBe('mock-file-invalid');
  });
});
