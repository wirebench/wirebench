/**
 * Variables in a request's plain fields (#340), through the key/value table and an auth-style input:
 * `${` completes from the keyboard, an unresolved name is underlined, a hover explains a reference
 * (never revealing a masked value), and Set as Variable replaces the selection — and outside a
 * request editor none of it is there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { KvTable } from '../../src/renderer/components/kv-table.js';
import {
  VariableAssistContext,
  VariableInput,
  type VariableAssist,
} from '../../src/renderer/components/variable-field.js';
import type { RequestVariables } from '../../src/renderer/editor/variable-assist.js';
import type { KeyValueWire } from '@wirebench/wire/wire-base';

afterEach(() => {
  cleanup();
});

const variables: RequestVariables = {
  entries: [
    {
      name: 'host',
      scope: 'Env',
      value: 'dev.example',
      masked: false,
      shadowed: false,
      edit: { kind: 'environment', id: 'e1' },
    },
    { name: 'apiKey', scope: 'Project', masked: true, secretName: 'api_key', shadowed: false },
  ],
  secretNames: [],
};

function assist(overrides: Partial<VariableAssist> = {}): VariableAssist {
  return { variables, setAsVariable: vi.fn(), openEdit: vi.fn(), ...overrides };
}

function mountTable(rows: readonly KeyValueWire[], context: VariableAssist | 'none' = assist()) {
  const onChange = vi.fn();
  const table = (
    <TooltipPrimitive.Provider>
      <KvTable label="Headers" rows={rows} onChange={onChange} testidPrefix="h" />
    </TooltipPrimitive.Provider>
  );
  renderBare(
    context === 'none' ? (
      table
    ) : (
      <VariableAssistContext.Provider value={context}>{table}</VariableAssistContext.Provider>
    ),
  );
  return { onChange };
}

const row = (name: string, value: string): KeyValueWire => ({ name, value, enabled: true });

/** Types `text` into `field` as one input event, the caret left at its end. */
function type(field: HTMLElement, text: string): void {
  fireEvent.input(field, { target: { value: text } });
}

