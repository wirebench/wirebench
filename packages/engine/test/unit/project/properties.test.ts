import { describe, expect, it } from 'vitest';
import {
  enabledProperties,
  expand,
  expandSendInput,
  hasExpansions,
  secretNamesIn,
  type PropertyScopes,
} from '../../../src/project/properties.js';
import type { SoapSendInput } from '../../../src/types.js';

const scopes: PropertyScopes = {
  project: { name: 'proj-name', which: 'name', selfRef: '${#Project#selfRef}' },
  env: { name: 'env-name', host: 'example.test' },
  workspace: { name: 'workspace-name', onlyWorkspace: 'w-value' },
  global: { name: 'global-name', onlyGlobal: 'g-value' },
  system: { MY_VAR: 'sys-value' },
};

describe('expand', () => {
  it.each([
    ['${#Project#name}', 'proj-name'],
    ['${#Env#name}', 'env-name'],
    ['${#Workspace#name}', 'workspace-name'],
    ['${#Global#name}', 'global-name'],
    ['${#System#MY_VAR}', 'sys-value'],
  ])('resolves explicit scope form %s', (input, expected) => {
    const result = expand(input, scopes);
    expect(result.text).toBe(expected);
    expect(result.unresolved).toEqual([]);
  });

  it('resolves ${#Workspace#x} and reports it unresolved when missing', () => {
    const result = expand('${#Workspace#onlyWorkspace}', scopes);
    expect(result.text).toBe('w-value');
    expect(result.unresolved).toEqual([]);

    const missing = expand('${#Workspace#missing}', scopes);
    expect(missing.text).toBe('${#Workspace#missing}');
    expect(missing.unresolved).toEqual([
      expect.objectContaining({ scope: 'Workspace', name: 'missing', code: 'missing' }),
    ]);
  });

  it('shorthand prefers env over project over workspace over global', () => {
    expect(expand('${name}', scopes).text).toBe('env-name');
    expect(expand('${onlyWorkspace}', scopes).text).toBe('w-value');
    expect(expand('${onlyGlobal}', scopes).text).toBe('g-value');
  });

  it.each([
    ['Env', { env: { dup: 'env-value' }, project: { dup: 'proj-value' }, workspace: { dup: 'ws-value' } }],
    ['Project', { project: { dup: 'proj-value' }, workspace: { dup: 'ws-value' } }],
    ['Workspace', { workspace: { dup: 'ws-value' } }],
  ])('shorthand order: %s wins when present', (expectedScope, overrides) => {
    const result = expand('${dup}', { ...scopes, ...overrides, global: { ...scopes.global, dup: 'global-value' } });
    const expected: Record<string, string> = {
      Env: 'env-value',
      Project: 'proj-value',
      Workspace: 'ws-value',
    };
    expect(result.text).toBe(expected[expectedScope]);
  });

  it('shorthand never implicitly reaches System', () => {
    const result = expand('${MY_VAR}', scopes);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe('missing');
  });

  it('supports nesting: ${#Project#${#Env#which... }} style indirection', () => {
    const result = expand('${#Project#${which}}', { ...scopes, project: { ...scopes.project, name: 'nested-ok' } });
    expect(result.text).toBe('nested-ok');
  });

  it('recursively expands a resolved property value', () => {
    const result = expand('${indirect}', {
      ...scopes,
      env: { ...scopes.env, indirect: '${#Project#name}' },
    });
    expect(result.text).toBe('proj-name');
  });

  it('detects a self-referencing cycle through the shorthand form', () => {
    const result = expand('${loop}', { ...scopes, env: { ...scopes.env, loop: '${loop}' } });
    expect(result.unresolved).toEqual([
      { expr: '${loop}', scope: 'Env', name: 'loop', code: 'cycle', start: 0, end: 7, via: ['Env#loop'] },
    ]);
    expect(result.text).toBe('${loop}');
  });

  it('detects a self-referencing cycle', () => {
    const result = expand('${#Project#selfRef}', scopes);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.code).toBe('cycle');
    expect(result.text).toBe('${#Project#selfRef}');
  });

  it('reports too-deep beyond the depth budget', () => {
    // Build a chain of properties each pointing at the next, 10 deep (> default maxDepth 8).
    const project: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      project[`p${i}`] = `\${#Project#p${i + 1}}`;
    }
    project.p10 = 'bottom';
    const result = expand('${#Project#p0}', { ...scopes, project });
    expect(result.unresolved.some((u) => u.code === 'too-deep')).toBe(true);
  });

  it('respects a custom maxDepth option', () => {
    const result = expand('${#Project#name}', scopes, { maxDepth: 0 });
    expect(result.unresolved[0]?.code).toBe('too-deep');
  });

  it('treats $${ as an escaped literal ${', () => {
    const result = expand('$${literal}', scopes);
    expect(result.text).toBe('${literal}');
    expect(result.unresolved).toEqual([]);
  });

  it('flags an unknown scope name', () => {
    const result = expand('${#Foo#x}', scopes);
    expect(result.text).toBe('${#Foo#x}');
    expect(result.unresolved).toEqual([
      { expr: '${#Foo#x}', scope: 'Foo', name: 'x', code: 'unknown-scope', start: 0, end: 9 },
    ]);
  });

  it('flags a missing property, leaving the expression verbatim', () => {
    const result = expand('before ${#Project#nope} after', scopes);
    expect(result.text).toBe('before ${#Project#nope} after');
    expect(result.unresolved).toEqual([
      { expr: '${#Project#nope}', scope: 'Project', name: 'nope', code: 'missing', start: 7, end: 23 },
    ]);
  });

  it('flags an unterminated ${ as malformed but leaves it verbatim', () => {
    const result = expand('abc ${#Project#name', scopes);
    expect(result.text).toBe('abc ${#Project#name');
    expect(result.unresolved).toEqual([{ expr: '${#Project#name', code: 'malformed', start: 4, end: 19 }]);
  });

  it('computes correct offsets across multi-byte characters (emoji before an unresolved expression)', () => {
    const expr = '${#Project#nope}';
    const text = `🎉 ${expr}`;
    const result = expand(text, scopes);
    // The emoji is a surrogate pair (2 UTF-16 code units), so the expression starts at index 3
    // (JS/UTF-16 offsets — the same units Monaco uses for editor positions).
    const start = text.indexOf('${');
    expect(start).toBe(3);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.start).toBe(start);
    expect(result.unresolved[0]?.end).toBe(start + expr.length);
    expect(text.slice(result.unresolved[0]!.start, result.unresolved[0]!.end)).toBe(expr);
  });

  it('collects the used property list', () => {
    const result = expand('${#Project#name} and ${#Env#host}', scopes);
    expect(result.used).toEqual([
      { scope: 'Project', name: 'name' },
      { scope: 'Env', name: 'host' },
    ]);
  });

  it('de-duplicates the used property list by scope#name, preserving first-seen order', () => {
    const result = expand('${#Project#name} and ${#Project#name} again, then ${#Env#host}', scopes);
    expect(result.used).toEqual([
      { scope: 'Project', name: 'name' },
      { scope: 'Env', name: 'host' },
    ]);
  });

  it('$$${x} stays fully literal: the escape consumes before an expression can open, so x is never looked up', () => {
    const result = expand('$$${x}', { ...scopes, project: { ...scopes.project, x: 'should-not-appear' } });
    expect(result.text).not.toContain('should-not-appear');
    expect(result.unresolved).toEqual([]);
  });

  describe('nested unresolved refs (found while expanding a property value)', () => {
    it('reports the outer reference span and a one-entry via chain for a ref one level deep', () => {
      const outer = '${#Project#a}';
      const inner = '${#Project#missing}';
      const text = `before ${outer} after`;
      const result = expand(text, { ...scopes, project: { ...scopes.project, a: `x ${inner} y` } });
      expect(result.unresolved).toHaveLength(1);
      const ref = result.unresolved[0]!;
      expect(ref.code).toBe('missing');
      expect(ref.expr).toBe(inner);
      expect(ref.start).toBe(text.indexOf(outer));
      expect(ref.end).toBe(text.indexOf(outer) + outer.length);
      expect(text.slice(ref.start, ref.end)).toBe(outer);
      expect(ref.via).toEqual(['Project#a']);
    });

    it('accumulates a two-entry via chain two levels deep, still reporting the original outer span', () => {
      const outer = '${#Project#a}';
      const inner = '${#Project#missing}';
      const text = `${outer}`;
      const result = expand(text, {
        ...scopes,
        project: { ...scopes.project, a: '${#Project#b}', b: `${inner}` },
      });
      expect(result.unresolved).toHaveLength(1);
      const ref = result.unresolved[0]!;
      expect(ref.expr).toBe(inner);
      expect(ref.start).toBe(0);
      expect(ref.end).toBe(outer.length);
      expect(ref.via).toEqual(['Project#a', 'Project#b']);
    });

    it('a top-level unresolved ref keeps its own offsets and no via', () => {
      const result = expand('before ${#Project#nope} after', scopes);
      expect(result.unresolved).toEqual([
        { expr: '${#Project#nope}', scope: 'Project', name: 'nope', code: 'missing', start: 7, end: 23 },
      ]);
      expect(result.unresolved[0]).not.toHaveProperty('via');
    });
  });
});

