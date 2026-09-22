import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvPickerDialog } from '../../src/renderer/features/multi-env/env-picker-dialog.js';
import { sendToEnvironmentsBlocker } from '../../src/renderer/features/multi-env/multi-env-actions.js';

const ENVS = [
  { id: 'dev', name: 'Dev' },
  { id: 'test', name: 'Test' },
  { id: 'prod', name: 'Prod' },
];

describe('EnvPickerDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens with the active environment ticked as baseline and Send disabled under two ticks', async () => {
    const onSend = vi.fn();
    render(<EnvPickerDialog open onOpenChange={vi.fn()} environments={ENVS} activeId="dev" onSend={onSend} />);

    expect(screen.getByLabelText<HTMLInputElement>('Include Dev').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Dev').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Test').disabled).toBe(true);
    const send = screen.getByTestId('env-picker-send');
    expect(send.hasAttribute('disabled')).toBe(true);

    await userEvent.click(screen.getByLabelText('Include Test'));
    expect(send.hasAttribute('disabled')).toBe(false);

    await userEvent.click(screen.getByLabelText('Baseline Test'));
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith({ ticked: ['dev', 'test'], baseline: 'test' });
  });

  it('moves the baseline when its environment is unticked', async () => {
    render(
      <EnvPickerDialog
        open
        onOpenChange={vi.fn()}
        environments={ENVS}
        activeId="dev"
        remembered={{ ticked: ['dev', 'test', 'prod'], baseline: 'test' }}
        onSend={vi.fn()}
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Test').checked).toBe(true);
    await userEvent.click(screen.getByLabelText('Include Test'));
    expect(screen.getByLabelText<HTMLInputElement>('Baseline Dev').checked).toBe(true);
  });
});

describe('sendToEnvironmentsBlocker', () => {
  it('blocks with fewer than two environments or inside a workspace', () => {
    expect(sendToEnvironmentsBlocker(1, false)).toMatch(/two or more/);
    expect(sendToEnvironmentsBlocker(3, true)).toMatch(/workspace/);
    expect(sendToEnvironmentsBlocker(2, false)).toBeUndefined();
  });
});
