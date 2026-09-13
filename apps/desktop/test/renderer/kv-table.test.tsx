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

    const value = screen.getByTestId('rest-query-value');
    fireEvent.change(value, { target: { value: 'oops' } });
    fireEvent.keyDown(value, { key: 'Escape' });

    expect((value as HTMLInputElement).value).toBe('1');
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

    expect((screen.getByTestId('rest-query-name') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByTestId('rest-query-value') as HTMLInputElement).readOnly).toBe(false);
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
