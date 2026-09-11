import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { showToast } from '../../src/renderer/components/toast.js';
import { InterfaceEditor } from '../../src/renderer/features/interface-editor/interface-editor.js';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import {
  exportDefinition,
  generateDocumentation,
  updateDefinition,
} from '../../src/renderer/features/interface-editor/interface-actions.js';
import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { buildExplorerTree } from '../../src/renderer/features/explorer/tree-nodes.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeInterface } from '../mocks/exchange-fixtures.js';

const LOADED_AT = 1_700_000_000_000;

const DOCUMENTS = {
  documents: [{ location: 'https://example.test/calc.wsdl', kind: 'wsdl' as const, size: 120 }],
  loadedAt: LOADED_AT,
};

const PLAN = {
  newOperations: [{ bindingName: '{urn:x}VersionedBinding', operationName: 'Subtract' }],
  removedOperations: [{ bindingName: '{urn:x}VersionedBinding', operationName: 'Legacy' }],
  changedOperations: [
    { ref: { bindingName: '{urn:x}VersionedBinding', operationName: 'Echo' }, reason: 'input-schema' as const },
  ],
  endpointsAdded: ['http://example.invalid/alt'],
  endpointsRemoved: [],
};

/** One rendered checkbox, narrowed so `checked`/`disabled` can be asserted on. */
function checkbox(testId: string): HTMLInputElement {
  return screen.getByTestId<HTMLInputElement>(testId);
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  installWirebenchApi({
    definition: {
      documents: vi.fn().mockResolvedValue({ ok: true, value: DOCUMENTS }),
      documentText: vi.fn().mockResolvedValue({ ok: true, value: { text: '<wsdl/>' } }),
      schemaIndex: vi.fn().mockResolvedValue({ ok: true, value: { namespaces: [] } }),
      planUpdate: vi.fn().mockResolvedValue({ ok: true, value: PLAN }),
      ...overrides,
    },
  });
}

describe('definition actions', () => {
  beforeEach(() => {
    stubApi();
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface({ loadedAt: LOADED_AT, definitionUrl: 'https://example.test/v1.wsdl' }) },
      projectOf: { 'if-1': 'p1' },
    });
    useInterfaceEditorStore.setState({ tabs: {}, data: {}, selections: {}, sourceTargets: {}, dialogs: {} });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens the viewer and its Update Definition dialog from anywhere', () => {
    updateDefinition('if-1');
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['interface:if-1']);
    expect(useInterfaceEditorStore.getState().dialogFor('if-1')).toBe('update');
  });

  it('opens the viewer and its Generate Documentation dialog', () => {
    generateDocumentation('if-1');
    expect(useInterfaceEditorStore.getState().dialogFor('if-1')).toBe('docs');
  });

  it('mirrors all three actions onto the explorer actions, ignoring a missing selection', () => {
    explorerActions.updateDefinition('if-1');
    expect(useInterfaceEditorStore.getState().dialogFor('if-1')).toBe('update');
    explorerActions.generateDocs('if-1');
    expect(useInterfaceEditorStore.getState().dialogFor('if-1')).toBe('docs');
    explorerActions.updateDefinition(undefined);
    explorerActions.generateDocs(undefined);
    explorerActions.exportDefinition(undefined);
    expect(useInterfaceEditorStore.getState().dialogFor('if-1')).toBe('docs');
  });

  it('exports through main and says nothing when the picker was cancelled', async () => {
    const exportChannel = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true, files: [] } });
    stubApi({ export: exportChannel });
    await exportDefinition('if-1');
    expect(exportChannel).toHaveBeenCalledWith({ interfaceId: 'if-1' });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('reports what the export wrote', async () => {
    stubApi({
      export: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: false, dir: '/tmp/out', files: ['a.wsdl'] } }),
    });
    await exportDefinition('if-1');
    expect(showToast).toHaveBeenCalledWith('Exported 1 document to /tmp/out');
  });

  it('shows an export failure as a toast', async () => {
    stubApi({ export: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'no project' } }) });
    await exportDefinition('if-1');
    expect(showToast).toHaveBeenCalledWith('no project');
  });
});