describe('hasExpansions', () => {
  it('is true when text contains a ${ expression', () => {
    expect(hasExpansions('hello ${name}')).toBe(true);
  });
  it('is false for plain text', () => {
    expect(hasExpansions('hello world')).toBe(false);
  });
  it('is false for an escaped $${', () => {
    expect(hasExpansions('literal $${x}')).toBe(false);
  });
});

describe('expandSendInput', () => {
  it('expands endpoint, envelopeXml, soapAction and header names/values, leaving other fields untouched', () => {
    const input: SoapSendInput = {
      endpoint: 'https://${#Env#host}/soap',
      envelopeXml: '<Envelope>${#Project#name}</Envelope>',
      soapVersion: '1.1',
      soapAction: 'urn:${#Project#name}',
      headers: { 'X-${name}': '${#Global#onlyGlobal}' },
      timeoutMs: 5000,
    };
    const result = expandSendInput(input, scopes);
    expect(result.input.endpoint).toBe('https://example.test/soap');
    expect(result.input.envelopeXml).toBe('<Envelope>proj-name</Envelope>');
    expect(result.input.soapAction).toBe('urn:proj-name');
    expect(result.input.headers).toEqual({ 'X-env-name': 'g-value' });
    expect(result.input.timeoutMs).toBe(5000);
    expect(result.input.soapVersion).toBe('1.1');
    expect(result.unresolved).toEqual([]);
  });

  it('reports unresolved refs without throwing', () => {
    const input: SoapSendInput = {
      endpoint: '${#Project#missing}',
      envelopeXml: '<a/>',
      soapVersion: '1.1',
    };
    const result = expandSendInput(input, scopes);
    expect(result.input.endpoint).toBe('${#Project#missing}');
    expect(result.unresolved).toHaveLength(1);
  });

  it('expands the explicit WS-Addressing fields through the same scopes as the endpoint', () => {
    const input: SoapSendInput = {
      endpoint: 'https://example.test/soap',
      envelopeXml: '<a/>',
      soapVersion: '1.1',
      wsa: {
        config: {
          enabled: true,
          version: '2005/08',
          mustUnderstand: 'none',
          addDefaultAction: true,
          addDefaultTo: true,
          generateMessageId: true,
          to: 'https://${#Env#host}/soap',
          action: 'urn:${#Project#name}',
          replyTo: 'https://${#Env#host}/reply',
          from: 'https://${#Env#host}/from',
          faultTo: 'https://${#Env#host}/fault',
        },
        defaultAction: 'urn:default',
      },
    };
    const result = expandSendInput(input, scopes);
    expect(result.input.wsa?.config.to).toBe('https://example.test/soap');
    expect(result.input.wsa?.config.action).toBe('urn:proj-name');
    expect(result.input.wsa?.config.replyTo).toBe('https://example.test/reply');
    expect(result.input.wsa?.config.from).toBe('https://example.test/from');
    expect(result.input.wsa?.config.faultTo).toBe('https://example.test/fault');
    expect(result.unresolved).toEqual([]);
  });

  it('collapses headers whose names expand to the same string, last-write-wins', () => {
    const input: SoapSendInput = {
      endpoint: 'https://example.test/soap',
      envelopeXml: '<a/>',
      soapVersion: '1.1',
      headers: { '${#Project#name}': 'first', 'proj-name': 'second' },
    };
    const result = expandSendInput(input, scopes);
    expect(result.input.headers).toEqual({ 'proj-name': 'second' });
  });
});

