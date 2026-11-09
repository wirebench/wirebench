/**
 * What a browser tab is not offered (#888): its host has no `processes`, `shell`, `files` or `dialogs`,
 * so the MCP stdio transport, the two browser OAuth grants and the file pickers give way to plain lines.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Capability } from '@wirebench/wire/capabilities';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import type { WirebenchApi } from '../../src/preload/build-api.js';
import { AuthFields, browserGrantRefused, oauth2GrantOptions } from '../../src/renderer/components/auth-fields.js';
import { transportOptions } from '../../src/renderer/features/mcp-api/connection-section.js';
import { NewMcpServerDialog, offeredTransports } from '../../src/renderer/features/mcp-api/new-server-dialog.js';
import { useNewMcpServerDialog } from '../../src/renderer/features/mcp-api/new-server-dialog-state.js';
import { BinaryBody } from '../../src/renderer/features/rest-editor/body-tab.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** What the server's hello frame lists: a public send and nothing of a machine. */
const BROWSER: readonly Capability[] = ['send:public'];

function install(capabilities?: readonly Capability[]): WirebenchApi {
  const api = installWirebenchApi();
  if (capabilities !== undefined) {
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities },
    });
  }
  return api;
}

afterEach(() => {
  cleanup();
  useNewMcpServerDialog.getState().close();
});

describe('the MCP transports by capability', () => {
  it('offers stdio first on the desktop', () => {
    install();
    expect(offeredTransports().map((transport) => transport.type)).toEqual(['stdio', 'http', 'sse']);
    expect(transportOptions('http').map((option) => option.value)).toEqual(['stdio', 'http', 'sse']);
  });

  it('leaves stdio out without processes, unless a server already uses it', () => {
    install(BROWSER);
    expect(offeredTransports().map((transport) => transport.type)).toEqual(['http', 'sse']);
    expect(transportOptions('http').map((option) => option.value)).toEqual(['http', 'sse']);
    expect(transportOptions('stdio').map((option) => option.value)).toEqual(['stdio', 'http', 'sse']);
  });

  it('opens the dialog on Streamable HTTP, with no word of this machine', () => {
    install(BROWSER);
    useNewMcpServerDialog.getState().open('p1', 'MCP server 1');
    render(<NewMcpServerDialog />);

    expect(screen.queryByTestId('new-mcp-server-transport-stdio')).toBeNull();
    expect(screen.getByTestId('new-mcp-server-transport-http')).toHaveProperty('checked', true);
    expect(screen.getByTestId('new-mcp-server-url')).toBeTruthy();
    expect(screen.getByTestId('new-mcp-server-dialog').textContent).not.toContain('this machine');
  });
});

describe('the OAuth 2 grants by capability', () => {
  it('offers all four grants on the desktop', () => {
    install();
    expect(oauth2GrantOptions(undefined).map((option) => option.value)).toEqual([
      'client-credentials',
      'authorization-code',
      'password',
      'device-code',
    ]);
    expect(browserGrantRefused('authorization-code')).toBe(false);
  });

  it('leaves the browser grants out without shell, but keeps one a request uses and says why', () => {
    install(BROWSER);
    expect(oauth2GrantOptions('client-credentials').map((option) => option.value)).toEqual([
      'client-credentials',
      'password',
    ]);
    expect(oauth2GrantOptions('device-code').map((option) => option.value)).toEqual([
      'client-credentials',
      'password',
      'device-code',
    ]);

    render(<AuthFields scope="Request" auth={{ type: 'oauth2', grant: 'authorization-code' }} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Request oauth2 grant')).toHaveProperty('value', 'authorization-code');
    expect(screen.getByTestId('Request-oauth2-grant-refused').textContent).toContain('desktop app');
  });

  it('says nothing about a grant that works here', () => {
    install(BROWSER);
    render(<AuthFields scope="Request" auth={{ type: 'oauth2', grant: 'client-credentials' }} onChange={vi.fn()} />);
    expect(screen.queryByTestId('Request-oauth2-grant-refused')).toBeNull();
  });
});

describe('the binary body by capability', () => {
  const body = { kind: 'binary', source: { kind: 'path', path: '' }, contentType: 'image/png' } as const;

  it('offers the picker on the desktop', () => {
    install();
    render(<BinaryBody body={body} onSet={vi.fn()} />);
    expect(screen.getByTestId('rest-binary-path').textContent).toBe('No file chosen.');
    expect(screen.getByTestId('rest-binary-choose')).toBeTruthy();
  });

  it('says files are attached in the desktop app without files', () => {
    install(BROWSER);
    render(<BinaryBody body={body} onSet={vi.fn()} />);
    expect(screen.getByTestId('rest-binary-path').textContent).toBe('Files are attached in the desktop app.');
    expect(screen.queryByTestId('rest-binary-choose')).toBeNull();
  });
});
