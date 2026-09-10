import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutlineView } from '../../src/renderer/features/request-editor/views/outline-view.js';
import type { DescribeManySource } from '../../src/renderer/features/request-editor/views/outline-view.js';

const CALCULATOR_ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Body>' +
  '<tem:Add id="1">' +
  '<tem:intA>1</tem:intA>' +
  '<tem:intB>2</tem:intB>' +
  '</tem:Add>' +
  '</soapenv:Body>' +
  '</soapenv:Envelope>';

function stubDescribe(map: Record<string, { typeName: string; kind: 'element' | 'attribute' }>) {
  const describeMany = vi.fn().mockImplementation(({ paths }: { paths: readonly (readonly string[])[] }) => {
    const results = paths.map((path) => {
      const key = path.join('>');
      return map[key] ?? null;
    });
    return Promise.resolve({ ok: true, value: { results } });
  });
  const source: DescribeManySource = { describeMany };
  return { source, describeMany };
}

describe('OutlineView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders element and attribute rows', () => {
    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly={false} />);

    expect(screen.getByText('soapenv:Envelope')).toBeDefined();
    expect(screen.getByText('soapenv:Body')).toBeDefined();
    expect(screen.getByText('tem:Add')).toBeDefined();
    expect(screen.getByText('tem:intA')).toBeDefined();
    expect(screen.getByText('tem:intB')).toBeDefined();
    expect(screen.getByText('@id')).toBeDefined();
  });

  it('commits an inline value edit via onEdit with the exact text range', async () => {
    const onEdit = vi.fn();
    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly={false} onEdit={onEdit} />);

    const intARow = document.querySelector('[data-row-id="0/0/0/0"]') as HTMLElement;
    const intAValue = within(intARow).getByRole('button', { name: '1' });
    await userEvent.click(intAValue);
    const input = within(intARow).getByDisplayValue('1');
    await userEvent.clear(input);
    await userEvent.type(input, '5');
    await userEvent.keyboard('{Enter}');

    expect(onEdit).toHaveBeenCalledTimes(1);
    const [range, value] = onEdit.mock.calls[0] as [{ start: number; end: number }, string];
    expect(value).toBe('5');
    expect(CALCULATOR_ENVELOPE.slice(range.start, range.end)).toBe('1');
  });

  it('cancels an inline edit on Escape without calling onEdit', async () => {
    const onEdit = vi.fn();
    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly={false} onEdit={onEdit} />);

    const intARow = document.querySelector('[data-row-id="0/0/0/0"]') as HTMLElement;
    const intAValue = within(intARow).getByRole('button', { name: '1' });
    await userEvent.click(intAValue);
    const input = within(intARow).getByDisplayValue('1');
    await userEvent.type(input, '9');
    await userEvent.keyboard('{Escape}');

    expect(onEdit).not.toHaveBeenCalled();
    expect(within(intARow).getByRole('button', { name: '1' })).toBeDefined();
  });

  it('renders no editable inputs in read-only (response) mode', () => {
    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly />);

    expect(screen.queryAllByRole('button', { name: '1' })).toHaveLength(0);
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('fills the Type column from a batched xml.describeMany call', async () => {
    const { source: describeSource, describeMany } = stubDescribe({
      '{http://schemas.xmlsoap.org/soap/envelope/}Envelope': { typeName: '', kind: 'element' },
      '{http://schemas.xmlsoap.org/soap/envelope/}Envelope>{http://schemas.xmlsoap.org/soap/envelope/}Body': {
        typeName: '',
        kind: 'element',
      },
      '{http://schemas.xmlsoap.org/soap/envelope/}Envelope>{http://schemas.xmlsoap.org/soap/envelope/}Body>{http://tempuri.org/}Add':
        { typeName: '', kind: 'element' },
      '{http://schemas.xmlsoap.org/soap/envelope/}Envelope>{http://schemas.xmlsoap.org/soap/envelope/}Body>{http://tempuri.org/}Add>{http://tempuri.org/}intA':
        { typeName: '{http://www.w3.org/2001/XMLSchema}int', kind: 'element' },
      '{http://schemas.xmlsoap.org/soap/envelope/}Envelope>{http://schemas.xmlsoap.org/soap/envelope/}Body>{http://tempuri.org/}Add>{http://tempuri.org/}intB':
        { typeName: '{http://www.w3.org/2001/XMLSchema}int', kind: 'element' },
    });

    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly interfaceId="if-1" describeSource={describeSource} />);

    await waitFor(() => {
      expect(describeMany).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getAllByText('{http://www.w3.org/2001/XMLSchema}int').length).toBe(2);
    });
  });

  it('shows an empty/problem state for unparsable input', () => {
    render(<OutlineView xml={''} readOnly />);
    expect(screen.getByText(/Nothing to show/i)).toBeDefined();
  });

  it('collapses and re-expands a subtree', async () => {
    render(<OutlineView xml={CALCULATOR_ENVELOPE} readOnly />);

    expect(screen.getByText('tem:Add')).toBeDefined();
    const collapseBody = screen.getByRole('button', { name: 'Collapse soapenv:Body' });
    await userEvent.click(collapseBody);
    expect(screen.queryByText('tem:Add')).toBeNull();

    const expandBody = screen.getByRole('button', { name: 'Expand soapenv:Body' });
    await userEvent.click(expandBody);
    expect(screen.getByText('tem:Add')).toBeDefined();
  });
});