describe('a key/value cell inside a request editor', () => {
  it('underlines an unresolved reference where it is written, and only that one', () => {
    mountTable([row('X-Host', '${host}/${hots}')]);
    const marks = document.querySelectorAll('[data-variable-start]');
    expect([...marks].map((mark) => [mark.textContent, mark.getAttribute('data-unresolved')])).toEqual([
      ['${host}', null],
      ['${hots}', 'true'],
    ]);
  });

  it('completes ${ from the keyboard, and the cell commits only when the edit does', () => {
    const { onChange } = mountTable([row('X-Host', '')]);
    const value = screen.getByTestId('h-value');
    value.focus();
    type(value, 'https://${ho');
    const list = screen.getByRole('listbox', { name: 'Variables' });
    expect([...list.querySelectorAll('[role=option]')].map((option) => option.textContent)).toEqual([
      expect.stringContaining('host'),
    ]);
    expect(value.getAttribute('aria-activedescendant')).toBe(list.querySelector('[role=option]')?.id);

    fireEvent.keyDown(value, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((value as HTMLTextAreaElement).value).toBe('https://${host}');
    // Accepting is not committing: Enter here went to the list.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(value);
    expect(onChange).toHaveBeenCalledWith([row('X-Host', 'https://${host}')]);
  });

  it('completes a dynamic value after ${$, and leaves a known one unmarked', () => {
    mountTable([row('X-Id', '${$guid}/${$nope}')]);
    const marks = document.querySelectorAll('[data-variable-start]');
    expect([...marks].map((mark) => [mark.textContent, mark.getAttribute('data-unresolved')])).toEqual([
      ['${$guid}', null],
      ['${$nope}', 'true'],
    ]);
    cleanup();

    mountTable([row('X-Id', '')]);
    const value = screen.getByTestId('h-value');
    value.focus();
    type(value, '${$gu');
    fireEvent.keyDown(value, { key: 'Enter' });
    expect((value as HTMLTextAreaElement).value).toBe('${$guid}');
  });

  it('closes the list on Escape without reverting the cell', () => {
    mountTable([row('X-Host', '')]);
    const value = screen.getByTestId('h-value');
    value.focus();
    type(value, '${');
    expect(screen.getByRole('listbox')).toBeDefined();
    fireEvent.keyDown(value, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect((value as HTMLTextAreaElement).value).toBe('${');
    // A second Escape, with no list open, is the cell's own: it puts the row back.
    fireEvent.keyDown(value, { key: 'Escape' });
    expect((value as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps a header typed through the add row when Escape closes its list, and commits it on blur', async () => {
    function Headers() {
      const [rows, setRows] = useState<readonly KeyValueWire[]>([row('X-Host', '')]);
      return (
        <VariableAssistContext.Provider value={assist()}>
          <TooltipPrimitive.Provider>
            <KvTable label="Headers" rows={rows} onChange={setRows} testidPrefix="h" />
            <output data-testid="committed">{rows.map((entry) => entry.value).join('|')}</output>
          </TooltipPrimitive.Provider>
        </VariableAssistContext.Provider>
      );
    }
    renderBare(<Headers />);

    await userEvent.click(screen.getByTestId('h-value'));
    await userEvent.keyboard('https://${{ho');
    expect(screen.getByRole('listbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId<HTMLTextAreaElement>('h-value').value).toBe('https://${ho');
    await userEvent.tab();
    expect(screen.getByTestId('committed').textContent).toBe('https://${ho');
  });

  it('hovers a reference with its value, and a masked one without it', () => {
    vi.useFakeTimers();
    try {
      mountTable([row('Authorization', '${apiKey} ${host}')]);
      const marks = [...document.querySelectorAll<HTMLElement>('[data-variable-start]')];
      marks.forEach((mark, index) => {
        mark.getClientRects = () => [{ left: index * 100, right: index * 100 + 90, top: 0, bottom: 20 }] as never;
      });
      const wrapper = screen.getByTestId('h-value').parentElement!;

      fireEvent.mouseMove(wrapper, { clientX: 10, clientY: 10 });
      const card = screen.getByTestId('variable-hover');
      expect(card.textContent).toContain('••••••  (secret api_key)');
      expect(card.textContent).not.toContain('Edit in');

      fireEvent.mouseMove(wrapper, { clientX: 110, clientY: 10 });
      expect(screen.getByTestId('variable-hover').textContent).toContain('dev.example');
      expect(screen.getByRole('button', { name: 'Edit in Environment' })).toBeDefined();

      fireEvent.mouseLeave(wrapper);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByTestId('variable-hover')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the variable’s scope from the hover’s Edit link', () => {
    const openEdit = vi.fn();
    mountTable([row('X-Host', '${host}')], assist({ openEdit }));
    const mark = document.querySelector<HTMLElement>('[data-variable-start]')!;
    mark.getClientRects = () => [{ left: 0, right: 90, top: 0, bottom: 20 }] as never;
    fireEvent.mouseMove(screen.getByTestId('h-value').parentElement!, { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Environment' }));
    expect(openEdit).toHaveBeenCalledWith({ kind: 'environment', id: 'e1' });
  });

  it('offers Set as Variable on a selection, and commits the reference put over it', () => {
    const setAsVariable = vi.fn();
    const { onChange } = mountTable([row('Authorization', 'Bearer abc123')], assist({ setAsVariable }));
    const value = screen.getByTestId<HTMLTextAreaElement>('h-value');
    value.setSelectionRange(7, 13);
    fireEvent.contextMenu(value);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as Variable…' }));
    expect(setAsVariable).toHaveBeenCalledWith('abc123', expect.any(Function));

    act(() => {
      (setAsVariable.mock.lastCall![1] as (reference: string) => void)('${token}');
    });
    expect(onChange).toHaveBeenCalledWith([row('Authorization', 'Bearer ${token}')]);
  });

  it('leaves a right-click with nothing selected alone', () => {
    mountTable([row('Authorization', 'Bearer abc123')]);
    const value = screen.getByTestId<HTMLTextAreaElement>('h-value');
    value.setSelectionRange(3, 3);
    expect(fireEvent.contextMenu(value)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('outside a request editor', () => {
  it('is a plain table: no completion, no marks', () => {
    mountTable([row('X-Host', '${hots}')], 'none');
    const value = screen.getByTestId('h-value');
    expect(value.getAttribute('aria-autocomplete')).toBeNull();
    expect(document.querySelector('[data-unresolved]')).toBeNull();
    value.focus();
    type(value, '${');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('VariableInput', () => {
  it('draws its references at rest and hands completions to the caller', () => {
    const onValueChange = vi.fn();
    function Field() {
      const [value, setValue] = useState('${hots}');
      return (
        <VariableInput
          aria-label="Username"
          className="px-2"
          value={value}
          onValueChange={(next) => {
            onValueChange(next);
            setValue(next);
          }}
        />
      );
    }
    renderBare(
      <VariableAssistContext.Provider value={assist()}>
        <Field />
      </VariableAssistContext.Provider>,
    );
    expect(document.querySelector('[data-unresolved]')?.textContent).toBe('${hots}');
    const input = screen.getByRole('textbox', { name: 'Username' });
    fireEvent.focus(input);
    // Focused, the real text shows and the mirror goes.
    expect(document.querySelector('[data-unresolved]')).toBeNull();
    type(input, '${#Env#h');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onValueChange).toHaveBeenLastCalledWith('${#Env#host}');
  });
});

describe('the URL bar field', () => {
  it('keeps its segments and underlines the unresolved reference among them', async () => {
    const { PropertyHighlightInput } =
      await import('../../src/renderer/features/rest-editor/property-highlight-input.js');
    renderBare(
      <VariableAssistContext.Provider value={assist()}>
        <PropertyHighlightInput
          ariaLabel="Request URL"
          testId="url"
          value="${host}/pets/{id}?k=${hots}"
          onChange={vi.fn()}
        />
      </VariableAssistContext.Provider>,
    );
    const spans = [...screen.getByTestId('url-highlight').children];
    expect(spans.map((span) => [span.getAttribute('data-kind'), span.getAttribute('data-unresolved')])).toEqual([
      ['property', null],
      ['plain', null],
      ['param', null],
      ['plain', null],
      ['property', 'true'],
    ]);
    expect(spans[4]?.getAttribute('data-variable-start')).toBe('20');
  });
});
