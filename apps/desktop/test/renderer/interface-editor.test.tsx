import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { InterfaceEditor } from '../../src/renderer/features/interface-editor/interface-editor.js';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { showSchemaDeclaration } from '../../src/renderer/features/interface-editor/interface-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeInterface } from '../mocks/exchange-fixtures.js';

const TEM = 'http://tempuri.org/';

const SCHEMA_XML = [
  '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://tempuri.org/">',
  '  <xs:element name="Add">',
  '    <xs:complexType>',
  '      <xs:sequence>',
  '        <xs:element name="intA" type="xs:int"/>',
  '      </xs:sequence>',
  '    </xs:complexType>',
  '  </xs:element>',
  '</xs:schema>',
].join('\n');

const DOCUMENTS = {
  documents: [
    { location: 'https://example.test/calc.wsdl', kind: 'wsdl' as const, size: 120, text: SCHEMA_XML },
    { location: 'https://example.test/types.xsd', kind: 'xsd' as const, size: 64, text: SCHEMA_XML },
  ],
  loadedAt: 1_700_000_000_000,
};

const SCHEMA_INDEX = {
  namespaces: [
    {
      uri: TEM,
      elements: [
        { name: 'Add', typeName: `{${TEM}}AddType`, document: 'https://example.test/calc.wsdl', line: 2 },
        { name: 'intA', document: 'https://example.test/calc.wsdl', line: 5 },
      ],
      complexTypes: [{ name: 'AddType', document: 'https://example.test/calc.wsdl', line: 3 }],
      simpleTypes: [],
      groups: [],
      attributeGroups: [],
    },
  ],
};

function stubDefinitionApi(): void {
  installWirebenchApi({
    definition: {
      documents: vi.fn().mockResolvedValue({ ok: true, value: DOCUMENTS }),
      schemaIndex: vi.fn().mockResolvedValue({ ok: true, value: SCHEMA_INDEX }),
      declarationAt: vi.fn().mockResolvedValue({
        ok: true,
        value: { namespace: TEM, name: 'intA', kind: 'element', document: 'https://example.test/calc.wsdl', line: 5 },
      }),
    },
  });
}

describe('InterfaceEditor', () => {
  beforeEach(() => {
    stubDefinitionApi();
    useProjectStore.setState({
      interfaces: {
        'if-1': makeInterface({
          operations: [
            {
              name: 'Add',
              binding: `{${TEM}}CalculatorSoap`,
              bindingLocal: 'CalculatorSoap',
              soapVersion: '1.1',
              style: 'document',
              ports: [],
              inputMimeParts: [],
            },
          ],
        }),
      },
    });
    useInterfaceEditorStore.setState({ tabs: {}, data: {}, selections: {}, sourceTargets: {} });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens on Overview and reports the operation, endpoint and document counts', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);

    expect(screen.getByTestId('interface-operation-count').textContent).toContain('1');
    expect(screen.getByTestId('interface-endpoint-count').textContent).toContain('2');
    await waitFor(() => {
      expect(screen.getByTestId('interface-document-count').textContent).toContain('2');
    });
  });

  it('lists the endpoints with their default badge and auth mode', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Endpoints' }));

    expect(screen.getAllByTestId('interface-endpoint-row')).toHaveLength(2);
    expect(screen.getAllByTestId('interface-endpoint-default')).toHaveLength(1);
  });

  it('lists every document in WSDL Content and steps through them', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'WSDL Content' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('wsdl-document-item')).toHaveLength(2);
    });
    expect(screen.getByTestId('wsdl-document-location').textContent).toContain('calc.wsdl');
    await userEvent.click(screen.getByTestId('wsdl-document-next'));
    expect(screen.getByTestId('wsdl-document-location').textContent).toContain('types.xsd');
  });

  it('shows a schema component declaration and goes to its source', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Schema' }));

    await waitFor(() => {
      expect(screen.getByTestId('schema-namespace').getAttribute('data-uri')).toBe(TEM);
    });
    const add = screen.getAllByTestId('schema-component').find((node) => node.dataset['name'] === 'Add');
    await userEvent.click(add as HTMLElement);

    expect(screen.getByTestId('schema-detail-name').textContent).toContain('Add');
    expect(screen.getByTestId('schema-detail-snippet').textContent).toContain('name="Add"');

    await userEvent.click(screen.getByTestId('schema-goto-source'));
    expect(useInterfaceEditorStore.getState().tabFor('if-1')).toBe('wsdl');
    expect(useInterfaceEditorStore.getState().sourceTargetFor('if-1')).toEqual({
      location: 'https://example.test/calc.wsdl',
      line: 2,
    });
  });

  it('go-to-definition opens the viewer on the Schema tab with the declaration selected', async () => {
    await showSchemaDeclaration({ interfaceId: 'if-1', envelopeXml: '<a/>', offset: 1 });

    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['interface:if-1']);
    expect(useInterfaceEditorStore.getState().tabFor('if-1')).toBe('schema');
    expect(useInterfaceEditorStore.getState().selectionFor('if-1')).toEqual({
      namespace: TEM,
      kind: 'element',
      name: 'intA',
    });

    render(<InterfaceEditor interfaceId="if-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('schema-detail-name').textContent).toContain('intA');
    });
    expect(screen.getByTestId('schema-detail-snippet').textContent).toContain('name="intA"');
  });

  it('hosts the WS-I report with a Run button', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'WS-I' }));

    expect(screen.getByTestId('interface-wsi-run').textContent).toContain('Run WS-I check');
  });
});
