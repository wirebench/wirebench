import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  InspectorPlaceholder,
  InspectorStrip,
} from '../../src/renderer/features/request-editor/inspectors/inspector-strip.js';
import { useEditorsStore, type InspectorPane } from '../../src/renderer/state/editors.js';

const ITEMS = [
  { id: 'headers', label: 'Headers' },
  { id: 'attachments', label: 'Attachments' },
  { id: 'ssl', label: 'SSL' },
] as const;

function renderStrip(requestId = 'req-1', pane: InspectorPane = 'request'): void {
  render(
    <InspectorStrip
      requestId={requestId}
      pane={pane}
      label="Request inspectors"
      items={ITEMS}
      render={(inspector) =>
        inspector === 'attachments' ? <InspectorPlaceholder name="Attachments" task={32} /> : <p>{inspector} body</p>
      }
    />,
  );
}

describe('InspectorStrip', () => {
  beforeEach(() => {
    useEditorsStore.setState({ inspectorTabs: {}, inspectorCollapsed: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts collapsed, so the editor keeps the whole pane', () => {
    renderStrip();
    expect(screen.queryByTestId('inspector-panel-request')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Headers' }).getAttribute('aria-selected')).toBe('false');
  });

  it('opens the panel on the tab that was clicked', async () => {
    renderStrip();
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));

    expect(screen.getByTestId('inspector-panel-request').textContent).toBe('ssl body');
    expect(screen.getByRole('tab', { name: 'SSL' }).getAttribute('aria-selected')).toBe('true');
  });

  it('collapses again when the open tab is clicked a second time', async () => {
    renderStrip();
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Headers' }));

    expect(screen.queryByTestId('inspector-panel-request')).toBeNull();
  });

  it('shows a placeholder naming the task an inspector is still waiting on', async () => {
    renderStrip();
    await userEvent.click(screen.getByRole('tab', { name: 'Attachments' }));

    expect(screen.getByText(/Attachments arrives in Task 32/i)).toBeDefined();
  });

  it('keeps the selection per request, so another request starts from the default', async () => {
    renderStrip('req-1');
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));
    cleanup();

    renderStrip('req-2');
    expect(screen.queryByTestId('inspector-panel-request')).toBeNull();
    cleanup();

    // …and coming back to the first request finds the strip exactly as it was left.
    renderStrip('req-1');
    expect(screen.getByTestId('inspector-panel-request').textContent).toBe('ssl body');
  });

  it('keeps the selection per pane, so the two strips do not follow each other', async () => {
    renderStrip('req-1', 'request');
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));
    cleanup();

    renderStrip('req-1', 'response');
    expect(screen.queryByTestId('inspector-panel-response')).toBeNull();
    expect(useEditorsStore.getState().inspectorFor('req-1', 'request')).toBe('ssl');
    expect(useEditorsStore.getState().inspectorFor('req-1', 'response')).toBe('headers');
  });

  it('toggles the panel from the chevron without changing the selected tab', async () => {
    renderStrip();
    await userEvent.click(screen.getByRole('tab', { name: 'SSL' }));

    await userEvent.click(screen.getByRole('button', { name: 'Hide Request inspectors' }));
    expect(screen.queryByTestId('inspector-panel-request')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Show Request inspectors' }));
    expect(screen.getByTestId('inspector-panel-request').textContent).toBe('ssl body');
  });
});
