import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import type { ImportResult } from '../../../src/types.js';
import { generateDocs, sourceSnippet } from '../../../src/wsdl/docs-generator.js';
import { SOURCE_SNIPPET_CASES } from '../../helpers/source-snippet-cases.js';

const fixtureRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/', import.meta.url));

/**
 * Imports a fixture from its text at a *fixed* location, so the generated document — which
 * names the definition it documents — is byte-stable across machines and checkouts.
 */
async function importAt(relative: string, location: string): Promise<ImportResult> {
  return importDefinition({ kind: 'text', text: readFileSync(`${fixtureRoot}${relative}`, 'utf-8'), location });
}

let calculator: ImportResult;

beforeAll(async () => {
  calculator = await importAt('public/calculator/service.wsdl', 'http://example.invalid/calculator.wsdl');
});

describe('generateDocs — golden output', () => {
  it('renders the calculator definition as HTML', () => {
    expect(generateDocs(calculator, { format: 'html' })).toMatchSnapshot();
  });

  it('renders the calculator definition as Markdown', () => {
    expect(generateDocs(calculator, { format: 'markdown' })).toMatchSnapshot();
  });

  it('is deterministic', () => {
    expect(generateDocs(calculator, { format: 'html' })).toBe(generateDocs(calculator, { format: 'html' }));
    expect(generateDocs(calculator, { format: 'markdown' })).toBe(generateDocs(calculator, { format: 'markdown' }));
  });
});

describe('generateDocs — structure', () => {
  it('carries every section heading in both formats', () => {
    const headings = ['Overview', 'Services and ports', 'Bindings', 'Operations', 'Messages', 'Schema components'];
    const html = generateDocs(calculator, { format: 'html' });
    const markdown = generateDocs(calculator, { format: 'markdown' });
    for (const heading of headings) {
      expect(html).toContain(`>${heading}</h2>`);
      expect(markdown).toContain(`## ${heading}`);
    }
  });

  it('names every operation of the definition', () => {
    const html = generateDocs(calculator, { format: 'html' });
    for (const operation of calculator.operations) {
      expect(html).toContain(`${operation.bindingName.localName}.${operation.operationName}`);
    }
  });

  it('is a self-contained HTML page with no scripts or external resources', () => {
    const html = generateDocs(calculator, { format: 'html' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=|href="http/);
  });

  it('gives the Markdown document a table of contents linking every section', () => {
    const markdown = generateDocs(calculator, { format: 'markdown' });
    expect(markdown).toContain('## Contents');
    expect(markdown).toContain('- [Operations](#operations)');
    expect(markdown).toContain('- [Schema components](#schema-components)');
  });

  it('uses the supplied title, falling back to the first service name', () => {
    expect(generateDocs(calculator, { format: 'markdown', title: 'My API' }).startsWith('# My API')).toBe(true);
    expect(generateDocs(calculator, { format: 'markdown', title: '   ' }).startsWith('# Calculator')).toBe(true);
  });

  it('escapes markup coming out of the definition', async () => {
    const result = await importAt('crafted/versioned/v1/service.wsdl', 'http://example.invalid/versioned.wsdl');
    const html = generateDocs(result, { format: 'html' });
    // Every schema snippet is XML, so an unescaped one would show as live markup.
    expect(html).toContain('&lt;xsd:element');
    expect(html).not.toContain('<xsd:element');
  });

  it('documents both versioned fixtures, showing the operation each one adds', async () => {
    const v1 = await importAt('crafted/versioned/v1/service.wsdl', 'http://example.invalid/v1.wsdl');
    const v2 = await importAt('crafted/versioned/v2/service.wsdl', 'http://example.invalid/v2.wsdl');
    expect(generateDocs(v1, { format: 'markdown' })).toContain('VersionedBinding.Legacy');
    expect(generateDocs(v2, { format: 'markdown' })).toContain('VersionedBinding.Subtract');
  });
});

describe('sourceSnippet', () => {
  const xml = ['<root>', '  <a name="x">', '    <b/>', '  </a>', '  <c/>', '</root>'].join('\n');

  it('extracts a nested element with its children, dedented', () => {
    expect(sourceSnippet(xml, 2)).toBe(['<a name="x">', '  <b/>', '</a>'].join('\n'));
  });

  it('extracts a self-closing element as one line', () => {
    expect(sourceSnippet(xml, 5)).toBe('<c/>');
  });

  it('caps a long element and marks the cut', () => {
    expect(sourceSnippet(xml, 1, 2)).toBe(['<root>', '  <a name="x">', '…'].join('\n'));
  });

  it('returns nothing for a line outside the document', () => {
    expect(sourceSnippet(xml, 0)).toBe('');
    expect(sourceSnippet(xml, 99)).toBe('');
  });

  it('returns the line itself when it opens no element', () => {
    expect(sourceSnippet('plain text\nmore', 1)).toBe('plain text');
  });

  // Shared with the renderer's own `sourceSnippet` (apps/desktop) — a deliberate second
  // implementation, not a copy of this one; see the comment atop `wsdl/docs-generator.ts`.
  for (const testCase of SOURCE_SNIPPET_CASES) {
    it(`matches the renderer's implementation: ${testCase.name}`, () => {
      expect(sourceSnippet(testCase.text, testCase.line, testCase.maxLines)).toBe(testCase.expected);
    });
  }
});

describe('generateDocs — other definition shapes', () => {
  it('documents an rpc/literal definition, with its type-bound parts and parameter order', async () => {
    const result = await importAt('crafted/rpc-literal/service.wsdl', 'http://example.invalid/rpclit.wsdl');
    const markdown = generateDocs(result, { format: 'markdown' });
    expect(markdown).toContain('**Style:** rpc');
    expect(markdown).toContain('type {http://www.w3.org/2001/XMLSchema}int');
  });

  it('documents SOAP headers and faults', async () => {
    const headers = await importAt('crafted/soap-headers/service.wsdl', 'http://example.invalid/headers.wsdl');
    expect(generateDocs(headers, { format: 'markdown' })).toContain('SOAP header');

    const wsi = await importAt('crafted/wsi-compliant/service.wsdl', 'http://example.invalid/wsi.wsdl');
    expect(generateDocs(wsi, { format: 'markdown' })).toContain('Fault "EchoFault"');
  });

  it('lists every document of a multi-document bundle', async () => {
    const result = await importDefinition({
      kind: 'file',
      path: `${fixtureRoot}crafted/nested-imports/service.wsdl`,
    });
    const html = generateDocs(result, { format: 'html' });
    expect(html).toContain('common.xsd');
    expect(html).toContain('base.xsd');
  });

  it('falls back to the root document name when the definition declares no service', async () => {
    const text = [
      '<?xml version="1.0"?>',
      '<wsdl:definitions targetNamespace="urn:wb:empty" xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">',
      '  <wsdl:documentation>Nothing at all.</wsdl:documentation>',
      '</wsdl:definitions>',
    ].join('\n');
    const result = await importDefinition({ kind: 'text', text, location: 'http://example.invalid/empty.wsdl' });
    const markdown = generateDocs(result, { format: 'markdown' });
    expect(markdown.startsWith('# empty.wsdl')).toBe(true);
    expect(markdown).toContain('Nothing at all.');
    // Empty sections render as a heading with nothing under them, never a broken table.
    expect(markdown).toContain('## Messages');
    expect(markdown).not.toContain('| Message | Part | Binds to |');
  });
});
