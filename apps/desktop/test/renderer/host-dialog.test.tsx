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
    expect(screen.getByText('deploy · from prod')).toBeDefined();
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
  it('with no group supplying it, the field is plain: no switch, the default as placeholder and source', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        label="Port"
        type="number"
        provenance={{ value: 22, from: 'default' }}
        override={undefined}
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    const port = screen.getByLabelText<HTMLInputElement>('Port');
    expect(port.disabled).toBe(false);
    expect(port.value).toBe('');
    expect(port.placeholder).toBe('22');
    expect(screen.getByText('22 · default')).toBeDefined();
    await userEvent.type(port, '2');
    expect(onChange).toHaveBeenLastCalledWith(2);
  });
  it('a user with nothing to inherit is a plain field with no source', () => {
    render(
      <InheritedField
        label="User"
        provenance={{ value: undefined, from: 'default' }}
        override="me"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('User').value).toBe('me');
    expect(screen.queryByText(/default/)).toBeNull();
  });
  it('clearing a number reports undefined, not 0, and the field stays editable', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        label="Port"
        type="number"
        provenance={{ value: 22, from: 'default' }}
        override={2200}
        onChange={onChange}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Port'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByLabelText<HTMLInputElement>('Port').disabled).toBe(false);
  });
});
