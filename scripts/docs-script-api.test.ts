import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/engine/src/protocols.js';
import { apiReference } from '../packages/engine/src/script/types/api.js';
import { renderScriptApiReference } from './docs-script-api.ts';

const target = fileURLToPath(new URL('../docs-site/src/content/docs/reference/script-api.md', import.meta.url));

describe('docs-site reference/script-api.md', () => {
  it('is generated from the registry, byte for byte', async () => {
    const committed = await readFile(target, 'utf-8');
    expect(renderScriptApiReference(apiReference(createBuiltinRegistry()))).toBe(committed);
  });

  it('has a section for every built-in protocol with a scripting facet, in the order of the page', () => {
    expect(apiReference(createBuiltinRegistry()).map((section) => section.title)).toEqual([
      'Every script',
      'Every request script',
      'REST: shared by both phases',
      'REST: pre-request',
      'REST: post-response',
      'SOAP: pre-request',
      'SOAP: post-response',
      'gRPC: pre-request',
      'gRPC: post-response',
      'Mock dispatch scripts',
    ]);
  });

  it('leaves out a protocol that is switched off', () => {
    const titles = apiReference(createBuiltinRegistry({ grpc: false })).map((section) => section.title);
    expect(titles).not.toContain('gRPC: pre-request');
    expect(titles).toContain('SOAP: pre-request');
  });
});
