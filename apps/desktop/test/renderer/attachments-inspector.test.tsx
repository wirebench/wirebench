import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttachmentsInspector } from '../../src/renderer/features/request-editor/inspectors/attachments-inspector.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import type { AttachmentWire, MimePartWire, RequestPropertiesWire } from '../../src/shared/wire-types.js';

const addAttachment = vi.fn().mockResolvedValue('att-new');
const updateAttachment = vi.fn();
const removeAttachment = vi.fn().mockResolvedValue(undefined);

const PROPERTIES = { enableMtom: false, enableInlineFiles: false } as unknown as RequestPropertiesWire;

function attachment(overrides: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: 'att-1',
    name: 'logo.png',
    contentType: 'image/png',
    size: 2048,
    type: 'UNKNOWN',
    contentId: 'att-1@wirebench',
    cached: true,
    source: { kind: 'cache', sha256: 'abc' },
    ...overrides,
  };
}

function install(attachments: readonly AttachmentWire[], mimeParts: readonly MimePartWire[] = []): void {
  useProjectStore.setState({
    requests: { 'req-1': makeDraft({ attachments: [...attachments], properties: PROPERTIES }) },
    interfaces: {
      'if-1': {
        operations: [
          {
            name: 'Add',
            binding: '{http://tempuri.org/}CalculatorSoap',
            inputMimeParts: [...mimeParts],
          },
        ],
      },
    },
    addAttachment,
    updateAttachment,
    removeAttachment,
  } as never);
  useEditorsStore.setState({ selectedAttachments: {} });
  usePreferencesStore.setState({
    preferences: { ...usePreferencesStore.getState().preferences, ui: { confirmOnDelete: false } },
  } as never);
}

/** A `File` whose `arrayBuffer()` works under jsdom, which does not implement it on Blob. */
function fakeFile(name: string, type: string, bytes: number[]): File {
  const file = new File([new Uint8Array(bytes)], name, { type });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(new Uint8Array(bytes).buffer) });
  return file;
}

