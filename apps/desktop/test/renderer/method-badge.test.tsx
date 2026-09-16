/**
 * The method chip. The mapping is the contract: the explorer, history and the URL bar all render
 * this one component, and `pnpm contrast:check` gates the six colours it names.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { MethodBadge, methodColorClass } from '../../src/renderer/features/rest-api/method-badge.js';

afterEach(() => {
  cleanup();
});

describe('methodColorClass', () => {
  it('gives each of the six documented methods its own colour', () => {
    const classes = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(methodColorClass);
    expect(classes).toEqual([
      'text-method-get',
      'text-method-post',
      'text-method-put',
      'text-method-patch',
      'text-method-delete',
    ]);
    expect(new Set(classes).size).toBe(5);
  });

  it('falls back to the neutral colour for anything else, including a custom method', () => {
    expect(methodColorClass('HEAD')).toBe('text-method-other');
    expect(methodColorClass('OPTIONS')).toBe('text-method-other');
    expect(methodColorClass('PURGE')).toBe('text-method-other');
  });

  it('does not care how the method was typed', () => {
    expect(methodColorClass('get')).toBe('text-method-get');
    expect(methodColorClass('Delete')).toBe('text-method-delete');
  });
});

describe('MethodBadge', () => {
  it('renders the method uppercased, with its colour and the method in a data attribute', () => {
    render(<MethodBadge method="post" />);

    const badge = screen.getByTestId('method-badge');
    expect(badge.textContent).toBe('POST');
    expect(badge.getAttribute('data-method')).toBe('POST');
    expect(badge.className).toContain('text-method-post');
  });

  it('renders a method this build has never heard of rather than hiding it', () => {
    render(<MethodBadge method="PROPFIND" />);

    const badge = screen.getByTestId('method-badge');
    // Cut short so one long custom method cannot push a tree row's name out of view.
    expect(badge.textContent).toBe('PROPFIN…');
    expect(badge.className).toContain('text-method-other');
  });

  it("carries the caller's title, for a row whose text alone would not say the method", () => {
    render(<MethodBadge method="GET" title="GET Get pet" />);
    expect(screen.getByTestId('method-badge').getAttribute('title')).toBe('GET Get pet');
  });

  it('spells long methods short in the compact column, and leaves the short ones alone', () => {
    render(<MethodBadge method="delete" compact />);
    expect(screen.getByTestId('method-badge').textContent).toBe('DEL');
    // The method itself is never lost: the attribute and the title still carry it in full.
    expect(screen.getByTestId('method-badge').getAttribute('data-method')).toBe('DELETE');
    cleanup();

    for (const [method, shown] of [
      ['GET', 'GET'],
      ['POST', 'POST'],
      ['PUT', 'PUT'],
      ['PATCH', 'PATCH'],
      ['OPTIONS', 'OPT'],
      ['PROPFIND', 'PROP…'],
    ] as const) {
      render(<MethodBadge method={method} compact />);
      expect(screen.getByTestId('method-badge').textContent).toBe(shown);
      cleanup();
    }
  });

  it('renders a filled chip when variant="chip" is requested', () => {
    render(<MethodBadge method="post" variant="chip" />);

    const badge = screen.getByTestId('method-badge');
    expect(badge.textContent).toBe('POST');
    expect(badge.className).toContain('bg-method-post');
    expect(badge.className).toContain('text-fg-on-accent');
  });
});
