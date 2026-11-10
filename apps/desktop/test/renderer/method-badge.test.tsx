/**
 * The method chip. The mapping is the contract: the explorer, history and the URL bar all render
 * this one component, and `pnpm contrast:check` gates the four tints it names.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { MethodBadge, methodColorClass, methodTint } from '../../src/renderer/features/rest-api/method-badge.js';

afterEach(() => {
  cleanup();
});

describe('methodColorClass', () => {
  it('tints a method by what it does: reads, writes and deletes', () => {
    expect(['GET', 'HEAD', 'OPTIONS'].map(methodColorClass)).toEqual([
      'text-method-read',
      'text-method-read',
      'text-method-read',
    ]);
    expect(['POST', 'PUT', 'PATCH'].map(methodColorClass)).toEqual([
      'text-method-write',
      'text-method-write',
      'text-method-write',
    ]);
    expect(methodColorClass('DELETE')).toBe('text-method-delete');
  });

  it('falls back to the neutral colour for a custom method', () => {
    expect(methodColorClass('PURGE')).toBe('text-method-other');
    expect(methodColorClass('PROPFIND')).toBe('text-method-other');
    expect(methodTint('TRACE')).toBe('other');
  });

  it('does not care how the method was typed', () => {
    expect(methodColorClass('get')).toBe('text-method-read');
    expect(methodColorClass('Delete')).toBe('text-method-delete');
  });
});

describe('MethodBadge', () => {
  it('renders the method uppercased, with its colour and the method in a data attribute', () => {
    render(<MethodBadge method="post" />);

    const badge = screen.getByTestId('method-badge');
    expect(badge.textContent).toBe('POST');
    expect(badge.getAttribute('data-method')).toBe('POST');
    expect(badge.getAttribute('data-tint')).toBe('write');
    expect(badge.className).toContain('text-method-write');
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
      ['PATCH', 'PAT'],
      ['OPTIONS', 'OPT'],
      ['PROPFIND', 'PRO…'],
    ] as const) {
      render(<MethodBadge method={method} compact />);
      expect(screen.getByTestId('method-badge').textContent).toBe(shown);
      cleanup();
    }
  });

  it('gives every compact badge one fixed width, left-aligned, so GET, POST and DEL line up (#633)', () => {
    const classes = ['GET', 'POST', 'DELETE'].map((method) => {
      render(<MethodBadge method={method} compact />);
      const className = screen.getByTestId('method-badge').className;
      cleanup();
      return className;
    });
    for (const className of classes) {
      expect(className).toContain('w-[4ch]');
      expect(className).toContain('text-left');
      expect(className).not.toContain('w-auto');
    }
  });

  it('renders a filled chip when variant="chip" is requested', () => {
    render(<MethodBadge method="post" variant="chip" />);

    const badge = screen.getByTestId('method-badge');
    expect(badge.textContent).toBe('POST');
    expect(badge.className).toContain('bg-method-write');
    expect(badge.className).toContain('text-fg-on-accent');
  });
});
