import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../../src/renderer/components/confirm-dialog.js';

describe('ConfirmDialog', () => {
  afterEach(cleanup);

  it('shows nothing until it is open', () => {
    render(
      <ConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Delete request?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
        testId="confirm"
      />,
    );

    expect(screen.queryByTestId('confirm')).toBeNull();
  });

  it('names the act, confirms it, and carries the testids it was given', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete workspace?"
        description="Its projects go to the trash."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
        testId="confirm"
        confirmTestId="confirm-action"
      />,
    );

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByTestId('confirm')).toBeTruthy();
    expect(screen.getByText('Delete workspace?')).toBeTruthy();
    expect(screen.getByText('Its projects go to the trash.')).toBeTruthy();

    await userEvent.click(screen.getByTestId('confirm-action'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('closes on Cancel and on Escape without confirming', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Remove interface?"
        description="Discards its request drafts."
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
