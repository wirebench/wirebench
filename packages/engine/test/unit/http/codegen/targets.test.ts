/**
 * Every code target over one fixed set of requests, written out in full per target: the point of a
 * snippet is the exact text a user pastes, so the snapshot is the whole of it.
 */
import { describe, expect, it } from 'vitest';
import { CODE_TARGETS, envMarker, generateCode, splitEnv } from '../../../../src/http/codegen/index.js';
import type { CodeRequest } from '../../../../src/http/codegen/index.js';

const BASE: Omit<CodeRequest, 'method' | 'url' | 'headers' | 'body'> = { followRedirects: true };

const TOKEN = envMarker('WIREBENCH_SECRET_API_TOKEN');

/** The fixed set: one request per shape a target has to get right. */
const FIXTURES: readonly (readonly [string, CodeRequest])[] = [
  [
    'query and headers',
    {
      ...BASE,
      method: 'GET',
      url: 'https://api.example.com/v1/items?q=red%20shoes&page=2',
      headers: [
        { name: 'Accept', value: 'application/json' },
        { name: 'X-Trace', value: 'it\'s "quoted"' },
        { name: 'X-Trace', value: 'second' },
      ],
      body: { kind: 'none' },
    },
  ],
  [
    'json body',
    {
      ...BASE,
      method: 'POST',
      url: 'https://api.example.com/v1/items',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: { kind: 'raw', text: '{\n  "name": "Widget",\n  "price": 9.5\n}' },
      timeoutMs: 30000,
    },
  ],
  [
    'form body',
    {
      ...BASE,
      method: 'POST',
      url: 'https://api.example.com/login',
      headers: [],
      body: {
        kind: 'form',
        fields: [
          { name: 'user', value: 'ada lovelace' },
          { name: 'scope', value: 'read&write' },
        ],
      },
    },
  ],
  [
    'multipart body',
    {
      ...BASE,
      method: 'POST',
      url: 'https://api.example.com/upload',
      headers: [],
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'title', value: 'Report' },
          { kind: 'file', name: 'file', path: '/tmp/report.pdf', contentType: 'application/pdf' },
        ],
      },
    },
  ],
  [
    'binary body',
    {
      ...BASE,
      method: 'PUT',
      url: 'https://api.example.com/blobs/1',
      headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
      body: { kind: 'binary', path: '/tmp/blob.bin' },
    },
  ],
  [
    'basic auth from the environment',
    {
      ...BASE,
      method: 'GET',
      url: 'https://api.example.com/me',
      headers: [],
      body: { kind: 'none' },
      basic: { username: 'ada', password: envMarker('WIREBENCH_SECRET_PASSWORD') },
    },
  ],
  [
    'bearer token and query key from the environment',
    {
      ...BASE,
      method: 'DELETE',
      url: `https://api.example.com/items/7?api_key=${envMarker('WIREBENCH_SECRET_KEY')}`,
      headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
      body: { kind: 'none' },
    },
  ],
  [
    'insecure, no redirects, redirect limit ignored',
    {
      method: 'GET',
      url: 'https://self-signed.example.com/health',
      headers: [],
      body: { kind: 'none' },
      insecure: true,
      followRedirects: false,
      maxRedirects: 3,
      timeoutMs: 1500,
    },
  ],
  [
    'soap envelope',
    {
      method: 'POST',
      url: 'http://soap.example.com/calculator',
      headers: [
        { name: 'Content-Type', value: 'text/xml;charset=UTF-8' },
        { name: 'SOAPAction', value: '"http://tempuri.org/Add"' },
      ],
      body: {
        kind: 'raw',
        text: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body><Add><a>1</a><b>2</b></Add></soap:Body>\n</soap:Envelope>',
      },
      followRedirects: false,
    },
  ],
];

describe('generateCode', () => {
  for (const { id } of CODE_TARGETS) {
    it(`renders every fixture as ${id}`, async () => {
      const text = FIXTURES.map(([name, request]) => {
        const { code, notes } = generateCode(id, request);
        const noted = notes.length > 0 ? `\n--- notes\n${notes.join('\n')}` : '';
        return `=== ${name}\n${code}${noted}\n`;
      }).join('\n');
      await expect(text).toMatchFileSnapshot(`./__snapshots__/${id}.txt`);
    });
  }

  it('never writes an environment marker into the code', () => {
    for (const { id } of CODE_TARGETS) {
      for (const [, request] of FIXTURES) {
        expect(generateCode(id, request).code).not.toMatch(/WBENV/);
      }
    }
  });

  it('applies the per-target settings over the request', () => {
    const [, request] = FIXTURES[1] as readonly [string, CodeRequest];
    const { code } = generateCode('python-requests', request, { indent: 2, followRedirects: false, timeoutMs: 0 });
    expect(code).toContain('\n  allow_redirects=False,');
    expect(code).not.toContain('timeout=');
  });

  it('uses a tab for Go unless told otherwise', () => {
    const [, request] = FIXTURES[0] as readonly [string, CodeRequest];
    expect(generateCode('go-net-http', request).code).toContain('\n\treq, err := http.NewRequest(');
    expect(generateCode('go-net-http', request, { indent: 4 }).code).toContain('\n    req, err := http.NewRequest(');
  });
});

describe('splitEnv', () => {
  it('splits literal text from environment reads', () => {
    expect(splitEnv(`Bearer ${TOKEN}!`)).toEqual([
      { text: 'Bearer ' },
      { env: 'WIREBENCH_SECRET_API_TOKEN' },
      { text: '!' },
    ]);
  });

  it('keeps plain text, even empty, as one part', () => {
    expect(splitEnv('')).toEqual([{ text: '' }]);
    expect(splitEnv('plain')).toEqual([{ text: 'plain' }]);
  });

  it('survives URL encoding', () => {
    expect(encodeURIComponent(TOKEN)).toBe(TOKEN);
  });
});
