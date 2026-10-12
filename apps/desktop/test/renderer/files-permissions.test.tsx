import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsDialog } from '../../src/renderer/features/ssh/files/permissions-dialog.js';

afterEach(() => {
  cleanup();
});

function open(mode: number) {
  const onApply = vi.fn();
  render(<PermissionsDialog target={{ name: 'run.sh', mode }} onCancel={vi.fn()} onApply={onApply} />);
  return { onApply, octal: screen.getByLabelText<HTMLInputElement>('Octal mode') };
}

const box = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

describe('the permissions dialog', () => {
  it('starts from the mode, boxes and octal field alike', () => {
    const { octal } = open(0o640);
    expect(octal.value).toBe('640');
    expect(box('Owner read').checked).toBe(true);
    expect(box('Owner write').checked).toBe(true);
    expect(box('Owner execute').checked).toBe(false);
    expect(box('Group read').checked).toBe(true);
    expect(box('Others read').checked).toBe(false);
  });

  it('a box rewrites the octal field, and a typed octal ticks the boxes', () => {
    const { octal } = open(0o640);
    fireEvent.click(box('Owner execute'));
    expect(octal.value).toBe('740');
    fireEvent.change(octal, { target: { value: '755' } });
    expect(box('Others execute').checked).toBe(true);
    expect(box('Group write').checked).toBe(false);
  });

  it('an invalid octal disables Apply', () => {
    const { octal } = open(0o640);
    fireEvent.change(octal, { target: { value: '89' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true);
  });

  it('keeps the set-id and sticky bits it does not show', () => {
    const { octal, onApply } = open(0o4755);
    expect(octal.value).toBe('755');
    fireEvent.change(octal, { target: { value: '750' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith(0o4750);
  });
});