describe('entitizing during expansion', () => {
  const scopes = {
    project: { markup: 'a & b <tag> c', outer: '${#Project#markup}' },
    global: {},
    system: {},
  };

  it('leaves substituted values alone by default', () => {
    expect(expand('<a>${#Project#markup}</a>', scopes).text).toBe('<a>a & b <tag> c</a>');
  });

  it('XML-escapes substituted values when asked', () => {
    expect(expand('<a>${#Project#markup}</a>', scopes, { entitize: true }).text).toBe('<a>a &amp; b &lt;tag&gt; c</a>');
  });

  it('escapes a nested expansion exactly once', () => {
    expect(expand('<a>${#Project#outer}</a>', scopes, { entitize: true }).text).toBe('<a>a &amp; b &lt;tag&gt; c</a>');
  });

  it('never escapes literal text the user typed', () => {
    expect(expand('<a>x & y ${#Project#markup}</a>', scopes, { entitize: true }).text).toBe(
      '<a>x & y a &amp; b &lt;tag&gt; c</a>',
    );
  });

  it('entitizes the envelope only, never the endpoint or a header', () => {
    const input: SoapSendInput = {
      endpoint: 'https://example.test/?q=${#Project#markup}',
      envelopeXml: '<a>${#Project#markup}</a>',
      soapVersion: '1.1',
      headers: { 'x-note': '${#Project#markup}' },
      entitize: true,
    };
    const result = expandSendInput(input, scopes);
    expect(result.input.envelopeXml).toBe('<a>a &amp; b &lt;tag&gt; c</a>');
    expect(result.input.endpoint).toBe('https://example.test/?q=a & b <tag> c');
    expect(result.input.headers).toEqual({ 'x-note': 'a & b <tag> c' });
  });
});

