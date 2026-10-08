import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InheritedField } from '../../src/renderer/features/ssh/inherited-field.js';

afterEach(cleanup);

describe('InheritedField', () => {
  it('shows the inherited value greyed with its source; Override starts from that value', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        label="User"
        provenance={{ value: 'deploy', from: { group: 'prod' } }}
        override={undefined}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('from prod')).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('User').disabled).toBe(true);
    await userEvent.click(screen.getByRole('switch', { name: 'Override User' }));
    expect(onChange).toHaveBeenCalledWith('deploy');
  });
  it('an overridden field is editable; the switch turns the override off', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        label="User"
        provenance={{ value: 'deploy', from: { group: 'prod' } }}
        override="me"
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    await userEvent.click(screen.getByRole('switch', { name: 'Override User' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
  it('overriding a field with nothing inherited starts empty rather than staying inherited', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        label="User"
        provenance={{ value: undefined, from: 'default' }}
        override={undefined}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Override User' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
