/**
 * The ordered key/value grid.
 *
 * The cases worth having are the ones a caller would otherwise get wrong: an edit hands back the
 * *whole* list (a REST request patch replaces a table, it never merges it), two rows may carry the
 * same name where the protocol allows it, and a keystroke is never a mutation — Enter or blur
 * commits, Escape puts the row back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { KvTable } from '../../src/renderer/components/kv-table.js';
import type { KeyValueWire } from '../../src/shared/wire-types.js';

afterEach(() => {
  cleanup();
});

/** Every row's delete button is an `IconButton`, which needs Radix's tooltip provider above it. */
function render(ui: React.ReactElement): ReturnType<typeof renderBare> {
  return renderBare(<TooltipPrimitive.Provider>{ui}</TooltipPrimitive.Provider>);
}

const row = (name: string, value: string, overrides: Partial<KeyValueWire> = {}): KeyValueWire => ({
  name,
  value,
  enabled: true,
  ...overrides,
});

function mount(props: Partial<React.ComponentProps<typeof KvTable>> = {}): {
  readonly onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  render(
    <KvTable
      label="Query parameters"
      rows={[row('a', '1')]}
      onChange={onChange}
      testidPrefix="rest-query"
      {...props}
    />,
  );
  return { onChange };
}

describe('KvTable', () => {
  it('renders one row per entry plus an always-present add row', () => {
    mount({ rows: [row('a', '1'), row('b', '2')] });

    expect(screen.getAllByTestId('rest-query-row')).toHaveLength(2);
    expect(screen.getByTestId('rest-query-add-row')).toBeTruthy();
    expect(screen.getByTestId('rest-query-table').getAttribute('aria-label')).toBe('Query parameters');
  });

  it('commits a value on Enter, and hands back the whole list', () => {
    const { onChange } = mount({ rows: [row('a', '1'), row('b', '2')] });

    const value = screen.getAllByTestId('rest-query-value')[1]!;
    fireEvent.change(value, { target: { value: '22' } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(value, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([row('a', '1'), row('b', '22')]);
  });

  it('commits on blur too', () => {
    const { onChange } = mount();

    const value = screen.getByTestId('rest-query-value');
    fireEvent.change(value, { target: { value: 'changed' } });
    fireEvent.blur(value);

    expect(onChange).toHaveBeenCalledWith([row('a', 'changed')]);
  });

  it('reverts on Escape, and writes nothing', () => {
    const { onChange } = mount();

    const value = screen.getByTestId<HTMLInputElement>('rest-query-value');
    fireEvent.change(value, { target: { value: 'oops' } });
    fireEvent.keyDown(value, { key: 'Escape' });

    expect(value.value).toBe('1');
    fireEvent.blur(value);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes nothing when a field is committed unchanged', () => {
    const { onChange } = mount();

    fireEvent.blur(screen.getByTestId('rest-query-value'));
    fireEvent.keyDown(screen.getByTestId('rest-query-name'), { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('appends a row as soon as the add row is typed into', () => {
    const { onChange } = mount();

    fireEvent.change(screen.getByTestId('rest-query-new-name'), { target: { value: 'b' } });

    expect(onChange).toHaveBeenCalledWith([row('a', '1'), row('b', '')]);
  });

  it('keeps typing in the row the first keystroke created, rather than a row per character', async () => {
    let latest: readonly KeyValueWire[] = [];
    function Host({ column }: { readonly column: 'name' | 'value' }) {
      const [rows, setRows] = useState<readonly KeyValueWire[]>([]);
      latest = rows;
      return <KvTable label="Headers" rows={rows} onChange={setRows} testidPrefix="rest-header" key={column} />;
    }

    render(<Host column="name" />);
    await userEvent.click(screen.getByTestId('rest-header-new-name'));
    await userEvent.keyboard('X-Trace');
    expect(screen.getByTestId<HTMLInputElement>('rest-header-name').value).toBe('X-Trace');
    await userEvent.tab();
    expect(latest).toEqual([row('X-Trace', '')]);
    cleanup();

    render(<Host column="value" />);
    await userEvent.click(screen.getByTestId('rest-header-new-value'));
    await userEvent.keyboard('abc{Enter}');
    expect(latest).toEqual([row('', 'abc')]);
  });

  it('lists the computed rows first, then the editable ones, with the add row last', () => {
    mount({ computed: [row('Content-Type', 'text/xml', { description: 'from the binding' })] });
    const order = screen
      .getAllByRole('row')
      .map((tr) => tr.getAttribute('data-testid'))
      .filter((id) => id !== null);
    // A typed row lands right above the add row it was typed into.
    expect(order).toEqual(['rest-query-computed-row', 'rest-query-row', 'rest-query-add-row']);
  });

  it('wraps a long value in its cell, and Enter there saves without starting a new line', async () => {
    const { onChange } = mount();
    const value = screen.getByTestId<HTMLTextAreaElement>('rest-query-value');
    expect(value.tagName).toBe('TEXTAREA');

    await userEvent.clear(value);
    await userEvent.type(value, 'long{Enter}');

    expect(value.value).toBe('long');
    expect(onChange).toHaveBeenLastCalledWith([row('a', 'long')]);
  });

  it('resizes a column from the keyboard, giving the width to the column on its right, and resets on double click', async () => {
    mount({ columns: ['enabled', 'name', 'value', 'description'], testidPrefix: 'resize-probe' });
    const width = (index: number): string =>
      (screen.getByTestId('resize-probe-table').querySelectorAll('col')[index] as HTMLElement).style.width;
    const [nameBefore, valueBefore] = [width(1), width(2)];

    const handle = screen.getByRole('separator', { name: 'Resize Name column' });
    handle.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(parseFloat(width(1))).toBeGreaterThan(parseFloat(nameBefore));
    expect(parseFloat(width(2))).toBeLessThan(parseFloat(valueBefore));
    // The last text column has no handle of its own: its right edge is the table's.
    expect(screen.queryByRole('separator', { name: 'Resize Description column' })).toBeNull();

    fireEvent.doubleClick(handle);
    expect([width(1), width(2)]).toEqual([nameBefore, valueBefore]);
  });

  it('appends from the value column as well, so a valueless name is not forced first', () => {
    const { onChange } = mount({ rows: [] });

    fireEvent.change(screen.getByTestId('rest-query-new-value'), { target: { value: 'x' } });

    expect(onChange).toHaveBeenCalledWith([row('', 'x')]);
  });

  it('toggles a row off without deleting it', () => {
    const { onChange } = mount();

    fireEvent.click(screen.getByTestId('rest-query-enabled'));

    expect(onChange).toHaveBeenCalledWith([row('a', '1', { enabled: false })]);
  });

  it('deletes by position, not by name, so a repeated name loses the right row', () => {
    const { onChange } = mount({ rows: [row('a', '1'), row('a', '2'), row('b', '3')] });

    fireEvent.click(screen.getAllByTestId('rest-query-delete')[1]!);

    expect(onChange).toHaveBeenCalledWith([row('a', '1'), row('b', '3')]);
  });

  it('allows the same name twice by default: a query string legitimately repeats one', () => {
    const { onChange } = mount({ rows: [row('tag', '1'), row('b', '2')] });

    const name = screen.getAllByTestId('rest-query-name')[1]!;
    fireEvent.change(name, { target: { value: 'tag' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith([row('tag', '1'), row('tag', '2')]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses a duplicate name when the caller disallows it, and says so', () => {
    const { onChange } = mount({ rows: [row('tag', '1'), row('b', '2')], allowDuplicates: false });

    const name = screen.getAllByTestId('rest-query-name')[1]!;
    fireEvent.change(name, { target: { value: 'tag' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already a row named "tag"');
  });

  it('refuses a duplicate from the add row too', () => {
    const { onChange } = mount({ rows: [row('tag', '1')], allowDuplicates: false });

    fireEvent.change(screen.getByTestId('rest-query-new-name'), { target: { value: 'tag' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows only the columns it was asked for', () => {
    mount({ columns: ['name', 'value'] });

    expect(screen.queryByTestId('rest-query-enabled')).toBeNull();
    expect(screen.queryByTestId('rest-query-description')).toBeNull();
    expect(screen.getByTestId('rest-query-name')).toBeTruthy();
  });

  it('edits a description when that column is on', () => {
    const { onChange } = mount({ columns: ['enabled', 'name', 'value', 'description'] });

    const description = screen.getByTestId('rest-query-description');
    fireEvent.change(description, { target: { value: 'the tag' } });
    fireEvent.keyDown(description, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith([row('a', '1', { description: 'the tag' })]);
  });

  it('shows computed rows greyed and never writes them back', () => {
    const { onChange } = mount({ computed: [row('content-type', 'application/json')] });

    const computed = screen.getByTestId('rest-query-computed-row');
    expect(computed.textContent).toContain('application/json');
    // No editable control in a computed row, so there is nothing to commit.
    expect(computed.querySelectorAll('input[type="text"]')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('locks the name column when the caller owns the names', () => {
    mount({ lockNames: true });

    expect(screen.getByTestId<HTMLInputElement>('rest-query-name').readOnly).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>('rest-query-value').readOnly).toBe(false);
  });

  it('shows the empty message only while there is nothing at all', () => {
    const { rerender } = render(
      <KvTable
        label="Query parameters"
        rows={[]}
        onChange={vi.fn()}
        testidPrefix="rest-query"
        emptyMessage="No query parameters."
      />,
    );
    expect(screen.getByText('No query parameters.')).toBeTruthy();

    rerender(
      <TooltipPrimitive.Provider>
        <KvTable
          label="Query parameters"
          rows={[row('a', '1')]}
          onChange={vi.fn()}
          testidPrefix="rest-query"
          emptyMessage="No query parameters."
        />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByText('No query parameters.')).toBeNull();
  });

  it('is one tab stop with roving focus between its rows', () => {
    mount({ rows: [row('a', '1'), row('b', '2')] });

    const rows = screen.getAllByTestId('rest-query-row');
    expect(rows.map((element) => element.getAttribute('tabindex'))).toEqual(['0', '-1']);
    expect(screen.getByTestId('rest-query-table').getAttribute('role')).toBe('grid');
  });

  it('keeps two tables on one tab apart by their testid prefix', () => {
    render(<KvTable label="Path parameters" rows={[row('petId', '1')]} onChange={vi.fn()} testidPrefix="rest-path" />);
    mount();

    expect(screen.getByTestId('rest-path-table')).toBeTruthy();
    expect(screen.getByTestId('rest-query-table')).toBeTruthy();
  });

  it('takes the placeholders the caller gives the add row', () => {
    mount({ placeholders: { name: 'header', value: 'contents' } });

    expect(screen.getByTestId('rest-query-new-name').getAttribute('placeholder')).toBe('header');
    expect(screen.getByTestId('rest-query-new-value').getAttribute('placeholder')).toBe('contents');
  });
});
