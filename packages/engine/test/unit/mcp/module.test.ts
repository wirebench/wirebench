/** MCP as a module (#79): registered last, behind its experimental feature, with a scripting facet. */
import { describe, expect, it } from 'vitest';
import { mcpProtocol } from '#protocol-mcp/mcp/module';
import { BUILTIN_PROTOCOLS, createBuiltinRegistry } from '../../../src/protocols.js';

describe('mcpProtocol', () => {
  it('is the mcp kind behind the mcp feature, experimental and on by default', () => {
    expect(mcpProtocol.kind).toBe('mcp');
    expect(mcpProtocol.feature).toEqual({
      id: 'mcp',
      title: 'MCP requests',
      default: true,
      stage: 'experimental',
      requires: [],
    });
    expect(mcpProtocol.storage.dir).toBe('apis');
  });

  it('is the last built-in protocol, so its servers tie-break after every other container', () => {
    expect(BUILTIN_PROTOCOLS.at(-1)).toBe(mcpProtocol);
  });

  it('switches off like any other kind', () => {
    expect(createBuiltinRegistry().status('mcp')).toBe('enabled');
    expect(createBuiltinRegistry({ mcp: false }).status('mcp')).toBe('disabled');
  });
});