describe('expandSendInput attachments', () => {
  it('expands an attachment name and file path, leaving the Content-ID alone', () => {
    const scopes: PropertyScopes = { project: { dir: '/data', file: 'invoice.pdf' }, global: {} };
    const { input } = expandSendInput(
      {
        endpoint: 'http://x.test',
        envelopeXml: '<a/>',
        soapVersion: '1.1',
        attachments: [
          {
            id: 'A1',
            name: '${#Project#file}',
            contentType: 'application/pdf',
            size: 3,
            type: 'MIME',
            contentId: '${#Project#file}',
            cached: false,
            source: { kind: 'path', path: '${#Project#dir}/${#Project#file}' },
          },
          {
            id: 'A2',
            name: 'cached.bin',
            contentType: 'application/octet-stream',
            size: 1,
            type: 'CONTENT',
            contentId: 'A2@wirebench',
            cached: true,
            source: { kind: 'cache', sha256: 'b'.repeat(64) },
          },
        ],
      },
      scopes,
    );

    expect(input.attachments?.[0]?.name).toBe('invoice.pdf');
    expect(input.attachments?.[0]?.source).toEqual({ kind: 'path', path: '/data/invoice.pdf' });
    expect(input.attachments?.[0]?.contentId).toBe('${#Project#file}');
    expect(input.attachments?.[1]?.source).toEqual({ kind: 'cache', sha256: 'b'.repeat(64) });
  });
});

