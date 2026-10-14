/**
 * Kind modules spec §12: the shell files name no kind. What a kind adds is read from its module under
 * `kinds/`, so a new kind needs no edit here, and a kind switched off leaves nothing behind.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SHELL_FILES = [
  'src/renderer/shell/editor-area.tsx',
  'src/renderer/state/workspace-tabs.ts',
  'src/renderer/features/explorer/explorer-view.tsx',
  'src/renderer/features/explorer/tree-nodes.ts',
  'src/main/send/exchange.ts',
  'src/main/project-mutations.ts',
];

/** A kind's id, or one of its tab or explorer row kinds (`rest-request`, `grpc-api`, …). */
const KIND_LITERAL =
  /'(?:soap|rest|grpc|websocket|mcp)'|'(?:soap|rest|grpc|ws|mcp)-(?:request|api|operation|interface)'/;

/**
 * Lines that may still name one. A union member declares a row kind rather than branching on it, and
 * each typed preview entry point (`request.restPreview`, …) asks for its own kind's preview by name.
 */
const ALLOWED = [/^\s*\|\s*'/, /^\s*(?:const preview = await previewOf\(deps, requestId, )?\{ kind: '\w+', \.\.\./];

function literalsIn(path: string): string[] {
  const text = readFileSync(resolve(DESKTOP, path), 'utf8');
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => KIND_LITERAL.test(line) && !ALLOWED.some((allowed) => allowed.test(line)))
    .map(({ line, number }) => `${path}:${number}: ${line.trim()}`);
}

describe('the shell files', () => {
  it.each(SHELL_FILES.map((path) => [path]))('%s names no kind', (path) => {
    expect(literalsIn(path)).toEqual([]);
  });

  it('would catch one', () => {
    expect(KIND_LITERAL.test("if (item.kind === 'websocket') {")).toBe(true);
    expect(KIND_LITERAL.test("node.kind === 'grpc-api'")).toBe(true);
    expect(KIND_LITERAL.test("tab.kind === 'mcp-request'")).toBe(true);
    expect(KIND_LITERAL.test("'ws-session-exists'")).toBe(false);
  });
});
