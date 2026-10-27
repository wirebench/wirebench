/**
 * The MCP response pane (#79): the status line for each outcome, the result's content blocks by
 * type, the list tables, the warnings, and the messages timeline with its HTTP or stderr panel.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { McpResponsePane } from '../../src/renderer/features/mcp-editor/response/response-pane.js';
import { McpResultView, imageDataUrl } from '../../src/renderer/features/mcp-editor/response/result-view.js';
import { McpMessagesView, messageOffset } from '../../src/renderer/features/mcp-editor/response/messages-view.js';
import { stderrTail } from '../../src/renderer/features/mcp-editor/response/status-line.js';
import type { McpExchangeSummary, McpMessageWire } from '@wirebench/wire/kinds/mcp/wire';

afterEach(() => {
  cleanup();
});

const STARTED = '2026-10-14T10:00:00.000Z';

function message(patch: Partial<McpMessageWire> = {}): McpMessageWire {
  return {
    direction: 'sent',
    at: '2026-10-14T10:00:00.012Z',
    size: 64,
    kind: 'request',
    id: 2,
    method: 'tools/call',
    text: '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo"}}',
    warnings: [],
    ...patch,
  };
}

function exchange(patch: Partial<McpExchangeSummary> = {}): McpExchangeSummary {
  return {
    sendId: 's1',
    transport: { type: 'stdio', command: 'node', args: ['server.js'], cwd: '/p', env: {} },
    method: 'tools/call',
    startedAt: STARTED,
    durationMs: 42,
    messages: [message(), message({ direction: 'received', kind: 'result', method: undefined, text: '{"id":2}' })],
    droppedMessages: 0,
    result: { content: [{ type: 'text', text: 'hello' }] },
    warnings: [],
    ...patch,
  };
}

const done = (patch: Partial<McpExchangeSummary> = {}) => ({ status: 'done' as const, exchange: exchange(patch) });

describe('McpResponsePane — the status line', () => {
  it('reads OK with the duration and the message count', () => {
    render(<McpResponsePane state={done()} />);
    expect(screen.getByTestId('mcp-response-outcome').textContent).toBe('OK');
    expect(screen.getByTestId('mcp-response-status').textContent).toContain('42 ms');
    expect(screen.getByTestId('mcp-response-status').textContent).toContain('2 messages');
    expect(screen.queryByTestId('mcp-response-warnings-count')).toBeNull();
  });

  it('reads a tool error', () => {
    render(<McpResponsePane state={done({ result: { isError: true, content: [{ type: 'text', text: 'no' }] } })} />);
    expect(screen.getByTestId('mcp-response-outcome').textContent).toBe('Tool error (isError)');
    expect(screen.getByTestId('mcp-result').textContent).toContain('The tool reported an error');
  });

  it('reads a JSON-RPC error and shows its data', () => {
    render(
      <McpResponsePane
        state={done({ result: undefined, error: { code: -32602, message: 'Invalid params', data: { field: 'x' } } })}
      />,
    );
    expect(screen.getByTestId('mcp-response-outcome').textContent).toBe('Error -32602 Invalid params');
    expect(screen.getByTestId('mcp-result-error').textContent).toContain('"field": "x"');
  });

  it('reads a failure with its code and the tail of stderr', () => {
    render(
      <McpResponsePane
        state={done({
          result: undefined,
          failure: { code: 'mcp-server-exited', message: 'The server exited before it answered' },
          stderr: 'line 1\nline 2\nTypeError: boom\n',
          exitCode: 1,
        })}
      />,
    );
    expect(screen.getByTestId('mcp-response-outcome').textContent).toBe(
      'mcp-server-exited · The server exited before it answered',
    );
    expect(screen.getByTestId('mcp-response-stderr-tail').textContent).toContain('TypeError: boom');
  });

  it('shows the in-flight line with the live message count, and an IPC failure', () => {
    const { rerender } = render(
      <McpResponsePane state={{ status: 'sending', sendId: 's', live: { messages: [message()] } }} />,
    );
    expect(screen.getByTestId('mcp-response-status').textContent).toBe('Sending… · 1 message');
    fireEvent.click(screen.getByRole('tab', { name: /Messages/ }));
    expect(screen.getAllByTestId('mcp-message-row')).toHaveLength(1);

    rerender(
      <McpResponsePane state={{ status: 'error', error: { code: 'mcp-not-approved', message: 'Cancelled' } }} />,
    );
    expect(screen.getByTestId('mcp-response-status').textContent).toBe('mcp-not-approved · Cancelled');
  });

  it('asks for a send before there is one', () => {
    render(<McpResponsePane state={undefined} />);
    expect(screen.getByTestId('mcp-response').textContent).toContain('Send the request');
  });

  it('shows the catalogue warnings and counts them', () => {
    render(
      <McpResponsePane
        state={done({ warnings: ['arguments: must have required property "path"', 'structuredContent: bad'] })}
      />,
    );
    const warnings = screen.getByTestId('mcp-response-warnings');
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(2);
    expect(warnings.textContent).toContain('required property "path"');
    expect(screen.getByTestId('mcp-response-warnings-count').textContent).toBe('2 warnings');
  });
});

describe('McpResultView — content blocks', () => {
  it('shows text, and pretty-prints JSON text behind a toggle', () => {
    render(<McpResultView method="tools/call" result={{ content: [{ type: 'text', text: '{"a":1}' }] }} />);
    expect(screen.getByTestId('mcp-text-body').textContent).toBe('{\n  "a": 1\n}');
    fireEvent.click(screen.getByTestId('mcp-text-pretty'));
    expect(screen.getByTestId('mcp-text-body').textContent).toBe('{"a":1}');
  });

  it('offers no JSON toggle on plain text', () => {
    render(<McpResultView method="tools/call" result={{ content: [{ type: 'text', text: 'plain' }] }} />);
    expect(screen.getByTestId('mcp-text-body').textContent).toBe('plain');
    expect(screen.queryByTestId('mcp-text-pretty')).toBeNull();
  });

  it('draws an image from its base64 and refuses a bad type', () => {
    render(
      <McpResultView
        method="tools/call"
        result={{
          content: [
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            { type: 'image', mimeType: 'text/html', data: 'PGI+' },
          ],
        }}
      />,
    );
    const [good, bad] = screen.getAllByTestId('mcp-block-image');
    expect(good?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(bad?.querySelector('img')).toBeNull();
    expect(imageDataUrl('image/png', 'not base64!')).toBeUndefined();
  });

  it('labels audio with its type and size and no player', () => {
    render(
      <McpResultView
        method="tools/call"
        result={{ content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] }}
      />,
    );
    const block = screen.getByTestId('mcp-block-audio');
    expect(block.textContent).toContain('audio/wav');
    expect(block.textContent).toContain('3 B');
    expect(block.querySelector('audio')).toBeNull();
  });

  it('shows a resource link and an embedded resource', () => {
    render(
      <McpResultView
        method="tools/call"
        result={{
          content: [
            { type: 'resource_link', uri: 'file:///a.txt', name: 'a', mimeType: 'text/plain' },
            { type: 'resource', resource: { uri: 'file:///b.txt', mimeType: 'text/plain', text: 'bee' } },
            { type: 'resource', resource: { uri: 'file:///c.bin', blob: 'AAAAAA==' } },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('mcp-block-resource_link').textContent).toContain('file:///a.txt');
    const [text, blob] = screen.getAllByTestId('mcp-block-resource');
    expect(text?.textContent).toContain('bee');
    expect(blob?.textContent).toContain('4 B');
  });

  it('shows structuredContent as pretty JSON, and an unknown block as JSON', () => {
    render(
      <McpResultView
        method="tools/call"
        result={{ content: [{ type: 'hologram', depth: 3 }], structuredContent: { temperature: 21 } }}
      />,
    );
    expect(screen.getByTestId('mcp-structured-content').textContent).toBe('{\n  "temperature": 21\n}');
    expect(screen.getByTestId('mcp-block-unknown').textContent).toContain('"depth": 3');
  });

  it('tables a list result and shows the next cursor', () => {
    render(
      <McpResultView
        method="tools/list"
        result={{ tools: [{ name: 'echo', description: 'Says it back', inputSchema: {} }], nextCursor: 'c2' }}
      />,
    );
    const table = screen.getByTestId('mcp-result-table');
    expect(within(table).getByText('echo')).not.toBeNull();
    expect(within(table).getByText('Says it back')).not.toBeNull();
    expect(screen.getByTestId('mcp-result').textContent).toContain('nextCursor c2');
  });

  it('shows a read resource and a prompt’s messages', () => {
    const { unmount } = render(
      <McpResultView method="resources/read" result={{ contents: [{ uri: 'mem://x', text: 'contents' }] }} />,
    );
    expect(screen.getByTestId('mcp-block-resource').textContent).toContain('mem://x');
    unmount();
    render(
      <McpResultView
        method="prompts/get"
        result={{ messages: [{ role: 'user', content: { type: 'text', text: 'Write a haiku' } }] }}
      />,
    );
    expect(screen.getByTestId('mcp-prompt-message').textContent).toContain('user');
    expect(screen.getByTestId('mcp-text-body').textContent).toBe('Write a haiku');
  });

  it('falls back to JSON for a result it does not recognise', () => {
    render(<McpResultView method="tools/call" result={{ odd: true }} />);
    expect(screen.getByTestId('mcp-result-json').textContent).toContain('"odd": true');
  });
});

describe('McpMessagesView', () => {
  const messages = [
    message(),
    message({
      direction: 'received',
      at: '2026-10-14T10:00:00.050Z',
      kind: 'result',
      method: undefined,
      text: '{"jsonrpc":"2.0","id":2,"result":{}}',
      warnings: ['structuredContent: does not match outputSchema'],
    }),
  ];

  it('lists the messages both ways and opens the selected one’s JSON', () => {
    render(<McpMessagesView messages={messages} startedAt={STARTED} transport="stdio" />);
    const rows = screen.getAllByTestId('mcp-message-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('+12 ms');
    expect(rows[0]?.textContent).toContain('tools/call');
    expect(within(rows[0]!).getByRole('img', { name: 'Sent' })).not.toBeNull();
    expect(rows[1]?.textContent).toContain('#2 result');
    expect(within(rows[1]!).getByTestId('mcp-message-warnings').textContent).toBe('1');
    expect(screen.queryByTestId('mcp-message-detail')).toBeNull();

    fireEvent.click(rows[1]!);
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
    const detail = screen.getByTestId('mcp-message-detail');
    expect(detail.textContent).toContain('"result": {}');
    expect(detail.textContent).toContain('does not match outputSchema');

    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Messages' }), { key: 'ArrowUp' });
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('says when a message’s text was not kept', () => {
    render(
      <McpMessagesView
        messages={[message({ text: '', payloadTruncated: true })]}
        startedAt={STARTED}
        transport="http"
      />,
    );
    fireEvent.click(screen.getByTestId('mcp-message-row'));
    expect(screen.getByTestId('mcp-message-detail').textContent).toContain('was not kept');
  });

  it('shows stderr and the exit code beside a stdio session', () => {
    render(
      <McpMessagesView messages={messages} startedAt={STARTED} transport="stdio" stderr="starting up\n" exitCode={0} />,
    );
    const panel = screen.getByTestId('mcp-stderr');
    expect(panel.textContent).toContain('starting up');
    expect(panel.textContent).toContain('Exit code 0');
    expect(screen.queryByTestId('mcp-http-calls')).toBeNull();
  });

  it('shows the HTTP calls beside an HTTP session', () => {
    render(
      <McpMessagesView
        messages={messages}
        startedAt={STARTED}
        transport="http"
        httpCalls={[
          {
            method: 'POST',
            url: 'https://mcp.example.test/mcp',
            startedAt: STARTED,
            status: 200,
            requestHeaders: {},
            responseHeaders: {},
            timings: { startedAt: STARTED, totalMs: 31 },
          },
          {
            method: 'DELETE',
            url: 'https://mcp.example.test/mcp',
            startedAt: STARTED,
            status: 0,
            requestHeaders: {},
            responseHeaders: {},
            error: 'socket hang up',
          },
        ]}
      />,
    );
    const calls = screen.getAllByTestId('mcp-http-call');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.textContent).toContain('POST');
    expect(calls[0]?.textContent).toContain('200');
    expect(calls[0]?.textContent).toContain('31 ms');
    expect(calls[1]?.textContent).toContain('socket hang up');
    expect(screen.queryByTestId('mcp-stderr')).toBeNull();
  });
});

describe('helpers', () => {
  it('words a message’s offset and stderr’s tail', () => {
    expect(messageOffset(STARTED, '2026-10-14T10:00:01.250Z')).toBe('+1250 ms');
    expect(messageOffset('bad', STARTED)).toBe('—');
    expect(stderrTail('a\n\nb\nc\n', 2)).toBe('b\nc');
    expect(stderrTail(undefined)).toBe('');
  });
});
