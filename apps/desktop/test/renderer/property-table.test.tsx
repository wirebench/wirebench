import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { PropertyTable } from '../../src/renderer/features/properties/property-table.js';

function renderTable(properties: Record<string, string>, handlers: Partial<Parameters<typeof PropertyTable>[0]> = {}) {
  const onSet = vi.fn();
  const onRemove = vi.fn();
  const onRename = vi.fn();
  render(
    <TooltipPrimitive.Provider>
      <PropertyTable
        label="Project properties"
        properties={properties}
        onSet={onSet}
        onRemove={onRemove}
        onRename={onRename}
        {...handlers}
      />
    </TooltipPrimitive.Provider>,
  );
  return { onSet, onRemove, onRename };
}

describe('PropertyTable', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows an empty state when there are no properties', () => {
    renderTable({});
    expect(screen.getByText('No properties yet.')).toBeDefined();
  });

  it('lists properties sorted by name', () => {
    renderTable({ zeta: '2', alpha: '1' });
    const names = screen.getAllByTestId('property-name').map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('adds a property from the new-row fields', () => {
    const { onSet } = renderTable({});
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'host' } });
    fireEvent.change(screen.getByLabelText('New property value'), { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    expect(onSet).toHaveBeenCalledWith('host', 'example.test');
  });

  it('adds a property when Enter is pressed in the value field', () => {
    const { onSet } = renderTable({});
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'host' } });
    const value = screen.getByLabelText('New property value');
    fireEvent.change(value, { target: { value: 'example.test' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('host', 'example.test');
  });

  it('refuses a duplicate name and says why', () => {
    const { onSet } = renderTable({ host: 'a' });
    fireEvent.change(screen.getByLabelText('New property name'), { target: { value: 'host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add property' }));
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already');
  });

  it('edits a value on blur', () => {
    const { onSet } = renderTable({ host: 'a' });
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'b' } });
    fireEvent.blur(value);
    expect(onSet).toHaveBeenCalledWith('host', 'b');
  });

  it('renames a property on blur', () => {
    const { onRename } = renderTable({ host: 'a' });
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.blur(name);
    expect(onRename).toHaveBeenCalledWith('host', 'hostname');
  });

  it('refuses a rename onto an existing name', () => {
    const { onRename } = renderTable({ host: 'a', port: '1' });
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'port' } });
    fireEvent.blur(name);
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already');
  });

  it('removes a property', () => {
    const { onRemove } = renderTable({ host: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }));
    expect(onRemove).toHaveBeenCalledWith('host');
  });
});
