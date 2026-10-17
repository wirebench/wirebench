/**
 * The Send ▾ menu (#632): under *Send to environments…* it offers *Copy as cURL* and *Generate
 * code…*, each running the action the request's palette command and the Code panel already run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useUiStore } from '../../src/renderer/state/ui.js';

const copyAsCurl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../src/renderer/features/request-editor/request-actions.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  copyAsCurl,
}));

const { SendMenu } = await import('../../src/renderer/features/multi-env/send-menu.js');

/** Opens the ▾ menu the way a click does: Radix opens on pointer-down. */
async function openMenu(): Promise<void> {
  const trigger = screen.getByTestId('send-menu');
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  await screen.findByTestId('send-to-environments');
}

describe('SendMenu', () => {
  beforeEach(() => {
    copyAsCurl.mockClear();
    useUiStore.setState((state) => ({ slideOver: { ...state.slideOver, open: false, codeShell: 'powershell' } }));
  });
  afterEach(() => {
    cleanup();
  });

  it('copies a REST request as cURL in the shell the Code panel shows', async () => {
    render(<SendMenu requestId="r1" kind="rest" />);
    await openMenu();

    fireEvent.click(screen.getByTestId('send-menu-copy-curl'));

    expect(copyAsCurl).toHaveBeenCalledWith('r1', 'powershell');
  });

  it('copies a SOAP request as cURL for POSIX, as its Copy as cURL command does', async () => {
    render(<SendMenu requestId="s1" kind="soap" />);
    await openMenu();

    fireEvent.click(screen.getByTestId('send-menu-copy-curl'));

    expect(copyAsCurl).toHaveBeenCalledWith('s1', 'posix');
  });

  it('opens the Code panel from Generate code…', async () => {
    render(<SendMenu requestId="r1" kind="rest" />);
    await openMenu();

    fireEvent.click(screen.getByTestId('send-menu-generate-code'));

    expect(useUiStore.getState().slideOver.open).toBe(true);
  });
});
