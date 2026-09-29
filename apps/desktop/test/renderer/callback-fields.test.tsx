import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { AssertionTable } from '../../src/renderer/features/sequence/assertion-table.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import type { CatchUrlWire, StepAssertionWire } from '../../src/shared/wire-types.js';

type Callback = Extract<StepAssertionWire, { type: 'callback' }>;
const CALLBACK: Callback = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 30_000,
  match: { method: 'POST' },
  expect: [{ body: { language: 'jsonpath', path: '$', exists: true } }],
};

function mount(assertions: StepAssertionWire[]) {
  const onChange = vi.fn();
  render(
    <TooltipPrimitive.Provider>
      <AssertionTable assertions={assertions} onChange={onChange} />
    </TooltipPrimitive.Provider>,
  );
  return onChange;
}

const commit = (testId: string, value: string): void => {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

afterEach(() => {
  cleanup();
  useWebhooksStore.setState({ hooks: [] });
});

describe('the Callback assertion kind (callback-assertion §5)', () => {
  it('starts from the first known catch URL, 30 s and POST', () => {
    useWebhooksStore.setState({ hooks: [{ id: 'H1', name: 'orders-hook' } as CatchUrlWire] });
    const onChange = mount([{ type: 'status', equals: 200 }]);
    fireEvent.change(screen.getByTestId('sequence-assertion-kind'), { target: { value: 'callback' } });
    expect(onChange).toHaveBeenLastCalledWith([CALLBACK]);
  });

  it('falls back to a placeholder name when no catch URL is known', () => {
    const onChange = mount([{ type: 'status', equals: 200 }]);
    fireEvent.change(screen.getByTestId('sequence-assertion-kind'), { target: { value: 'callback' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, catchUrl: 'catch-url' }]);
  });

  it('edits the catch URL, the wait, the method and the path', () => {
    const onChange = mount([CALLBACK]);
    commit('sequence-callback-catch-url', 'refunds-hook');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, catchUrl: 'refunds-hook' }]);
    commit('sequence-callback-within', '5');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, withinMs: 5_000 }]);
    fireEvent.change(screen.getByTestId('sequence-callback-method'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: {} }]);
    commit('sequence-callback-path', '/events/.*');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: { method: 'POST', path: '/events/.*' } }]);
  });

  it('turns an exact path into a pattern', () => {
    const onChange = mount([{ ...CALLBACK, match: { method: 'POST', path: '/events/.*' } }]);
    fireEvent.click(screen.getByTestId('sequence-callback-path-regex'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: { method: 'POST', pathMatches: '/events/.*' } }]);
  });

  it('adds a header match and edits the expected body value', () => {
    const onChange = mount([CALLBACK]);
    fireEvent.click(screen.getByTestId('sequence-callback-add-header'));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, match: { method: 'POST', headers: [{ name: 'Content-Type', exists: true }] } },
    ]);
    commit('sequence-callback-expect-row-path', '$.status');
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, expect: [{ body: { language: 'jsonpath', path: '$.status', exists: true } }] },
    ]);
    fireEvent.change(screen.getByTestId('sequence-callback-expect-row-check'), { target: { value: 'equals' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, expect: [{ body: { language: 'jsonpath', path: '$', equals: '' } }] },
    ]);
  });

  it('checks the signature', () => {
    const onChange = mount([CALLBACK]);
    fireEvent.change(screen.getByTestId('sequence-callback-expect-kind'), { target: { value: 'signature' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, expect: [{ signature: 'verified' }] }]);
  });

  it('labels its fields as the spec names them', () => {
    mount([CALLBACK]);
    const label = (testId: string): string | null => screen.getByTestId(testId).getAttribute('aria-label');
    expect(label('sequence-callback-catch-url')).toBe('Catch URL');
    expect(label('sequence-callback-within')).toBe('Within (s)');
    expect(label('sequence-callback-method')).toBe('Method');
    expect(label('sequence-callback-path')).toBe('Path');
    expect(label('sequence-callback-expect-kind')).toBe('Expect');
    expect(screen.getByLabelText('Regex')).toBe(screen.getByTestId('sequence-callback-path-regex'));
  });

  it('stops adding header matches and checks at the engine limits', () => {
    const header = { name: 'X-Event', exists: true };
    const check = { header: { name: 'X-Event', exists: true } };
    mount([
      {
        ...CALLBACK,
        match: { method: 'POST', headers: Array.from({ length: 20 }, () => header) },
        expect: Array.from({ length: 20 }, () => check),
      },
    ]);
    expect(screen.getByTestId('sequence-callback-add-header')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('sequence-callback-add-expect')).toHaveProperty('disabled', true);
  });

  it('can still add a header match and a check below the limits', () => {
    mount([CALLBACK]);
    expect(screen.getByTestId('sequence-callback-add-header')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('sequence-callback-add-expect')).toHaveProperty('disabled', false);
  });

  it('gives each catch URL input its own suggestion list', () => {
    mount([CALLBACK, { ...CALLBACK, catchUrl: 'refunds-hook' }]);
    const inputs = screen.getAllByTestId('sequence-callback-catch-url');
    const lists = screen.getAllByTestId('sequence-callback-catch-urls');
    expect(lists).toHaveLength(2);
    expect(new Set(lists.map((list) => list.id)).size).toBe(2);
    expect(inputs.map((input) => input.getAttribute('list'))).toEqual(lists.map((list) => list.id));
  });
});
