/**
 * The MCP request editor (#79).
 *
 * What a user would notice going wrong: switching the method stages a fresh operation of that
 * method; the tool and prompt pickers offer the catalogue's names and take a typed one; the
 * arguments editor completes from the named tool's input schema; a prompt's arguments are a table
 * with its declared ones offered; Send names only the request and its draft, and Cancel ends the
 * send in flight; the timeout falls back to the server's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

const completion = vi.hoisted(() => ({ set: vi.fn(), clear: vi.fn() }));
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('../../src/renderer/editor/json-completion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/editor/json-completion.js')>();
  return {
    ...actual,
    setJsonCompletionSource: (...args: Parameters<typeof actual.setJsonCompletionSource>) => {
      completion.set(...args);
      actual.setJsonCompletionSource(...args);
    },
    clearJsonCompletionSource: (...args: Parameters<typeof actual.clearJsonCompletionSource>) => {
      completion.clear(...args);
      actual.clearJsonCompletionSource(...args);
    },
  };
});

import { McpEditor, mcpOutcome } from '../../src/renderer/features/mcp-editor/mcp-editor.js';
import { schemaFieldsAt } from '../../src/renderer/features/mcp-editor/arguments-completion.js';
import { MCP_METHODS, switchMethod } from '../../src/renderer/features/mcp-editor/operation-bar.js';
import type { JsonCompletionSource } from '../../src/renderer/editor/json-completion.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { mcpRequestWire, mcpServerWire } from '../helpers/wire-defaults.js';
import type {
  McpCatalogueWire,
  McpExchangeSummary,
  McpRequestWire,
  McpServerWire,
} from '../../src/shared/kinds/mcp/wire.js';

const sendMcp = vi.fn();
const cancelMcp = vi.fn();

const READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Where the file is.' },
    encoding: { enum: ['utf-8', 'base64'] },
    options: { $ref: '#/$defs/options' },
    lines: { type: 'array', items: { type: 'object', properties: { from: { type: 'integer' } } } },
  },
  required: ['path'],
  $defs: { options: { type: 'object', properties: { follow: { type: 'boolean' } } } },
};

const CATALOGUE: McpCatalogueWire = {
  tools: [
    { name: 'read_file', description: 'Reads one file.', inputSchema: READ_FILE_SCHEMA },
    { name: 'list_dir', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
  ],
  resources: [{ uri: 'file:///notes.md', name: 'Notes' }],
  prompts: [
    {
      name: 'summarise',
      arguments: [
        { name: 'topic', required: true },
        { name: 'tone', description: 'How it reads.' },
      ],
    },
  ],
};

function seed(request: McpRequestWire, server: McpServerWire = mcpServerWire({ catalogue: CATALOGUE })): void {
  useProjectStore.setState({
    mcpServers: { [server.id]: server },
    mcpRequests: { [request.id]: request },
    folders: {},
    projects: {},
    projectOf: { [server.id]: 'p1', [request.id]: 'p1' },
  });
}

function mount(requestId = 'mcp-1'): void {
  render(
    <TooltipPrimitive.Provider>
      <McpEditor requestId={requestId} />
    </TooltipPrimitive.Provider>,
  );
}

function staged(requestId = 'mcp-1'): Record<string, unknown> | undefined {
  return useDraftsStore.getState().peekMcpRequest(requestId);
}

beforeEach(() => {
  sendMcp.mockReset().mockResolvedValue({
    ok: true,
    value: {
      sendId: 'ignored',
      transport: { type: 'http', url: 'https://mcp.test/mcp' },
      method: 'tools/call',
      startedAt: '2026-10-14T00:00:00.000Z',
      durationMs: 42,
      messages: [],
      droppedMessages: 0,
      result: { content: [] },
      warnings: [],
    },
  });
  cancelMcp.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  completion.set.mockReset();
  completion.clear.mockReset();
  installWirebenchApi({ request: { sendMcp, cancelMcp } });
  useDraftsStore.getState().reset();
  useEditorsStore.getState().reset();
  useExchangesStore.setState({ mcpByRequest: {} });
});

afterEach(() => {
  cleanup();
});

describe('switchMethod', () => {
  it('starts each method’s own fields blank and keeps the same method whole', () => {
    const call = { method: 'tools/call', tool: 'read_file', arguments: '{}' } as const;
    expect(switchMethod(call, 'tools/call')).toBe(call);
    expect(switchMethod(call, 'resources/read')).toEqual({ method: 'resources/read', uri: '' });
    expect(switchMethod(call, 'prompts/get')).toEqual({ method: 'prompts/get', prompt: '', arguments: [] });
    expect(switchMethod(call, 'resources/templates/list')).toEqual({ method: 'resources/templates/list' });
    expect(switchMethod({ method: 'tools/list' }, 'tools/call')).toEqual({
      method: 'tools/call',
      tool: '',
      arguments: '',
    });
  });
});

describe('McpEditor — the operation bar', () => {
  it('lists the seven methods and stages each one picked', () => {
    seed(mcpRequestWire());
    mount();

    const select = screen.getByTestId<HTMLSelectElement>('mcp-method');
    expect([...select.options].map((option) => option.value)).toEqual([...MCP_METHODS]);
    expect(MCP_METHODS).toHaveLength(7);

    for (const method of MCP_METHODS) {
      fireEvent.change(screen.getByTestId('mcp-method'), { target: { value: method } });
      expect((staged()?.operation as { method: string }).method).toBe(method);
    }
    expect(screen.getByTestId('mcp-list-hint')).toBeTruthy();
  });

  it('shows the tool picker for a call, offering the catalogue’s tools and keeping a typed name', () => {
    seed(mcpRequestWire({ operation: { method: 'tools/call', tool: 'read_file', arguments: '' } }));
    mount();

    expect(screen.getByTestId<HTMLInputElement>('mcp-tool').value).toBe('read_file');
    const offered = [...screen.getByTestId('mcp-tool-options').querySelectorAll('option')].map((o) => o.value);
    expect(offered).toEqual(['read_file', 'list_dir']);
    expect(screen.queryByTestId('mcp-uri')).toBeNull();

    fireEvent.change(screen.getByTestId('mcp-tool'), { target: { value: 'not_listed' } });
    expect(staged()?.operation).toEqual({ method: 'tools/call', tool: 'not_listed', arguments: '' });
  });

  it('shows the URI for a read and the prompt picker for a prompt', () => {
    seed(mcpRequestWire({ operation: { method: 'resources/read', uri: 'file:///notes.md' } }));
    mount();
    expect(screen.getByTestId<HTMLInputElement>('mcp-uri').value).toBe('file:///notes.md');
    expect([...screen.getByTestId('mcp-uri-options').querySelectorAll('option')].map((o) => o.value)).toEqual([
      'file:///notes.md',
    ]);
    fireEvent.change(screen.getByTestId('mcp-uri'), { target: { value: 'file:///other.md' } });
    expect(staged()?.operation).toEqual({ method: 'resources/read', uri: 'file:///other.md' });
    expect(screen.getByTestId('mcp-arguments-none')).toBeTruthy();
    cleanup();

    seed(mcpRequestWire({ operation: { method: 'prompts/get', prompt: 'summarise', arguments: [] } }));
    mount();
    expect(screen.getByTestId<HTMLInputElement>('mcp-prompt').value).toBe('summarise');
    expect([...screen.getByTestId('mcp-prompt-options').querySelectorAll('option')].map((o) => o.value)).toEqual([
      'summarise',
    ]);
  });
});

describe('McpEditor — the arguments', () => {
  it('hands the named tool’s input schema to the JSON editor and stages an edit', async () => {
    seed(mcpRequestWire({ operation: { method: 'tools/call', tool: 'read_file', arguments: '{}' } }));
    mount();

    await waitFor(() => {
      expect(completion.set).toHaveBeenCalled();
    });
    const source = completion.set.mock.calls.at(-1)?.[1] as JsonCompletionSource;
    expect((await source.fetchFields([])).map((field) => field.name)).toEqual(['path', 'encoding', 'options', 'lines']);
    expect((await source.fetchFields(['options'])).map((field) => field.name)).toEqual(['follow']);
    expect(screen.getByTestId('mcp-arguments-hint').textContent).toBe('Reads one file.');

    fireEvent.change(screen.getByLabelText('Tool arguments'), { target: { value: '{"path":"a.txt"}' } });
    expect(staged()?.operation).toEqual({ method: 'tools/call', tool: 'read_file', arguments: '{"path":"a.txt"}' });
  });

  it('follows the tool named, and gives a tool not in the catalogue no schema', async () => {
    seed(mcpRequestWire({ operation: { method: 'tools/call', tool: 'read_file', arguments: '' } }));
    mount();
    await waitFor(() => {
      expect(completion.set).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByTestId('mcp-tool'), { target: { value: 'list_dir' } });
    await waitFor(() => {
      expect(completion.set).toHaveBeenCalledTimes(2);
    });
    const source = completion.set.mock.calls[1]?.[1] as JsonCompletionSource;
    expect((await source.fetchFields([])).map((field) => field.name)).toEqual(['dir']);

    fireEvent.change(screen.getByTestId('mcp-tool'), { target: { value: 'nowhere' } });
    await waitFor(() => {
      expect(completion.clear).toHaveBeenCalledTimes(2);
    });
    expect(completion.set).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('mcp-arguments-hint').textContent).toContain('not in the catalogue');
  });

  it('edits a prompt’s arguments as a table and adds the declared ones it lacks', () => {
    seed(
      mcpRequestWire({
        operation: {
          method: 'prompts/get',
          prompt: 'summarise',
          arguments: [{ name: 'topic', value: 'cats', enabled: true }],
        },
      }),
    );
    mount();

    expect(screen.getByTestId('mcp-prompt-declared').textContent).toBe('Declared: topic (required), tone');
    expect(screen.getByTestId<HTMLTextAreaElement>('mcp-prompt-arg-value').value).toBe('cats');

    fireEvent.click(screen.getByTestId('mcp-prompt-add-declared'));
    expect(staged()?.operation).toEqual({
      method: 'prompts/get',
      prompt: 'summarise',
      arguments: [
        { name: 'topic', value: 'cats', enabled: true },
        { name: 'tone', value: '', enabled: true, description: 'How it reads.' },
      ],
    });
    expect(screen.queryByTestId('mcp-prompt-add-declared')).toBeNull();
  });
});

describe('McpEditor — send, cancel and settings', () => {
  it('sends the request with its draft and shows the outcome', async () => {
    seed(mcpRequestWire({ operation: { method: 'tools/call', tool: 'read_file', arguments: '' } }));
    mount();
    fireEvent.change(screen.getByTestId('mcp-tool'), { target: { value: 'list_dir' } });

    fireEvent.click(screen.getByTestId('mcp-send'));
    await waitFor(() => {
      expect(sendMcp).toHaveBeenCalledTimes(1);
    });
    expect(sendMcp.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'mcp-1',
      draft: { operation: { method: 'tools/call', tool: 'list_dir', arguments: '' } },
    });
    await waitFor(() => {
      expect(screen.getByTestId('mcp-response-status').textContent).toBe('OK42 ms · 0 messages');
    });
  });

  it('offers Cancel while a send is in flight and ends it', async () => {
    seed(mcpRequestWire());
    useExchangesStore.setState({ mcpByRequest: { 'mcp-1': { status: 'sending', sendId: 'send-7' } } });
    mount();

    const button = screen.getByTestId('mcp-send');
    expect(button.textContent).toBe('Cancel');
    fireEvent.click(button);
    await waitFor(() => {
      expect(cancelMcp).toHaveBeenCalledWith({ sendId: 'send-7' });
    });
    expect(sendMcp).not.toHaveBeenCalled();
  });

  it('stages the timeout and shows the server’s as the fallback', () => {
    seed(mcpRequestWire(), mcpServerWire({ settings: { timeoutMs: 9000 } }));
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));

    const field = screen.getByTestId<HTMLInputElement>('mcp-setting-timeout');
    expect(field.placeholder).toBe('9000');
    fireEvent.change(field, { target: { value: '1500' } });
    fireEvent.blur(field);
    expect(staged()?.settings).toEqual({ timeoutMs: 1500 });
  });

  it('opens the shared Assertions and Scripts tabs', () => {
    seed(mcpRequestWire());
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Assertions' }));
    expect(screen.queryByTestId('mcp-arguments-none')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Scripts' }));
    expect(screen.getByRole('tab', { name: 'Scripts' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('mcpOutcome', () => {
  const base: McpExchangeSummary = {
    sendId: 's',
    transport: { type: 'http', url: 'u' },
    method: 'tools/call',
    startedAt: 't',
    durationMs: 1,
    messages: [],
    droppedMessages: 0,
    warnings: [],
  };

  it('reads a tool error, a JSON-RPC error and a stopped session', () => {
    expect(mcpOutcome(undefined)).toBeUndefined();
    expect(mcpOutcome({ status: 'done', exchange: { ...base, result: { isError: true, content: [] } } })).toBe(
      'Tool error (isError)',
    );
    expect(
      mcpOutcome({ status: 'done', exchange: { ...base, error: { code: -32602, message: 'Invalid params' } } }),
    ).toBe('Error -32602 Invalid params');
    expect(
      mcpOutcome({ status: 'done', exchange: { ...base, failure: { code: 'mcp-server-exited', message: 'Exited' } } }),
    ).toBe('Exited');
  });
});

describe('schemaFieldsAt', () => {
  it('marks required fields, enums, refs and arrays, and finds nothing at an unknown path', () => {
    const fields = schemaFieldsAt(READ_FILE_SCHEMA, []);
    expect(fields[0]).toMatchObject({ name: 'path', type: 'string', comment: 'Where the file is.\n\nRequired.' });
    expect(fields[1]).toMatchObject({ name: 'encoding', valueKind: 'enum', enumValues: ['"utf-8"', '"base64"'] });
    expect(fields[2]).toMatchObject({ name: 'options', valueKind: 'message', repeated: false });
    expect(fields[3]).toMatchObject({ name: 'lines', valueKind: 'message', repeated: true });
    expect(schemaFieldsAt(READ_FILE_SCHEMA, ['lines']).map((field) => field.name)).toEqual(['from']);
    expect(schemaFieldsAt(READ_FILE_SCHEMA, ['missing'])).toEqual([]);
    expect(schemaFieldsAt({ $ref: '#/$defs/self', $defs: { self: { $ref: '#/$defs/self' } } }, [])).toEqual([]);
  });
});