describe('enabledProperties', () => {
  it('returns the map unchanged when nothing is disabled', () => {
    const map = { a: '1', b: '2' };
    expect(enabledProperties(map, [])).toBe(map);
  });

  it('drops disabled names from the map', () => {
    expect(enabledProperties({ a: '1', b: '2', c: '3' }, ['b'])).toEqual({ a: '1', c: '3' });
  });

  it('ignores disabled names not present in the map', () => {
    expect(enabledProperties({ a: '1' }, ['nope'])).toEqual({ a: '1' });
  });

  it('can disable every entry', () => {
    expect(enabledProperties({ a: '1', b: '2' }, ['a', 'b'])).toEqual({});
  });
});

describe('${secret:name} expansion', () => {
  it('expands from scopes.secrets', () => {
    const result = expand('${secret:billing_key}', { project: {}, global: {}, secrets: { billing_key: 's3cret' } });
    expect(result.text).toBe('s3cret');
    expect(result.unresolved).toEqual([]);
  });

  it('is unresolved (never empty string) when the name is absent from scopes.secrets', () => {
    const result = expand('${secret:billing_key}', { project: {}, global: {}, secrets: {} });
    expect(result.text).toBe('${secret:billing_key}');
    expect(result.unresolved).toEqual([
      expect.objectContaining({ scope: 'Secret', name: 'billing_key', code: 'missing' }),
    ]);
  });

  it('is unresolved when scopes.secrets is not provided at all', () => {
    const result = expand('${secret:billing_key}', { project: {}, global: {} });
    expect(result.text).toBe('${secret:billing_key}');
    expect(result.unresolved).toEqual([
      expect.objectContaining({ scope: 'Secret', name: 'billing_key', code: 'missing' }),
    ]);
  });

  it('is unresolved for an invalid name', () => {
    const result = expand('${secret:has-dash}', { project: {}, global: {}, secrets: { 'has-dash': 'x' } });
    expect(result.text).toBe('${secret:has-dash}');
    expect(result.unresolved).toEqual([
      expect.objectContaining({ scope: 'Secret', name: 'has-dash', code: 'missing' }),
    ]);
  });

  it('leaves the $${secret:x} escape literal', () => {
    const result = expand('$${secret:x}', { project: {}, global: {}, secrets: { x: 'nope' } });
    expect(result.text).toBe('${secret:x}');
    expect(result.unresolved).toEqual([]);
  });
});

describe('secretNamesIn', () => {
  it('finds a name in a literal ${secret:name} token', () => {
    expect(secretNamesIn('Bearer ${secret:billing_key}')).toEqual(['billing_key']);
  });

  it('returns no names, and does not throw, with no scopes and no token', () => {
    expect(secretNamesIn('plain text')).toEqual([]);
  });

  it('follows a ${name} property value that itself holds a token', () => {
    const scopes: PropertyScopes = { project: { auth: '${secret:billing_key}' }, global: {} };
    expect(secretNamesIn('${auth}', scopes)).toEqual(['billing_key']);
  });

  it('follows an explicit ${#Project#x} property value', () => {
    const scopes: PropertyScopes = { project: { auth: '${secret:billing_key}' }, global: {} };
    expect(secretNamesIn('${#Project#auth}', scopes)).toEqual(['billing_key']);
  });

  it('collects names from more than one token, de-duplicated', () => {
    const scopes: PropertyScopes = { project: {}, global: {} };
    expect(secretNamesIn('${secret:a} ${secret:b} ${secret:a}', scopes)).toEqual(['a', 'b']);
  });

  it('terminates on a property cycle instead of looping forever', () => {
    const scopes: PropertyScopes = { project: { a: '${#Project#b}', b: '${#Project#a}' }, global: {} };
    expect(secretNamesIn('${#Project#a}', scopes)).toEqual([]);
  });

  it('ignores an unresolvable property reference', () => {
    const scopes: PropertyScopes = { project: {}, global: {} };
    expect(secretNamesIn('${missing}', scopes)).toEqual([]);
  });
});
