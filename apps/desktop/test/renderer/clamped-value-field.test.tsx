/**
 * The folding value field the header grids use: two clamped lines at rest, the whole value while
 * focused, Enter saving instead of breaking the line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClampedValueField } from '../../src/renderer/components/clamped-value-field.js';

const LONG = `Bearer ${'x'.repeat(400)}`;

function field(overrides: Partial<React.ComponentProps<typeof ClampedValueField>> = {}) {
  return (
    <ClampedValueField aria-label="Value" className="h-row w-full" value={LONG} onChange={vi.fn()} {...overrides} />
  );
}

describe('ClampedValueField', () => {
  afterEach(() => {
    cleanup();
  });

  it('folds to a two-line clamped copy at rest, with the whole value on hover', () => {
    const { container } = render(field());
    const area = screen.getByRole('textbox', { name: 'Value' });
    expect(area.tagName).toBe('TEXTAREA');
    expect(area.style.color).toBe('transparent');
    expect(area.className).not.toMatch(/(^|\s)h-row(\s|$)/);
    expect(area.getAttribute('title')).toBe(LONG);
    const copy = container.querySelector('[aria-hidden="true"]');
    expect(copy?.className).toContain('line-clamp-2');
    expect(copy?.textContent).toBe(LONG);
  });

  it('shows the whole value while focused and folds again on blur', () => {
    const onBlur = vi.fn();
    const { container } = render(field({ onBlur }));
    const area = screen.getByRole('textbox', { name: 'Value' });

    fireEvent.focus(area);
    expect(area.style.color).toBe('');
    expect(area.hasAttribute('title')).toBe(false);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();

    fireEvent.blur(area);
    expect(onBlur).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('saves on Enter rather than adding a line break', () => {
    const onKeyDown = vi.fn();
    render(field({ onKeyDown }));
    const area = screen.getByRole('textbox', { name: 'Value' });
    const allowed = fireEvent.keyDown(area, { key: 'Enter' });
    expect(allowed).toBe(false);
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});
