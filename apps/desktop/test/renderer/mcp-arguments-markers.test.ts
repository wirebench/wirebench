/**
 * The MCP Arguments editor's markers (#79): main's problems put on the model under their own owner,
 * located by pointer or by where the parse stopped, and an answer for text the model no longer
 * holds dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMonaco, fakeMonacoWithMarkers, setMarkers } from '../mocks/monaco-editor-react.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  MCP_ARGUMENTS_MARKER_OWNER,
  mcpArgumentsMarkerData,
  refreshMcpArgumentsMarkers,
} from '../../src/renderer/features/mcp-editor/arguments-markers.js';

const mcpArgumentsCheck = vi.fn();

function model(version = 1) {
  return { uri: { toString: () => 'inmemory://args' }, getVersionId: () => version, isDisposed: () => false };
}

beforeEach(() => {
  mcpArgumentsCheck.mockReset();
  installWirebenchApi({ request: { mcpArgumentsCheck } });
  setMarkers.length = 0;
});

describe('mcpArgumentsMarkerData', () => {
  const TEXT = '{\n  "city": "Vienna",\n  "days": "three"\n}';

  it('puts a schema warning on the value its pointer names', () => {
    const [marker] = mcpArgumentsMarkerData(
      fakeMonaco.MarkerSeverity,
      [{ severity: 'warning', message: 'expected integer', pointer: '/days', keyword: 'type' }],
      TEXT,
    );
    expect(marker).toMatchObject({
      severity: fakeMonaco.MarkerSeverity.Warning,
      message: 'expected integer',
      code: 'type',
      source: 'mcp',
      startLineNumber: 3,
      endLineNumber: 3,
    });
  });

  it('puts a problem with the whole object on its first line, and a parse error where it stopped', () => {
    const markers = mcpArgumentsMarkerData(
      fakeMonaco.MarkerSeverity,
      [
        { severity: 'warning', message: 'missing required property "x"', pointer: '', keyword: 'required' },
        { severity: 'error', message: 'The arguments are not JSON', pointer: '', position: { line: 2, column: 5 } },
      ],
      TEXT,
    );
    expect(markers[0]).toMatchObject({ startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2 });
    expect(markers[1]).toMatchObject({
      severity: fakeMonaco.MarkerSeverity.Error,
      startLineNumber: 2,
      startColumn: 5,
      endLineNumber: 2,
      endColumn: 6,
    });
  });
});

describe('refreshMcpArgumentsMarkers', () => {
  it("marks the model with main's answer under the editor's own owner", async () => {
    mcpArgumentsCheck.mockResolvedValue({
      ok: true,
      value: { problems: [{ severity: 'warning', message: 'expected string', pointer: '/path' }] },
    });

    expect(await refreshMcpArgumentsMarkers(fakeMonacoWithMarkers as never, model() as never, '{"path":1}', {})).toBe(
      true,
    );
    expect(mcpArgumentsCheck).toHaveBeenCalledWith({ text: '{"path":1}', schema: {} });
    expect(setMarkers).toEqual([
      {
        uri: 'inmemory://args',
        owner: MCP_ARGUMENTS_MARKER_OWNER,
        markers: [expect.objectContaining({ message: 'expected string' })],
      },
    ]);
  });

  it('drops an answer for text the model no longer holds', async () => {
    let version = 1;
    const changing = { ...model(), getVersionId: () => version };
    mcpArgumentsCheck.mockImplementation(() => {
      version = 2;
      return Promise.resolve({ ok: true, value: { problems: [] } });
    });

    expect(await refreshMcpArgumentsMarkers(fakeMonacoWithMarkers as never, changing as never, '{}', undefined)).toBe(
      false,
    );
    expect(mcpArgumentsCheck).toHaveBeenCalledWith({ text: '{}' });
    expect(setMarkers).toEqual([]);
  });
});
