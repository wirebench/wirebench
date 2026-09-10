import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecretField } from '../../src/renderer/components/secret-field.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  cleanup();
});

describe('SecretField', () => {
  it('renders masked when a ref is set, and "Not set" when it is not', () => {
    installWirebenchApi();
    const { rerender } = render(<SecretField value="sec_abc" onChange={vi.fn()} label="Password" />);
    expect(screen.getByLabelText('Password').textContent).toBe('••••••••');

    rerender(<SecretField value={undefined} onChange={vi.fn()} label="Password" />);
    expect(screen.getByLabelText('Password').textContent).toBe('Not set');
  });

  it('never renders the actual secret value anywhere in the DOM', () => {
    installWirebenchApi();
    render(<SecretField value="sec_abc" onChange={vi.fn()} label="Password" />);
    expect(document.body.textContent).not.toContain('hunter2');
  });

  it('calling Set… then Save on a fresh field calls secrets.set and emits the returned ref', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'sec_new' } });
    installWirebenchApi({ secrets: { set } });
    const onChange = vi.fn();
    render(<SecretField value={undefined} onChange={onChange} label="Password" />);

    fireEvent.click(screen.getByRole('button', { name: 'Set…' }));
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('sec_new'));
    expect(set).toHaveBeenCalledWith({ value: 'hunter2', label: 'Password' });
  });

  it('Replace… on an existing ref calls secrets.replace with that same ref', async () => {
    const replace = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'sec_abc' } });
    installWirebenchApi({ secrets: { replace } });
    const onChange = vi.fn();
    render(<SecretField value="sec_abc" onChange={onChange} label="Password" />);

    fireEvent.click(screen.getByRole('button', { name: 'Replace…' }));
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'newpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith({ ref: 'sec_abc', value: 'newpass' }));
    expect(onChange).toHaveBeenCalledWith('sec_abc');
  });

  it('Clear emits undefined without calling any secrets channel', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    render(<SecretField value="sec_abc" onChange={onChange} label="Password" />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('flush() stores a value the user typed but never pressed Save on', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true, value: { ref: 'sec_flushed' } });
    installWirebenchApi({ secrets: { set } });
    const onChange = vi.fn();
    let flush: (() => Promise<string | undefined>) | undefined;
    render(
      <SecretField
        value={undefined}
        onChange={onChange}
        label="Password"
        registerFlush={(fn) => {
          flush = fn;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set…' }));
    fireEvent.change(screen.getByPlaceholderText('Enter password'), { target: { value: 'hunter2' } });

    // The owning dialog submits without the user pressing Save: the draft must be stored, not
    // silently dropped on the floor.
    await expect(flush?.()).resolves.toBe('sec_flushed');
    expect(set).toHaveBeenCalledWith({ value: 'hunter2', label: 'Password' });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('sec_flushed'));
  });

  it('flush() keeps the existing ref when nothing was typed', async () => {
    const set = vi.fn();
    installWirebenchApi({ secrets: { set } });
    let flush: (() => Promise<string | undefined>) | undefined;
    render(
      <SecretField
        value="sec_abc"
        onChange={vi.fn()}
        label="Password"
        registerFlush={(fn) => {
          flush = fn;
        }}
      />,
    );

    await expect(flush?.()).resolves.toBe('sec_abc');
    expect(set).not.toHaveBeenCalled();
  });
});
