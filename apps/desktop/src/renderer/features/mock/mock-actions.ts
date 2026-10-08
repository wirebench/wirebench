/**
 * Opening a mock's tab (#59). The id, `mock:<mockId>`, is fixed here because the explorer, the
 * persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one mock. */
export function mockTabId(mockId: string): string {
  return `mock:${mockId}`;
}

/** Opens (or focuses) the mock's tab. A mock the mirror does not hold is ignored. */
export function openMockTab(mockId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().mocks[mockId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: mockTabId(mockId), kind: 'mock', title, mockId });
}
