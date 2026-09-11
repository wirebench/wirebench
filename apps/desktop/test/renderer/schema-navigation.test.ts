import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { goToSchemaDefinition } from '../../src/renderer/features/request-editor/schema-navigation.js';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeInterface } from '../mocks/exchange-fixtures.js';

const TEM = 'http://tempuri.org/';
const ENVELOPE = '<Envelope><Body><Add><intA>1</intA></Add></Body></Envelope>';

/** The two Monaco methods `goToSchemaDefinition` actually uses. */
function fakeEditor(text: string, offset: number): never | object {
  return {
    getModel: () => ({ getValue: () => text, getOffsetAt: () => offset }),
    getPosition: () => ({ lineNumber: 1, column: offset + 1 }),
  };
}

describe('goToSchemaDefinition', () => {
  beforeEach(() => {
    useProjectStore.setState({ interfaces: { 'if-1': makeInterface() } });
    useInterfaceEditorStore.setState({ tabs: {}, data: {}, selections: {}, sourceTargets: {} });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the interface viewer on the declaration under the caret', async () => {
    const declarationAt = vi.fn().mockResolvedValue({
      ok: true,
      value: { namespace: TEM, name: 'intA', kind: 'element', document: 'calc.wsdl', line: 5 },
    });
    installWirebenchApi({ definition: { declarationAt } });

    await goToSchemaDefinition(fakeEditor(ENVELOPE, 25) as Parameters<typeof goToSchemaDefinition>[0], 'if-1');

    expect(declarationAt).toHaveBeenCalledWith({ interfaceId: 'if-1', envelopeXml: ENVELOPE, offset: 25 });
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['interface:if-1']);
    expect(useInterfaceEditorStore.getState().selectionFor('if-1')).toEqual({
      namespace: TEM,
      kind: 'element',
      name: 'intA',
    });
  });

  it('does nothing without an interface or an editor', async () => {
    const declarationAt = vi.fn();
    installWirebenchApi({ definition: { declarationAt } });

    await goToSchemaDefinition(undefined, 'if-1');
    await goToSchemaDefinition(fakeEditor(ENVELOPE, 1) as Parameters<typeof goToSchemaDefinition>[0], undefined);

    expect(declarationAt).not.toHaveBeenCalled();
    expect(useEditorsStore.getState().tabs).toHaveLength(0);
  });

  it('leaves the viewer closed when nothing resolves', async () => {
    installWirebenchApi({ definition: { declarationAt: vi.fn().mockResolvedValue({ ok: true, value: null }) } });

    await goToSchemaDefinition(fakeEditor(ENVELOPE, 3) as Parameters<typeof goToSchemaDefinition>[0], 'if-1');

    expect(useEditorsStore.getState().tabs).toHaveLength(0);
  });
});
