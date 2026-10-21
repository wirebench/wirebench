import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PropertiesInspector } from '../../src/renderer/features/request-editor/inspectors/properties-inspector.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import {
  AttachmentFlagsGroup,
  WssDefaultsGroup,
} from '../../src/renderer/features/request-editor/inspectors/request-flag-groups.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';

const request: RequestDraft = {
  attachments: [],
  assertions: [],
  id: 'req-1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  slug: 'Request 1',
  operationSlug: 'Add',
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

describe('PropertiesInspector', () => {
  beforeEach(() => {
    installWirebenchApi();
    seed();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders every §6.3 group', () => {
    render(<PropertiesInspector requestId="req-1" />);
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
      'SSL Keystore',
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it('leaves out what other tabs edit, and shows the Details facts read-only (#732 X08, #731 X21)', () => {
    render(<PropertiesInspector requestId="req-1" />);
    for (const label of ['Request name', 'Endpoint URL', 'WS-Addressing', 'Enable MTOM', 'WSS password type']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.getByText('This request')).toBeTruthy();
    expect(screen.getByText('http://example.test/soap')).toBeTruthy();
    expect(screen.getByText('Add')).toBeTruthy();
  });

  it('gives every remaining row a line of help', () => {
    render(<PropertiesInspector requestId="req-1" />);
    for (const label of ['Encoding', 'Follow redirects', 'Entitize properties', 'Remove empty content']) {
      expect(screen.getByText(label).getAttribute('title') ?? '').not.toBe('');
    }
  });

  it('commits a numeric edit on Enter, not on every keystroke', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: '100' } });
    expect(patch).not.toHaveBeenCalled();

    fireEvent.keyDown(timeout, { key: 'Enter' });
    expect(patch).toHaveBeenCalledWith('req-1', { timeoutMs: 100 });
  });

  it('commits a text edit on blur', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const address = screen.getByLabelText('Bind address');
    fireEvent.change(address, { target: { value: '127.0.0.1' } });
    fireEvent.blur(address);
    expect(patch).toHaveBeenCalledWith('req-1', { bindAddress: '127.0.0.1' });
  });

  it('selects a client keystore from the project registry, and keeps a missing ref selectable', () => {
    const patch = vi.fn();
    useProjectStore.setState({
      updateRequestProperties: patch,
      keystores: [{ id: 'k1', name: 'corp', path: '/tmp/corp.p12', type: 'pkcs12', projectId: 'p1' }],
    });
    render(<PropertiesInspector requestId="req-1" />);

    const select = screen.getByLabelText<HTMLSelectElement>('SSL Keystore');
    expect([...select.options].map((option) => option.textContent)).toEqual(['—', 'corp']);

    fireEvent.change(select, { target: { value: 'k1' } });
    expect(patch).toHaveBeenCalledWith('req-1', { sslKeystoreRef: 'k1' });

    fireEvent.change(select, { target: { value: '' } });
    expect(patch).toHaveBeenCalledWith('req-1', { sslKeystoreRef: null });
  });

  it('keeps a keystore ref the registry no longer has visible rather than snapping to none', () => {
    useProjectStore.setState({ updateRequestProperties: vi.fn(), keystores: [] });
    seed({ properties: { ...request.properties, sslKeystoreRef: 'ghost' } });
    render(<PropertiesInspector requestId="req-1" />);

    const select = screen.getByLabelText<HTMLSelectElement>('SSL Keystore');
    expect(select.value).toBe('ghost');
    expect([...select.options].map((option) => option.textContent)).toContain('ghost (missing)');
  });

  it('offers a closed set of encodings, including ISO-8859-1, and commits immediately', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const encoding = screen.getByLabelText<HTMLSelectElement>('Encoding');
    expect(encoding.value).toBe('UTF-8');
    const values = Array.from(encoding.options).map((option) => option.value);
    expect(values).toContain('ISO-8859-1');

    fireEvent.change(encoding, { target: { value: 'ISO-8859-1' } });
    expect(patch).toHaveBeenCalledWith('req-1', { encoding: 'ISO-8859-1' });
  });

  it('still shows an unrecognised encoding from a hand-edited project file', () => {
    seed({ properties: { ...REQUEST_PROPERTIES, encoding: 'Shift_JIS' } });
    render(<PropertiesInspector requestId="req-1" />);

    expect(screen.getByLabelText<HTMLSelectElement>('Encoding').value).toBe('Shift_JIS');
  });

  it('clears the SSL Keystore back to "none" when emptied', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, sslKeystoreRef: 'client-ks' } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const field = screen.getByLabelText('SSL Keystore');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(patch).toHaveBeenCalledWith('req-1', { sslKeystoreRef: null });
  });

  it('clears a numeric property back to "inherit" when the field is emptied', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, timeoutMs: 500 } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: '' } });
    fireEvent.blur(timeout);
    expect(patch).toHaveBeenCalledWith('req-1', { timeoutMs: null });
  });

  it('rejects a non-numeric timeout instead of persisting NaN', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    const timeout = screen.getByLabelText('Timeout (ms)');
    fireEvent.change(timeout, { target: { value: 'soon' } });
    fireEvent.blur(timeout);
    expect(patch).not.toHaveBeenCalled();
    expect((timeout as HTMLInputElement).value).toBe('');
  });

  it('commits a checkbox immediately', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<PropertiesInspector requestId="req-1" />);

    fireEvent.click(screen.getByLabelText('Pretty print'));
    expect(patch).toHaveBeenCalledWith('req-1', { prettyPrint: true });
  });

  it('stores the attachment flags, under Attachments, and explains each one on its label', () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<AttachmentFlagsGroup requestId="req-1" />);

    fireEvent.click(screen.getByLabelText('Enable MTOM'));
    expect(patch).toHaveBeenCalledWith('req-1', { enableMtom: true });
    expect(screen.getByText('Enable MTOM').getAttribute('title')).toMatch(/MTOM\/XOP parts/);
    expect(screen.getByText('Disable multiparts').getAttribute('title')).toMatch(/Never send a multipart body/);
  });

  it('maps the WSS password type through, and clears it with None', () => {
    const patch = vi.fn();
    seed({ properties: { ...REQUEST_PROPERTIES, wssPasswordType: 'digest' } });
    useProjectStore.setState({ updateRequestProperties: patch });
    render(<WssDefaultsGroup requestId="req-1" />);

    const select = screen.getByLabelText<HTMLSelectElement>('WSS password type');
    expect(select.value).toBe('digest');
    fireEvent.change(select, { target: { value: '' } });
    expect(patch).toHaveBeenCalledWith('req-1', { wssPasswordType: null });
  });

  it('writes the description as null when it is cleared', () => {
    const editRequest = vi.fn();
    seed({ description: 'old' });
    useProjectStore.setState({ editRequest });
    render(<PropertiesInspector requestId="req-1" />);

    const field = screen.getByLabelText('Description');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(editRequest).toHaveBeenCalledWith('req-1', { description: null });
  });

  it('fills the dump file from the Save-as picker', async () => {
    const patch = vi.fn();
    useProjectStore.setState({ updateRequestProperties: patch });
    const saveFile = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/out.xml' } });
    installWirebenchApi({ dialogs: { saveFile } });
    render(<PropertiesInspector requestId="req-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await vi.waitFor(() => {
      expect(patch).toHaveBeenCalledWith('req-1', { dumpFile: '/tmp/out.xml' });
    });
  });

  it('reports a request that is no longer in the project', () => {
    useProjectStore.setState({ requests: {} });
    render(<PropertiesInspector requestId="req-1" />);
    expect(screen.getByText(/no longer in the project/)).toBeTruthy();
  });
});
