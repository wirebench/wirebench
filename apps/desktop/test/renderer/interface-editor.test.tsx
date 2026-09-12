import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { InterfaceEditor } from '../../src/renderer/features/interface-editor/interface-editor.js';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { showSchemaDeclaration } from '../../src/renderer/features/interface-editor/interface-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWsiStore } from '../../src/renderer/state/wsi.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeInterface } from '../mocks/exchange-fixtures.js';
import { revealedLines } from '../mocks/monaco-editor-react.js';

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

const LOADED_AT = 1_700_000_000_000;

const DOCUMENTS = {
  documents: [
    { location: 'https://example.test/calc.wsdl', kind: 'wsdl' as const, size: 120 },
    { location: 'https://example.test/types.xsd', kind: 'xsd' as const, size: 64 },
  ],
  loadedAt: LOADED_AT,
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

function stubDefinitionApi(documents: typeof DOCUMENTS = DOCUMENTS): void {
  installWirebenchApi({
    definition: {
      documents: vi.fn().mockResolvedValue({ ok: true, value: documents }),
      documentText: vi.fn().mockResolvedValue({ ok: true, value: { text: SCHEMA_XML } }),
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
          loadedAt: LOADED_AT,
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
    revealedLines.length = 0;
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
    // The WSDL Content tab reveals the line itself and then consumes the target, so stepping
    // Prev/Next away and back does not re-reveal a line the user has since left.
    await waitFor(() => {
      expect(revealedLines).toContain(2);
    });
    expect(useInterfaceEditorStore.getState().sourceTargetFor('if-1')).toBeUndefined();
  });

  it('go-to-definition opens the viewer on the Schema tab with the declaration selected', async () => {
    await showSchemaDeclaration({ interfaceId: 'if-1', envelopeXml: '<a/>', offset: 1 });

    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['interface:if-1']);
    expect(useInterfaceEditorStore.getState().tabFor('if-1')).toBe('schema');
    expect(useInterfaceEditorStore.getState().selectionFor('if-1')).toEqual({
      namespace: TEM,
      kind: 'element',
      name: 'intA',
      document: 'https://example.test/calc.wsdl',
      line: 5,
    });

    render(<InterfaceEditor interfaceId="if-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('schema-detail-name').textContent).toContain('intA');
    });
    await waitFor(() => {
      expect(screen.getByTestId('schema-detail-snippet').textContent).toContain('name="intA"');
    });
  });

  it('fetches each document text on demand rather than with the list', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'WSDL Content' }));

    const documentText = window.wirebench.definition.documentText as unknown as ReturnType<typeof vi.fn>;
    await waitFor(() => {
      expect(documentText).toHaveBeenCalledWith({ interfaceId: 'if-1', location: 'https://example.test/calc.wsdl' });
    });
    // Only the document on screen — the second one is fetched when it is selected.
    expect(documentText.mock.calls).toHaveLength(1);

    await userEvent.click(screen.getByTestId('wsdl-document-next'));
    await waitFor(() => {
      expect(documentText).toHaveBeenCalledWith({ interfaceId: 'if-1', location: 'https://example.test/types.xsd' });
    });
  });

  it('reloads the cached definition data when the interface is re-imported', async () => {
    const { unmount } = render(<InterfaceEditor interfaceId="if-1" />);
    await waitFor(() => {
      expect(useInterfaceEditorStore.getState().dataFor('if-1').status).toBe('ready');
    });
    unmount();

    // A re-import: main hands the project mirror a newer `loadedAt` for the same interface.
    const reimported = { ...DOCUMENTS, loadedAt: LOADED_AT + 1000 };
    stubDefinitionApi(reimported);
    useProjectStore.setState({
      interfaces: {
        'if-1': makeInterface({ loadedAt: LOADED_AT + 1000 }),
      },
    });

    render(<InterfaceEditor interfaceId="if-1" />);
    await waitFor(() => {
      expect(useInterfaceEditorStore.getState().dataFor('if-1').loadedAt).toBe(LOADED_AT + 1000);
    });
    expect(window.wirebench.definition.documents).toHaveBeenCalledTimes(1);
  });

  it('forgets cached data for an interface removed from the project', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await waitFor(() => {
      expect(useInterfaceEditorStore.getState().dataFor('if-1').status).toBe('ready');
    });

    useInterfaceEditorStore.getState().forget('if-1');

    expect(useInterfaceEditorStore.getState().dataFor('if-1')).toEqual({ status: 'idle' });
  });

  it('hosts the WS-I report with a Run button, and owns only its own report', async () => {
    useWsiStore.setState({ status: 'idle', report: undefined, subject: undefined });
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'WS-I' }));

    expect(screen.getByTestId('interface-wsi-run').textContent).toContain('Run WS-I check');
    expect(screen.getByTestId('interface-wsi-empty')).toBeDefined();

    // A report run for another interface must not be shown as this one's.
    act(() => {
      useWsiStore.setState({ status: 'ready', subject: { kind: 'wsdl', label: 'Other', interfaceId: 'if-2' } });
    });
    expect(screen.getByTestId('interface-wsi-empty')).toBeDefined();

    act(() => {
      useWsiStore.setState({ status: 'ready', subject: { kind: 'wsdl', label: 'Calculator', interfaceId: 'if-1' } });
    });
    expect(screen.getByTestId('interface-wsi-subject').textContent).toBe('Report for Calculator');
    expect(screen.queryByTestId('interface-wsi-empty')).toBeNull();
  });

  it('exposes the schema tree with an ARIA tree keyboard model', async () => {
    render(<InterfaceEditor interfaceId="if-1" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Schema' }));

    const tree = await screen.findByRole('tree', { name: 'Schema components' });
    const namespace = screen.getByTestId('schema-namespace');
    expect(namespace.getAttribute('role')).toBe('treeitem');
    expect(namespace.getAttribute('aria-expanded')).toBe('true');

    // Left on an expanded namespace collapses it, hiding every component below.
    namespace.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(namespace.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByTestId('schema-component')).toHaveLength(0);

    // Right reopens it; Down walks into the group and then onto the first element; Enter selects.
    await userEvent.keyboard('{ArrowRight}{ArrowDown}{ArrowDown}{Enter}');
    expect(tree).toBeDefined();
    await waitFor(() => {
      expect(useInterfaceEditorStore.getState().selectionFor('if-1')?.name).toBe('Add');
    });
  });

  it('edits the interface default Authentication on Overview', async () => {
    const mutate = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        value: {
          project: {
            id: 'p1',
            name: 'P',
            dir: '/tmp/p',
            dirty: false,
            interfaces: [makeInterface({ auth: { type: 'basic' } })],
            requests: [],
            properties: {},
            environments: [],
            problems: [],
            keystores: [],
            wssOutgoing: [],
            wssIncoming: [],
          },
        },
      }),
    );
    installWirebenchApi({ definition: window.wirebench.definition, project: { mutate } });
    useProjectStore.setState((state) => ({ projectOf: { ...state.projectOf, 'if-1': 'p1' } }));

    render(<InterfaceEditor interfaceId="if-1" />);

    await userEvent.selectOptions(screen.getByLabelText('Interface authentication type'), 'basic');

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'update-interface-auth', interfaceId: 'if-1', auth: { type: 'basic' } },
    });
  });

  it('edits the interface default WS-Addressing on Overview', async () => {
    const mutate = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        value: {
          project: {
            id: 'p1',
            name: 'P',
            dir: '/tmp/p',
            dirty: false,
            interfaces: [makeInterface({ wsaConfig: { enabled: true } })],
            requests: [],
            properties: {},
            environments: [],
            problems: [],
            keystores: [],
            wssOutgoing: [],
            wssIncoming: [],
          },
        },
      }),
    );
    installWirebenchApi({ definition: window.wirebench.definition, project: { mutate } });
    useProjectStore.setState((state) => ({ projectOf: { ...state.projectOf, 'if-1': 'p1' } }));

    render(<InterfaceEditor interfaceId="if-1" />);

    await userEvent.click(screen.getByTestId('interface-wsa-enabled'));

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'update-interface-wsa', interfaceId: 'if-1', wsa: { enabled: true } },
    });
  });
});
