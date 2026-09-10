import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestProperties } from '../../src/renderer/features/details/request-properties.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';

const request: RequestDraft = {
  attachments: [],
  id: 'req-1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  envelopeXml: '<Envelope/>',
  soapVersion: '1.1',
  endpointUrl: 'http://example.test/soap',
  headers: [],
  order: 0,
  properties: REQUEST_PROPERTIES,
};

function seed(overrides: Partial<RequestDraft> = {}): void {
  useProjectStore.setState({ requests: { 'req-1': { ...request, ...overrides } } });
}

describe('RequestProperties', () => {
  beforeEach(() => {
    installWirebenchApi();
    seed();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders every §6.3 group', () => {
    render(<RequestProperties requestId="req-1" />);
    for (const label of [
      'Encoding',
      'Timeout (ms)',
      'Bind address',
      'Follow redirects',
      'Skip SOAP action',
      'Max size (bytes)',
      'Dump file',
      'Pretty print',
      'Strip whitespaces',
      'Remove empty content',
      'Entitize properties',
      'Enable MTOM',
      'Force MTOM',
      'Inline response attachments',
      'Expand MTOM attachments',
      'Disable multiparts',
      'Encode attachments',
      'Enable inline files',
      'WSS password type',
      'WSS time to live (s)',
      'SSL Keystore',
      'WS-Addressing',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('shows the resolved endpoint read-only', () => {
    render(<RequestProperties requestId="req-1" />);
    const field = screen.getByLabelText<HTMLInputElement>('Endpoint URL');
    expect(field.value).toBe('http://example.test/soap');
    expect(field.readOnly).toBe(true);
  });

  it('commits a numeric edit on Enter, not on every keystroke', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: '100' } });
    expect(patch).not.toHaveBeenCalled();

    fireEvent.keyDown(timeout, { key: 'Enter' });
    expect(patch).toHaveBeenCalledWith('req-1', { timeoutMs: 100 });
  });

  it('commits a text edit on blur', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const name = screen.getByLabelText('SSL Keystore');
    fireEvent.change(name, { target: { value: 'client-ks' } });
    fireEvent.blur(name);
    expect(patch).toHaveBeenCalledWith('req-1', { sslKeystoreRef: 'client-ks' });
  });

  it('offers a closed set of encodings, including ISO-8859-1, and commits immediately', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const encoding = screen.getByLabelText<HTMLSelectElement>('Encoding');
    expect(encoding.value).toBe('UTF-8');
    const values = Array.from(encoding.options).map((option) => option.value);
    expect(values).toContain('ISO-8859-1');

    fireEvent.change(encoding, { target: { value: 'ISO-8859-1' } });
    expect(patch).toHaveBeenCalledWith('req-1', { encoding: 'ISO-8859-1' });
  });

  it('still shows an unrecognised encoding from a hand-edited project file', () => {
    seed({ properties: { ...REQUEST_PROPERTIES, encoding: 'Shift_JIS' } });
    render(<RequestProperties requestId="req-1" />);

    expect(screen.getByLabelText<HTMLSelectElement>('Encoding').value).toBe('Shift_JIS');
  });

  it('clears the SSL Keystore back to "none" when emptied', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, sslKeystoreRef: 'client-ks' } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const field = screen.getByLabelText('SSL Keystore');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(patch).toHaveBeenCalledWith('req-1', { sslKeystoreRef: null });
  });

  it('reports WS-Addressing read-only, from request.wsa.enabled', () => {
    seed({ wsa: { enabled: true, version: '2005/08' } });
    render(<RequestProperties requestId="req-1" />);

    const field = screen.getByLabelText('WS-Addressing');
    expect(field.textContent).toBe('Enabled');
  });

  it('reports WS-Addressing as Disabled when the request has no wsa config', () => {
    render(<RequestProperties requestId="req-1" />);
    expect(screen.getByLabelText('WS-Addressing').textContent).toBe('Disabled');
  });

  it('clears a numeric property back to "inherit" when the field is emptied', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, timeoutMs: 500 } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: '' } });
    fireEvent.blur(timeout);
    expect(patch).toHaveBeenCalledWith('req-1', { timeoutMs: null });
  });

  it('rejects a non-numeric timeout instead of persisting NaN', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: 'soon' } });
    fireEvent.blur(timeout);
    expect(patch).not.toHaveBeenCalled();
    expect((timeout as HTMLInputElement).value).toBe('');
  });

  it('commits a checkbox immediately', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    fireEvent.click(screen.getByLabelText('Pretty print'));
    expect(patch).toHaveBeenCalledWith('req-1', { prettyPrint: true });
  });

  it('stores the attachment flags even though nothing acts on them yet', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    fireEvent.click(screen.getByLabelText('Enable MTOM'));
    expect(patch).toHaveBeenCalledWith('req-1', { enableMtom: true });
    expect(screen.getByText(/Task 32/)).toBeTruthy();
  });

  it('maps the WSS password type through, and clears it with None', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, wssPasswordType: 'digest' } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<RequestProperties requestId="req-1" />);

    const select = screen.getByLabelText<HTMLSelectElement>('WSS password type');
    expect(select.value).toBe('digest');
    fireEvent.change(select, { target: { value: '' } });
    expect(patch).toHaveBeenCalledWith('req-1', { wssPasswordType: null });
  });

  it('renames the request through update-request, ignoring an empty name', () => {
    const updateRequest = vi.fn();
    useProjectStore.setState({ updateRequest });
    render(<RequestProperties requestId="req-1" />);

    const name = screen.getByLabelText('Request name');
    fireEvent.change(name, { target: { value: '  ' } });
    fireEvent.blur(name);
    expect(updateRequest).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.blur(name);
    expect(updateRequest).toHaveBeenCalledWith('req-1', { name: 'Renamed' });
  });

  it('writes the description as null when it is cleared', () => {
    const updateRequest = vi.fn();
    seed({ description: 'old' });
    useProjectStore.setState({ updateRequest });
    render(<RequestProperties requestId="req-1" />);

    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(updateRequest).toHaveBeenCalledWith('req-1', { description: null });
  });

  it('fills the dump file from the Save-as picker', async () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    const saveFile = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/out.xml' } });
    installWirebenchApi({ dialogs: { saveFile } });
    render(<RequestProperties requestId="req-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await vi.waitFor(() => {
      expect(patch).toHaveBeenCalledWith('req-1', { dumpFile: '/tmp/out.xml' });
    });
  });

  it('reports a request that is no longer in the project', () => {
    useProjectStore.setState({ requests: {} });
    render(<RequestProperties requestId="req-1" />);
    expect(screen.getByText(/no longer in the project/)).toBeTruthy();
  });
});
