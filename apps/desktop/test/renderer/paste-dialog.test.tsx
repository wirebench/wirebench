import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PasteDialog } from '../../src/renderer/features/ssh/paste-dialog.js';

afterEach(cleanup);

const TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n';

it('renders nothing without pending text', () => {
  render(<PasteDialog text={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('previews the first five lines and counts the rest', () => {
  render(<PasteDialog text={TEXT} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  const preview = screen.getByTestId('paste-preview');
  expect(preview.textContent).toBe('one\ntwo\nthree\nfour\nfive');
  expect(screen.getByText('+ 2 more lines')).toBeDefined();
});

it('shows no remainder line when the whole paste fits', () => {
  render(<PasteDialog text={'a\nb\n'} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.queryByText(/more line/)).toBeNull();
});

it('Paste is the focused default and confirms without the opt-out', async () => {
  const onConfirm = vi.fn();
  render(<PasteDialog text={TEXT} onConfirm={onConfirm} onCancel={vi.fn()} />);
  const paste = screen.getByRole('button', { name: 'Paste' });
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(paste);
  });
  await userEvent.click(paste);
  expect(onConfirm).toHaveBeenCalledWith(false);
});

it("ticking Don't ask again passes the opt-out along with Paste", async () => {
  const onConfirm = vi.fn();
  render(<PasteDialog text={TEXT} onConfirm={onConfirm} onCancel={vi.fn()} />);
  await userEvent.click(screen.getByRole('checkbox', { name: "Don't ask again" }));
  await userEvent.click(screen.getByRole('button', { name: 'Paste' }));
  expect(onConfirm).toHaveBeenCalledWith(true);
});

it('Cancel and Escape close without sending', async () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<PasteDialog text={TEXT} onConfirm={onConfirm} onCancel={onCancel} />);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  await userEvent.keyboard('{Escape}');
  expect(onCancel).toHaveBeenCalledTimes(2);
  expect(onConfirm).not.toHaveBeenCalled();
});
