import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DetailsInspector } from '../../src/renderer/features/request-editor/inspectors/details-inspector.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { InterfaceWire, ProjectWire } from '../../src/shared/wire-types.js';

const project = {
  id: 'p1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
} as unknown as ProjectWire;

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
  defaultEndpointId: 'ep-1',
  hydration: 'ready',
} as unknown as InterfaceWire;

function renderInspector(requestId = 'req-1'): void {
  render(<DetailsInspector requestId={requestId} />);
}

describe('DetailsInspector', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('says the request no longer exists when it is gone', () => {
    renderInspector();
    expect(screen.getByText('This request no longer exists.')).toBeTruthy();
  });

  it('shows the interface, operation, SOAPAction, resolved endpoint and project', () => {
    useProjectStore.setState({
      projects: { p1: project },
      interfaces: { 'iface-1': interfaceWire },
      requests: { 'req-1': makeDraft({ interfaceId: 'iface-1', operationName: 'Add', soapAction: 'urn:Add' }) },
      projectOf: { 'req-1': 'p1', 'iface-1': 'p1' },
    });

    renderInspector();

    expect(screen.getByTestId('request-details-inspector')).toBeTruthy();
    expect(screen.getByLabelText('Interface').textContent).toBe('Calculator');
    expect(screen.getByLabelText('Operation').textContent).toBe('Add');
    expect(screen.getByLabelText('SOAPAction').textContent).toBe('urn:Add');
    // No environment is active and the request names an endpoint of its own — the interface's
    // declared address wins, exactly as `selectRequestEndpoint` resolves it.
    expect(screen.getByLabelText('Endpoint').textContent).toBe('http://example.test/soap');
    expect(screen.getByLabelText('Endpoint source').textContent).toBe("this request's chosen endpoint");
    expect(screen.getByLabelText('Project').textContent).toBe('Demo');
  });

  it('reports an endpoint override by the active workspace environment', () => {
    useProjectStore.setState({
      projects: { p1: project },
      interfaces: { 'iface-1': interfaceWire },
      requests: { 'req-1': makeDraft({ interfaceId: 'iface-1' }) },
      projectOf: { 'req-1': 'p1', 'iface-1': 'p1' },
    });
    useWorkspaceStore.setState({
      workspace: {
        id: 'w1',
        name: 'Workspace',
        dir: '/tmp/w1',
        properties: {},
        disabled: [],
        environments: [
          {
            id: 'env-1',
            name: 'dev',
            slug: 'dev',
            order: 0,
            properties: {},
            endpoints: { 'Demo/Calculator': 'http://dev.example.test/soap' },
            disabled: [],
          },
        ],
        activeEnvironmentId: 'env-1',
        projects: [{ id: 'p1', name: 'Demo', slug: 'Demo', source: 'internal', dir: '/tmp/demo', status: 'ready' }],
      },
    } as never);

    renderInspector();

    expect(screen.getByLabelText('Endpoint').textContent).toBe('http://dev.example.test/soap');
    expect(screen.getByLabelText('Endpoint source').textContent).toBe('the active workspace environment');
  });
});
