/**
 * The desktop's kinds (kind modules spec §4.1) mirror the engine's built-in protocols: the same kinds in
 * the same order, the same feature descriptors, and tab kinds no two kinds share. `shared/kinds/` is
 * value-imported by the renderer, so its kind files import nothing but types and each other.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROTOCOLS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { KINDS, kindById, toKindId } from '../src/shared/kinds/kind-module.js';

const kindsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/kinds');

describe('KINDS', () => {
  it('lists the engine’s built-in protocols, in their order, with their feature descriptors', () => {
    expect(KINDS.map((kind) => kind.kind)).toEqual(BUILTIN_PROTOCOLS.map((module) => module.kind));
    for (const kind of KINDS) {
      expect(kind.feature).toEqual(BUILTIN_PROTOCOLS.find((module) => module.kind === kind.kind)?.feature);
    }
  });

  it('gives every kind its own tab kinds', () => {
    const tabs = KINDS.flatMap((kind) => [kind.tabs.request, kind.tabs.container]);
    expect(new Set(tabs).size).toBe(tabs.length);
  });

  it('looks a kind up, and narrows a string from outside', () => {
    expect(kindById('websocket').label).toBe('WebSocket');
    expect(toKindId('grpc')).toBe('grpc');
    expect(kindById('mcp').tabs).toEqual({ request: 'mcp-request', container: 'mcp-api' });
    expect(toKindId('graphql')).toBeUndefined();
  });

  it('keeps kind-module.ts and every kind.ts free of value imports from outside shared/kinds/', () => {
    const files = [
      'kind-module.ts',
      ...readdirSync(kindsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${entry.name}/kind.ts`),
    ];
    for (const file of files) {
      const text = readFileSync(join(kindsDir, file), 'utf8');
      const valueImports = [...text.matchAll(/^import (?!type )[^;]*from '([^']+)';/gm)].map((match) => match[1]);
      expect(valueImports.filter((specifier) => !/^\.\.?\/[\w/-]*kind(-module)?\.js$/.test(specifier ?? ''))).toEqual(
        [],
      );
    }
  });
});