describe('UpdateDefinitionDialog', () => {
  beforeEach(() => {
    stubApi();
    useProjectStore.setState({
      interfaces: { 'if-1': makeInterface({ loadedAt: LOADED_AT, definitionUrl: 'https://example.test/v1.wsdl' }) },
    });
    useInterfaceEditorStore.setState({ tabs: {}, data: {}, selections: {}, sourceTargets: {}, dialogs: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens from the Overview button, prefilled with the current definition URL', async () => {
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    expect(await screen.findByTestId('update-definition-url')).toHaveProperty('value', 'https://example.test/v1.wsdl');
  });

  it('previews the plan, listing new, removed and changed operations plus added endpoints', async () => {
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    await user.click(await screen.findByTestId('update-definition-plan'));

    expect((await screen.findByTestId('update-plan-new')).textContent).toContain('VersionedBinding.Subtract');
    expect(screen.getByTestId('update-plan-removed').textContent).toContain('VersionedBinding.Legacy');
    expect(screen.getByTestId('update-plan-changed').textContent).toContain('VersionedBinding.Echo — request schema');
    expect(screen.getByTestId('update-plan-endpoints-added').textContent).toContain('http://example.invalid/alt');
    expect(screen.getByTestId('update-plan-endpoints-removed').textContent).toContain('None');
  });

  it('shows a plan failure in place of a plan', async () => {
    stubApi({ planUpdate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'cannot fetch' } }) });
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    await user.click(await screen.findByTestId('update-definition-plan'));
    expect((await screen.findByTestId('update-definition-error')).textContent).toContain('cannot fetch');
    expect(screen.queryByTestId('update-definition-plan-preview')).toBeNull();
  });

  it('offers the update options with their defaults, and Update TestRequests disabled', async () => {
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    for (const key of ['createNewRequests', 'recreateRequests', 'keepExisting', 'keepSoapHeaders', 'createBackups']) {
      expect(checkbox(`update-option-${key}`).checked).toBe(true);
    }
    expect(checkbox('update-option-recreateOptional').checked).toBe(false);
    expect(checkbox('update-option-updateTestRequests').disabled).toBe(true);
  });

  it('applies with the ticked options and adopts the snapshot main sends back', async () => {
    const applyUpdate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        plan: PLAN,
        requestsCreated: ['r1'],
        requestsRecreated: ['r2'],
        requestsOrphaned: ['r3'],
        backups: [],
        project: {
          id: 'p1',
          name: 'P',
          dir: '/tmp/p',
          dirty: false,
          interfaces: [],
          requests: [],
          properties: {},
          environments: [],
          problems: [],
          settings: { cacheDefinitions: true, defaultTimeoutMs: 1000, prettyPrintResponses: true },
          keystores: [],
          wssOutgoing: [],
          wssIncoming: [],
        },
      },
    });
    stubApi({ applyUpdate });
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    await user.click(screen.getByTestId('update-option-recreateOptional'));
    await user.click(screen.getByTestId('update-definition-submit'));

    await waitFor(() => {
      expect(applyUpdate).toHaveBeenCalled();
    });
    expect(applyUpdate.mock.calls[0]?.[0]).toMatchObject({
      interfaceId: 'if-1',
      source: { kind: 'url', url: 'https://example.test/v1.wsdl' },
      options: { recreateOptional: true, updateTestRequests: false },
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Definition updated — 1 created, 1 recreated, 1 orphaned');
    });
    expect(useProjectStore.getState().projects['p1']?.id).toBe('p1');
  });

  it('refuses to plan with no source at all', async () => {
    useProjectStore.setState({ interfaces: { 'if-1': makeInterface({ loadedAt: LOADED_AT, definitionUrl: '' }) } });
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-update-definition'));
    await user.click(screen.getByTestId('update-definition-plan'));
    expect((await screen.findByTestId('update-definition-error')).textContent).toContain(
      'Enter a URL or choose a file',
    );
  });
});

describe('GenerateDocsDialog', () => {
  beforeEach(() => {
    stubApi();
    useProjectStore.setState({ interfaces: { 'if-1': makeInterface({ loadedAt: LOADED_AT }) } });
    useInterfaceEditorStore.setState({ tabs: {}, data: {}, selections: {}, sourceTargets: {}, dialogs: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks main for the chosen format and reports where the file landed', async () => {
    const generateDocs = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { cancelled: false, path: '/tmp/definition.md' } });
    stubApi({ generateDocs });
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-generate-docs'));
    await user.click(await screen.findByTestId('docs-format-markdown'));
    await user.click(screen.getByTestId('generate-docs-submit'));

    await waitFor(() => {
      expect(generateDocs).toHaveBeenCalledWith({ interfaceId: 'if-1', format: 'markdown' });
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Documentation written to /tmp/definition.md');
    });
  });

  it('keeps the dialog open and shows the failure when main cannot render', async () => {
    stubApi({ generateDocs: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'no definition' } }) });
    const user = userEvent.setup();
    render(<InterfaceEditor interfaceId="if-1" />);
    await user.click(await screen.findByTestId('interface-generate-docs'));
    await user.click(screen.getByTestId('generate-docs-submit'));
    expect((await screen.findByTestId('generate-docs-error')).textContent).toContain('no definition');
    expect(screen.queryByTestId('generate-docs-dialog')).not.toBeNull();
  });
});

describe('explorer tree — orphaned requests', () => {
  it('marks the row of a request whose operation the definition no longer has', () => {
    const summary = makeInterface({
      operations: [
        {
          name: 'Legacy',
          binding: '{urn:x}B',
          bindingLocal: 'B',
          soapVersion: '1.1',
          style: 'document',
          ports: [],
          inputMimeParts: [],
        },
      ],
    });
    const tree = buildExplorerTree([summary], [
      {
        id: 'r1',
        interfaceId: 'if-1',
        bindingName: '{urn:x}B',
        operationName: 'Legacy',
        name: 'Request 1',
        orphaned: true,
      },
      {
        id: 'r2',
        interfaceId: 'if-1',
        bindingName: '{urn:x}B',
        operationName: 'Legacy',
        name: 'Request 2',
      },
    ] as never);
    const requests = tree[0]?.children?.[1]?.children?.[0]?.children ?? [];
    expect(requests.map((node) => node.orphaned)).toEqual([true, undefined]);
  });
});
