import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OverviewTab } from '../../src/renderer/features/rest-api/overview-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { restApiWire } from '../helpers/wire-defaults.js';
import type { RestApiWire } from '@wirebench/wire/kinds/rest/wire';

const updateApi = vi.fn();

function mount(api: RestApiWire, onOpenDocs?: () => void): void {
  useProjectStore.setState({ apis: { [api.id]: api }, updateApi } as never);
  render(<OverviewTab apiId={api.id} {...(onOpenDocs !== undefined ? { onOpenDocs } : {})} />);
}

beforeEach(() => {
  updateApi.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('OverviewTab', () => {
  it('shows the name and the description rendered as Markdown', () => {
    mount(restApiWire({ description: '## Flow\n\n1. Sign in\n2. Create a card' }));

    expect(screen.getByRole('heading', { level: 2, name: 'Petstore' })).toBeTruthy();
    const view = screen.getByTestId('markdown-view');
    expect(view.querySelector('h2')?.textContent).toBe('Flow');
    expect(view.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('offers to add a description when there is none', () => {
    mount(restApiWire());

    expect(screen.getByTestId('api-overview-empty').textContent).toContain('No description.');
    expect(screen.queryByTestId('api-overview-edit')).toBeNull();
    fireEvent.click(screen.getByTestId('api-overview-add'));
    expect(screen.getByTestId<HTMLTextAreaElement>('api-overview-editor').value).toBe('');
  });

  it('edits the source text and saves it as one update-api patch', () => {
    mount(restApiWire({ description: 'Old text' }));

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    const editor = screen.getByTestId<HTMLTextAreaElement>('api-overview-editor');
    expect(editor.value).toBe('Old text');
    fireEvent.change(editor, { target: { value: 'New *text*' } });
    fireEvent.click(screen.getByTestId('api-overview-save'));

    expect(updateApi).toHaveBeenCalledTimes(1);
    expect(updateApi).toHaveBeenCalledWith('api-1', { description: 'New *text*' });
    expect(screen.queryByTestId('api-overview-editor')).toBeNull();
  });

  it('saves with Cmd/Ctrl+Enter and cancels with Escape', () => {
    mount(restApiWire({ description: 'Old text' }));

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.change(screen.getByTestId('api-overview-editor'), { target: { value: 'Draft' } });
    fireEvent.keyDown(screen.getByTestId('api-overview-editor'), { key: 'Escape' });
    expect(screen.queryByTestId('api-overview-editor')).toBeNull();
    expect(updateApi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.change(screen.getByTestId('api-overview-editor'), { target: { value: 'Kept' } });
    fireEvent.keyDown(screen.getByTestId('api-overview-editor'), { key: 'Enter', ctrlKey: true });
    expect(updateApi).toHaveBeenCalledWith('api-1', { description: 'Kept' });
  });

  it('stores an emptied description as absent, and writes nothing when unchanged', () => {
    mount(restApiWire({ description: 'Old text' }));

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.click(screen.getByTestId('api-overview-save'));
    expect(updateApi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.change(screen.getByTestId('api-overview-editor'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('api-overview-cancel'));
    expect(updateApi).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.change(screen.getByTestId('api-overview-editor'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('api-overview-save'));
    expect(updateApi).toHaveBeenCalledWith('api-1', { description: null });
  });

  it('keeps a draft when the description is rewritten underneath it', () => {
    const api = restApiWire({ description: 'v1' });
    mount(api);

    fireEvent.click(screen.getByTestId('api-overview-edit'));
    fireEvent.change(screen.getByTestId('api-overview-editor'), { target: { value: 'my draft' } });
    act(() => {
      useProjectStore.setState({ apis: { [api.id]: { ...api, description: 'v2 from the definition' } } });
    });

    expect(screen.getByTestId<HTMLTextAreaElement>('api-overview-editor').value).toBe('my draft');
    fireEvent.click(screen.getByTestId('api-overview-cancel'));
    expect(screen.getByTestId('markdown-view').textContent).toBe('v2 from the definition');
  });

  it('links to the full documentation only when it can open it', () => {
    mount(restApiWire());
    expect(screen.queryByTestId('api-overview-docs')).toBeNull();
    cleanup();

    const onOpenDocs = vi.fn();
    mount(restApiWire(), onOpenDocs);
    fireEvent.click(screen.getByTestId('api-overview-docs'));
    expect(onOpenDocs).toHaveBeenCalledTimes(1);
  });
});