describe('AttachmentsInspector', () => {
  beforeEach(() => {
    addAttachment.mockClear();
    updateAttachment.mockClear();
    removeAttachment.mockClear();
    installWirebenchApi();
    install([attachment()]);
  });

  afterEach(() => {
    cleanup();
  });

  it('invites a first attachment when the request has none', () => {
    install([]);
    render(<AttachmentsInspector requestId="req-1" />);

    expect(screen.getByText(/No attachments\. Add files or drop them here\./)).toBeDefined();
    expect(screen.queryByTestId('attachments-table')).toBeNull();
  });

  it('renders one row per attachment, with a human size and the exact bytes as its title', () => {
    install([attachment(), attachment({ id: 'att-2', name: 'notes.txt', size: 5, cached: false })]);
    render(<AttachmentsInspector requestId="req-1" />);

    expect(screen.getAllByTestId('attachment-row')).toHaveLength(2);
    expect(screen.getByText('2.0 KB').getAttribute('title')).toBe('2048 bytes');
    expect(screen.getByText('logo.png')).toBeDefined();
  });

  it('adds every picked file through addAttachment, honouring the Copy to project checkbox', async () => {
    const pickFiles = vi.fn().mockResolvedValue({ ok: true, value: { paths: ['/tmp/a.png', '/tmp/b.pdf'] } });
    installWirebenchApi({ attachments: { pickFiles } });
    render(<AttachmentsInspector requestId="req-1" />);

    await userEvent.click(screen.getByTestId('attachments-add'));

    await waitFor(() => {
      expect(addAttachment).toHaveBeenCalledTimes(2);
    });
    expect(addAttachment).toHaveBeenNthCalledWith(1, 'req-1', '/tmp/a.png', { copyToCache: true });
    expect(addAttachment).toHaveBeenNthCalledWith(2, 'req-1', '/tmp/b.pdf', { copyToCache: true });

    addAttachment.mockClear();
    await userEvent.click(screen.getByTestId('attachments-copy'));
    await userEvent.click(screen.getByTestId('attachments-add'));
    await waitFor(() => {
      expect(addAttachment).toHaveBeenCalledWith('req-1', '/tmp/a.png', { copyToCache: false });
    });
  });

  it('commits an inline Content-ID edit through updateAttachment', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const field = screen.getByLabelText<HTMLInputElement>('Content ID of logo.png');

    await userEvent.clear(field);
    await userEvent.type(field, 'part1@wirebench{Enter}');

    expect(updateAttachment).toHaveBeenCalledWith('req-1', 'att-1', { contentId: 'part1@wirebench' });
  });

  it('lists the operation inputMimeParts in the Part select and sets MIME when one is picked', async () => {
    install([attachment()], [{ part: 'file', type: 'application/octet-stream' }]);
    render(<AttachmentsInspector requestId="req-1" />);

    const select = screen.getByLabelText<HTMLSelectElement>('Part of logo.png');
    expect([...select.options].map((option) => option.value)).toEqual(['', 'file']);

    await userEvent.selectOptions(select, 'file');
    expect(updateAttachment).toHaveBeenCalledWith('req-1', 'att-1', { part: 'file', type: 'MIME' });
  });

  it('shows a plain dash for Part when the operation declares no MIME parts', () => {
    render(<AttachmentsInspector requestId="req-1" />);
    expect(screen.queryByLabelText('Part of logo.png')).toBeNull();
  });

  it('removes the selected row, and only then', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    expect(screen.getByTestId<HTMLButtonElement>('attachments-remove').disabled).toBe(true);

    await userEvent.click(screen.getByText('logo.png'));
    await userEvent.click(screen.getByTestId('attachments-remove'));

    expect(removeAttachment).toHaveBeenCalledWith('req-1', 'att-1');
  });

  it('opens an attachment through the row button', async () => {
    const openRequest = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/logo.png' } });
    installWirebenchApi({ attachments: { openRequest } });
    render(<AttachmentsInspector requestId="req-1" />);

    await userEvent.click(screen.getByLabelText('Open attachment'));

    expect(openRequest).toHaveBeenCalledWith({ requestId: 'req-1', attachmentId: 'att-1' });
  });

  it('flags a row main refuses as outside the project', async () => {
    const openRequest = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'attachment-outside-project', message: 'outside' } });
    installWirebenchApi({ attachments: { openRequest } });
    render(<AttachmentsInspector requestId="req-1" />);

    await userEvent.click(screen.getByLabelText('Open attachment'));

    await waitFor(() => {
      expect(screen.getByLabelText('Outside the project — remove and add it again')).toBeDefined();
    });
  });

  it('sends the bytes of every dropped file to attachments.addDropped', async () => {
    const addDropped = vi.fn().mockResolvedValue({ ok: true, value: { attachmentIds: ['a', 'b'] } });
    installWirebenchApi({ attachments: { addDropped } });
    render(<AttachmentsInspector requestId="req-1" />);

    fireEvent.drop(screen.getByTestId('attachments-dropzone'), {
      dataTransfer: {
        files: [fakeFile('one.png', 'image/png', [1, 2, 3]), fakeFile('two.txt', 'text/plain', [104, 105])],
      },
    });

    await waitFor(() => {
      expect(addDropped).toHaveBeenCalledWith({
        requestId: 'req-1',
        files: [
          { name: 'one.png', contentType: 'image/png', bytesBase64: 'AQID' },
          { name: 'two.txt', contentType: 'text/plain', bytesBase64: 'aGk=' },
        ],
      });
    });
  });

  it('warns that MTOM is off while attachments are present', () => {
    render(<AttachmentsInspector requestId="req-1" />);
    expect(screen.getByText(/MTOM is off — attachments are sent as SwA parts/)).toBeDefined();
  });
});

