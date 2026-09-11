import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { DetailsPanel } from '../../src/renderer/shell/details-panel.js';
import { useGlobalsStore } from '../../src/renderer/state/globals.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { InterfaceWire, ProjectWire } from '../../src/shared/wire-types.js';

const project = {
  id: 'p1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: { host: 'example.test' },
  environments: [],
  problems: [],
} as unknown as ProjectWire;

const requestDraft = {
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
} as RequestDraft;

const interfaceWire = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'Calculator',
  definitionUrl: 'http://example.test/service?wsdl',
  cacheDefinition: true,
  soapVersions: ['1.1'],
  services: [],
  operations: [],
  documentCount: 1,
  problems: [],
  endpoints: [{ id: 'ep-1', name: 'Calculator Soap', url: 'http://example.test/soap' }],
  hydration: 'ready',
} as unknown as InterfaceWire;

function renderPanel() {
  render(
    <TooltipPrimitive.Provider>
      <DetailsPanel />
    </TooltipPrimitive.Provider>,
  );
}

describe('DetailsPanel', () => {
  beforeEach(() => {
    // The active tab now lives in the store, so one test switching tabs must not leak into
    // the next; reset the persisted half of the ui state alongside the selection.
    useUiStore.setState({ ...structuredClone(DEFAULT_UI_STATE), selection: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useProjectStore.getState().reset();
    useGlobalsStore.setState({ properties: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('says nothing is selected by default', () => {
    renderPanel();
    expect(screen.getByText('Nothing selected')).toBeDefined();
  });

  it('edits the project properties when the Project row is selected', async () => {
    const setProjectProperty = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ projects: { p1: project }, setProjectProperty });
    useUiStore.setState({ selection: { kind: 'project', id: 'p1' } });
    renderPanel();

    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('example.test');

    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: '8080' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    await waitFor(() => {
      expect(setProjectProperty).toHaveBeenCalledWith('p1', 'port', '8080');
    });
  });

  it('edits global properties from its own tab, with no project open', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    useGlobalsStore.setState({ properties: { token: 'abc' }, set });
    renderPanel();

    fireEvent.click(screen.getByRole('tab', { name: 'Global properties' }));
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');

    const value = screen.getByLabelText('Value of token');
    fireEvent.change(value, { target: { value: 'xyz' } });
    fireEvent.blur(value);
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith('token', 'xyz');
    });
  });

  it("shows the selected request's property grid", () => {
    useProjectStore.setState({ requests: { 'req-1': requestDraft } });
    useUiStore.setState({ selection: { kind: 'request', id: 'req:req-1', requestId: 'req-1' } });
    renderPanel();
    expect(screen.getByTestId('request-properties')).toBeTruthy();
  });

  /**
   * Opening a request and looking right should show that request, not "Nothing selected" —
   * the explorer selection is one way in, the active editor tab is the other.
   */
  it('follows the active request tab when the explorer has no selection', () => {
    useProjectStore.setState({ requests: { 'req-1': requestDraft } });
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
    });
    renderPanel();
    expect(screen.getByTestId('request-properties')).toBeTruthy();
  });

  it('lets an explicit selection win over the active tab', () => {
    useProjectStore.setState({
      requests: { 'req-1': requestDraft },
      interfaces: { 'iface-1': interfaceWire },
    });
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
    });
    useUiStore.setState({ selection: { kind: 'interface', id: 'iface:iface-1', interfaceId: 'iface-1' } });
    renderPanel();
    expect(screen.getByTestId('interface-properties')).toBeTruthy();
    expect(screen.queryByTestId('request-properties')).toBeNull();
  });

  it('opens on the Code tab when the ui store says so', async () => {
    installWirebenchApi({
      request: { curl: vi.fn().mockResolvedValue({ ok: true, value: { command: 'curl --request POST' } }) },
    });
    useProjectStore.setState({ requests: { 'req-1': requestDraft } });
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
    });
    useUiStore.getState().showDetails('code');
    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('code-panel-preview').textContent).toBe('curl --request POST');
    });
  });

  it('shows an endpoint node as its saved project endpoint', () => {
    useProjectStore.setState({ interfaces: { 'iface-1': interfaceWire } });
    useUiStore.setState({
      selection: {
        kind: 'endpoint',
        id: 'endpoint:iface-1:S:P',
        interfaceId: 'iface-1',
        address: 'http://example.test/soap',
      },
    });
    renderPanel();
    expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe('http://example.test/soap');
  });
});
