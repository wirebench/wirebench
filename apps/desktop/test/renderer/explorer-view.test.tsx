import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ExplorerView } from '../../src/renderer/features/explorer/explorer-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { InterfaceWire } from '../../src/shared/wire-types.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';

const summary: InterfaceWire = {
  id: 'iface-1',
  name: 'Calculator',
  slug: 'Calculator',
  cacheDefinition: true,
  hydration: 'ready',
  endpoints: [{ id: 'ep-1', name: 'Calculator CalculatorSoap', url: 'http://example.test/soap' }],
  defaultEndpointId: 'ep-1',
  definitionUrl: 'http://example.test/service.wsdl',
  targetNamespace: 'http://tempuri.org/',
  soapVersions: ['1.1'],
  services: [
    {
      name: 'Calculator',
      ports: [{ name: 'CalculatorSoap', address: 'http://example.test/soap', binding: '{tns}B', soapVersion: '1.1' }],
    },
  ],
  operations: [
    {
      name: 'Add',
      binding: '{tns}B',
      bindingLocal: 'B',
      soapVersion: '1.1',
      style: 'document',
      ports: [],
      inputMimeParts: [],
    },
  ],
  problems: [],
  documentCount: 1,
};

/** jsdom has no layout, so `ResizeObserver` never fires on its own; drive it manually. */
class ManualResizeObserver {
  static instances: ManualResizeObserver[] = [];
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ManualResizeObserver.instances.push(this);
  }
  observe(): void {
    this.callback([{ contentRect: { width: 300, height: 400 } }] as ResizeObserverEntry[], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

describe('ExplorerView', () => {
  beforeEach(() => {
    useProjectStore.setState({ interfaces: {}, requests: {}, order: [] });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    globalThis.ResizeObserver = ManualResizeObserver;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty state with no interfaces', () => {
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('No interfaces yet')).toBeTruthy();
  });

  it('renders the tree and opens an editor tab on double-click of a request', () => {
    useProjectStore.setState({
      interfaces: { [summary.id]: summary },
      order: [summary.id],
      requests: {
        'req-1': {
          properties: REQUEST_PROPERTIES,
          attachments: [],
          id: 'req-1',
          interfaceId: 'iface-1',
          bindingName: '{tns}B',
          operationName: 'Add',
          name: 'Request 1',
          envelopeXml: '<Envelope/>',
          soapVersion: '1.1',
          headers: [],
          order: 0,
        },
      },
    });

    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );

    expect(screen.getByText('Calculator')).toBeTruthy();
    expect(screen.getByText('Endpoints')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();

    const requestRow = screen.getByText('Request 1');

    // A single click only selects the node — it must not open an editor tab.
    fireEvent.click(requestRow);
    expect(useEditorsStore.getState().tabs).toHaveLength(0);

    fireEvent.doubleClick(requestRow);

    expect(useEditorsStore.getState().tabs).toHaveLength(1);
    expect(useEditorsStore.getState().tabs[0]?.requestId).toBe('req-1');
  });
});