describe('AttachmentsTable keyboard model', () => {
  beforeEach(() => {
    addAttachment.mockClear();
    updateAttachment.mockClear();
    removeAttachment.mockClear();
    installWirebenchApi();
    install([attachment(), attachment({ id: 'att-2', name: 'notes.txt', size: 5 })]);
  });

  afterEach(() => {
    cleanup();
  });

  it('moves the selection with ArrowDown and ArrowUp', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getByText('notes.txt').closest('tr')?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(screen.getByText('logo.png').closest('tr')?.getAttribute('aria-selected')).toBe('true');
  });

  it('exposes rows and cells, with a roving tab stop that follows the selection', () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    const rows = screen.getAllByTestId('attachment-row');
    expect(rows.every((row) => row.getAttribute('role') === 'row')).toBe(true);
    expect(within(rows[0] as HTMLElement).getAllByRole('gridcell').length).toBe(8);
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1]);

    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.getAllByTestId('attachment-row').map((row) => row.tabIndex)).toEqual([-1, 0]);
  });

  it('detaches the selected row on Delete', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(grid, { key: 'Delete' });

    expect(removeAttachment).toHaveBeenCalledWith('req-1', 'att-1');
  });

  it('enters rename mode on F2, and Enter with no change exits it without committing', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(grid, { key: 'F2' });
    const field = screen.getByLabelText<HTMLInputElement>('Name of logo.png');
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(screen.queryByLabelText('Name of logo.png')).toBeNull();
    expect(screen.getByText('logo.png')).toBeDefined();
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('F2 then Escape exits rename mode without committing the draft', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(grid, { key: 'F2' });
    const field = screen.getByLabelText<HTMLInputElement>('Name of logo.png');
    await userEvent.clear(field);
    await userEvent.type(field, 'renamed');
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByLabelText('Name of logo.png')).toBeNull();
    expect(screen.getByText('logo.png')).toBeDefined();
    expect(updateAttachment).not.toHaveBeenCalled();
  });

  it('does not remove the row when Delete is pressed inside the Type select', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(screen.getByLabelText('Type of logo.png'), { key: 'Delete' });

    expect(removeAttachment).not.toHaveBeenCalled();
  });

  it('does not remove the row when Delete is pressed inside the Part select', async () => {
    install(
      [attachment(), attachment({ id: 'att-2', name: 'notes.txt', size: 5 })],
      [{ part: 'file', type: 'application/octet-stream' }],
    );
    render(<AttachmentsInspector requestId="req-1" />);
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(screen.getByLabelText('Part of logo.png'), { key: 'Delete' });

    expect(removeAttachment).not.toHaveBeenCalled();
  });
});

describe('AttachmentsInspector confirm-on-delete', () => {
  beforeEach(() => {
    addAttachment.mockClear();
    updateAttachment.mockClear();
    removeAttachment.mockClear();
    installWirebenchApi();
    install([attachment()]);
    usePreferencesStore.setState({
      preferences: { ...usePreferencesStore.getState().preferences, ui: { confirmOnDelete: true } },
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts before removing the Remove button’s row, and removes only on confirm', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    await userEvent.click(screen.getByText('logo.png'));

    await userEvent.click(screen.getByTestId('attachments-remove'));
    expect(removeAttachment).not.toHaveBeenCalled();
    expect(screen.getByText('Remove attachment?')).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removeAttachment).toHaveBeenCalledWith('req-1', 'att-1');
  });

  it('prompts before removing on Delete from the grid too', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    const grid = screen.getByTestId('attachments-table');
    await userEvent.click(screen.getByText('logo.png'));

    fireEvent.keyDown(grid, { key: 'Delete' });

    expect(removeAttachment).not.toHaveBeenCalled();
    expect(screen.getByText('Remove attachment?')).toBeDefined();
  });

  it('cancelling the prompt leaves the attachment in place', async () => {
    render(<AttachmentsInspector requestId="req-1" />);
    await userEvent.click(screen.getByText('logo.png'));
    await userEvent.click(screen.getByTestId('attachments-remove'));

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(removeAttachment).not.toHaveBeenCalled();
    expect(screen.queryByText('Remove attachment?')).toBeNull();
  });
});
