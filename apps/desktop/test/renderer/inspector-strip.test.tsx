import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InspectorPlaceholder,
  PaneTabs,
} from '../../src/renderer/features/request-editor/inspectors/inspector-strip.js';
import { useEditorsStore, type InspectorPane } from '../../src/renderer/state/editors.js';

const ITEMS = [
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'ssl', label: 'SSL' },
] as const;

function renderTabs(requestId = 'req-1', pane: InspectorPane = 'request'): void {
  render(
    <PaneTabs
      requestId={requestId}
      pane={pane}
      label="Request tabs"
      items={ITEMS}
      trailing={<span>status line</span>}
      render={(inspector) =>
        inspector === 'attachments' ? <InspectorPlaceholder name="Attachments" task={32} /> : <p>{inspector} body</p>
      }
    />,
  );
}

function panelText(pane: InspectorPane = 'request'): string | null {
  return screen.getByTestId(`inspector-panel-${pane}`).textContent;
}

describe('PaneTabs', () => {
  beforeEach(() => {
    useEditorsStore.setState({ inspectorTabs: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens on the Body tab, wherever it sits in the strip', () => {
    renderTabs();
    expect(panelText()).toBe('body body');
    expect(screen.getByRole('tab', { name: 'Body' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Headers' }).getAttribute('aria-selected')).toBe('false');
  });

  it('puts the strip above the content it controls', () => {
    renderTabs();
    const strip = screen.getByRole('tablist', { name: 'Request tabs' });
    const panel = screen.getByTestId('inspector-panel-request');
    expect(strip.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the clicked tab in place of the body', async () => {
    renderTabs();
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));

    expect(panelText()).toBe('ssl body');
    expect(screen.getByRole('tab', { name: 'SSL' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps a tab open when it is clicked a second time', async () => {
    renderTabs();
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));

    expect(panelText()).toBe('headers body');
  });

  it('shows the trailing content beside the strip whichever tab is selected', async () => {
    renderTabs();
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));
    expect(screen.getByText('status line')).toBeDefined();
  });

  it('shows a placeholder naming the task an inspector is still waiting on', async () => {
    renderTabs();
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));

    expect(screen.getByText(/Attachments arrives in Task 32/i)).toBeDefined();
  });

  it('keeps the selection per request, so another request starts from Body', async () => {
    renderTabs('req-1');
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));
    cleanup();

    renderTabs('req-2');
    expect(panelText()).toBe('body body');
    cleanup();

    // …and coming back to the first request finds the pane exactly as it was left.
    renderTabs('req-1');
    expect(panelText()).toBe('ssl body');
  });

  it('keeps the selection per pane, so the two strips do not follow each other', async () => {
    renderTabs('req-1', 'request');
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));
    cleanup();

    renderTabs('req-1', 'response');
    expect(panelText('response')).toBe('body body');
    expect(useEditorsStore.getState().inspectorFor('req-1', 'request')).toBe('ssl');
    expect(useEditorsStore.getState().inspectorFor('req-1', 'response')).toBe('body');
  });

  it('comes back to Body when a view is picked from a command', () => {
    useEditorsStore.getState().setInspector('req-1', 'request', 'ssl');
    useEditorsStore.getState().setInspector('req-1', 'response', 'headers');
    useEditorsStore.getState().setRequestView('req-1', 'form');
    useEditorsStore.getState().setResponseView('req-1', 'raw');

    expect(useEditorsStore.getState().inspectorFor('req-1', 'request')).toBe('body');
    expect(useEditorsStore.getState().inspectorFor('req-1', 'response')).toBe('body');
  });
});
