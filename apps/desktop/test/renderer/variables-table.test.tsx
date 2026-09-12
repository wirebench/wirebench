import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { VariablesTable, type VariablesTableTarget } from '../../src/renderer/features/environments/variables-table.js';

function baseTarget(patch: Partial<VariablesTableTarget> = {}): VariablesTableTarget {
  return {
    label: 'Test variables',
    properties: { host: 'one.test' },
    disabled: [],
    onSet: vi.fn(),
    onRemove: vi.fn(),
    ...patch,
  };
}

function renderTable(target: VariablesTableTarget) {
  return render(
    <TooltipPrimitive.Provider>
      <VariablesTable target={target} />
    </TooltipPrimitive.Provider>,
  );
}

describe('VariablesTable', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the Enabled/Variable/Value header and one row per property', () => {
    renderTable(baseTarget({ properties: { host: 'one.test', port: '80' } }));
    expect(screen.getByRole('table', { name: 'Test variables' })).toBeTruthy();
    // One row per property, plus the always-present add row.
    expect(screen.getAllByTestId('env-variable-row')).toHaveLength(3);
  });

  it('commits a value edit on Enter', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('host', 'two.test');
  });

  it('commits a value edit on blur', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.blur(value);
    expect(onSet).toHaveBeenCalledWith('host', 'two.test');
  });

  it('reverts an edit on Escape without saving', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText<HTMLInputElement>('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.keyDown(value, { key: 'Escape' });
    expect(value.value).toBe('one.test');
    expect(onSet).not.toHaveBeenCalled();
  });

  it('removes a variable', () => {
    const onRemove = vi.fn();
    renderTable(baseTarget({ onRemove }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }));
    expect(onRemove).toHaveBeenCalledWith('host');
  });

  it('toggles Enabled through onSetEnabled', () => {
    const onSetEnabled = vi.fn();
    renderTable(baseTarget({ onSetEnabled }));
    fireEvent.click(screen.getByLabelText('Enable host'));
    expect(onSetEnabled).toHaveBeenCalledWith('host', false);
  });

  it('shows the Enabled checkbox read-only when onSetEnabled is not given, with a title explaining why', () => {
    renderTable(baseTarget());
    const checkbox = screen.getByLabelText<HTMLInputElement>('Enable host');
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.title).toBe("A linked project's own environment variables are managed in that project.");
  });

  it('has no title on the Enabled checkbox when it is interactive', () => {
    renderTable(baseTarget({ onSetEnabled: vi.fn() }));
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').title).toBe('');
  });

  it('mutes a disabled variable row', () => {
    renderTable(baseTarget({ disabled: ['host'] }));
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').checked).toBe(false);
    const rows = screen.getAllByTestId('env-variable-row');
    expect(rows[0]?.className).toContain('opacity-50');
  });

  it('adds a variable through the always-present add row', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('port', '8080');
  });

  it('flags an empty name and does not save it', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A variable needs a name.');
  });

  it('flags a duplicate name and does not save it', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'host' } });
    fireEvent.keyDown(screen.getByLabelText('New variable name'), { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A variable named "host" already exists.');
  });

  it('renames through onRename when given', () => {
    const onRename = vi.fn();
    renderTable(baseTarget({ onRename }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('host', 'hostname');
  });

  it('falls back to remove-then-set when onRename is not given', () => {
    const onSet = vi.fn();
    const onRemove = vi.fn();
    renderTable(baseTarget({ onSet, onRemove }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onRemove).toHaveBeenCalledWith('host');
    expect(onSet).toHaveBeenCalledWith('hostname', 'one.test');
  });
});
