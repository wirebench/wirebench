import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CookieManager } from '../../src/renderer/features/cookies/cookie-manager.js';
import { useCookiesStore } from '../../src/renderer/state/cookies.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CookieJarStateWire, StoredCookieWire } from '../../src/shared/wire-types.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');

function stored(name: string, domain: string, extra: Partial<StoredCookieWire> = {}): StoredCookieWire {
  return {
    name,
    value: `${name}-secret`,
    domain,
    hostOnly: false,
    path: '/',
    secure: false,
    httpOnly: false,
    createdAt: NOW,
    ...extra,
  };
}

const JAR: CookieJarStateWire = {
  cookies: [
    stored('sid', 'api.test', { hostOnly: true, secure: true, expiresAt: NOW + 3_600_000 }),
    stored('lang', 'api.test'),
    stored('o', 'other.test'),
  ],
  persisted: true,
};
const EMPTY: CookieJarStateWire = { cookies: [], persisted: true };

function answering(value: CookieJarStateWire) {
  return vi.fn().mockResolvedValue({ ok: true, value });
}

function mount(state: CookieJarStateWire = JAR, channels: Record<string, unknown> = {}, on?: unknown): void {
  installWirebenchApi({
    cookies: { list: answering(state), ...channels },
    ...(on !== undefined ? { on: on as never } : {}),
  });
  render(
    <TooltipPrimitive.Provider>
      <CookieManager />
    </TooltipPrimitive.Provider>,
  );
}

async function rows(count: number): Promise<HTMLElement[]> {
  await waitFor(() => {
    expect(screen.getAllByTestId('cookie-row')).toHaveLength(count);
  });
  return screen.getAllByTestId('cookie-row');
}

afterEach(() => {
  cleanup();
  useCookiesStore.setState({ cookies: [], persisted: true });
});

describe('CookieManager', () => {
  it('groups by domain, sorts by domain and then name, and tags a host-only cookie', async () => {
    mount();
    const [lang, sid, other] = await rows(3);
    expect(screen.getAllByTestId('cookie-domain-group').map((group) => group.textContent)).toEqual([
      expect.stringContaining('api.test'),
      expect.stringContaining('other.test'),
    ]);
    expect(lang?.textContent).toContain('lang');
    expect(sid?.textContent).toContain('sid');
    expect(other?.textContent).toContain('o');
    expect(within(sid!).getByTestId('cookie-host-only').textContent).toBe('host only');
    expect(within(lang!).queryByTestId('cookie-host-only')).toBeNull();
    expect(within(lang!).getByTestId('cookie-expires').textContent).toBe('Session');
    expect(within(sid!).getByTestId('cookie-expires').textContent).toBe(new Date(NOW + 3_600_000).toLocaleString());
  });

  it('masks values until Show values, and edits a value in place', async () => {
    const set = answering(JAR);
    mount(JAR, { set });
    await rows(3);
    expect(screen.queryByText('sid-secret')).toBeNull();
    expect(screen.queryAllByTestId('cookie-value')).toHaveLength(0);

    fireEvent.click(screen.getByTestId('cookie-show-values'));
    const value = screen.getByLabelText<HTMLInputElement>('Value of sid');
    expect(value.value).toBe('sid-secret');
    fireEvent.change(value, { target: { value: 'changed' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({ cookie: { ...JAR.cookies[0], value: 'changed' } });
    });
  });

  it('deletes a cookie, and every cookie of a domain', async () => {
    const remove = answering(JAR);
    const removeDomain = answering(JAR);
    mount(JAR, { remove, removeDomain });
    await rows(3);
    fireEvent.click(screen.getByRole('button', { name: 'Delete sid' }));
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ key: { name: 'sid', domain: 'api.test', path: '/' } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete all for other.test' }));
    await waitFor(() => {
      expect(removeDomain).toHaveBeenCalledWith({ domain: 'other.test' });
    });
  });

  it('clears all only after a confirmation that names the count', async () => {
    const clear = answering(EMPTY);
    mount(JAR, { clear });
    await rows(3);
    fireEvent.click(screen.getByTestId('cookie-clear-all'));
    expect(screen.getByTestId('cookie-clear-confirm').textContent).toContain('all 3 cookies');
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('cookie-clear-confirm-ok'));
    await waitFor(() => {
      expect(screen.getByTestId('cookie-empty')).toBeTruthy();
    });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('says when cookies are kept for this session only, and what an empty jar means', async () => {
    mount({ cookies: [], persisted: false });
    await waitFor(() => {
      expect(screen.getByTestId('cookie-persistence-note').textContent).toBe(
        'Cookies are kept for this session only: this system has no secure storage.',
      );
    });
    expect(screen.getByTestId('cookie-empty').textContent).toBe(
      'No cookies yet. Responses store cookies here; a request sends them when its Send cookies setting is on.',
    );
  });

  it('follows cookies.changed, so a send updates the tab live', async () => {
    let listener: ((payload: unknown) => void) | undefined;
    const on = vi.fn((name: string, callback: (payload: unknown) => void) => {
      if (name === 'cookies.changed') {
        listener = callback;
      }
      return () => undefined;
    });
    mount(EMPTY, {}, on);
    await waitFor(() => {
      expect(listener).toBeDefined();
    });
    act(() => {
      listener?.(JAR);
    });
    expect(screen.getAllByTestId('cookie-row')).toHaveLength(3);
  });

  it('adds a cookie through the dialog', async () => {
    const set = answering(JAR);
    mount(EMPTY, { set });
    fireEvent.click(screen.getByTestId('cookie-add'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'abc' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: '.API.test' } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    await waitFor(() => {
      expect(set).toHaveBeenCalledOnce();
    });
    const request = set.mock.calls[0]?.[0] as { cookie: StoredCookieWire; replaces?: unknown };
    expect(request.cookie).toMatchObject({
      name: 'token',
      value: 'abc',
      domain: 'api.test',
      path: '/',
      hostOnly: true,
      secure: false,
      httpOnly: false,
    });
    expect(request.cookie.expiresAt).toBeUndefined();
    expect(request.replaces).toBeUndefined();
  });

  it('moves a cookie to another path through the dialog, replacing the old one', async () => {
    const set = answering(JAR);
    mount(JAR, { set });
    await rows(3);
    fireEvent.click(screen.getByRole('button', { name: 'Edit lang' }));
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: '/v2' } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    await waitFor(() => {
      expect(set).toHaveBeenCalledWith({
        cookie: { ...JAR.cookies[1], path: '/v2' },
        replaces: { name: 'lang', domain: 'api.test', path: '/' },
      });
    });
  });

  it.each([
    ['a name with a semicolon', 'Name', 'a;b', 'cookie-error-name'],
    ['a name with an equals sign', 'Name', 'a=b', 'cookie-error-name'],
    ['a name with whitespace', 'Name', 'a b', 'cookie-error-name'],
    ['an empty name', 'Name', '', 'cookie-error-name'],
    ['a value with a semicolon', 'Value', 'a;b', 'cookie-error-value'],
    ['a value with a NUL', 'Value', 'a\0b', 'cookie-error-value'],
    ['a path without a leading slash', 'Path', 'v2', 'cookie-error-path'],
    ['a name and value over 4096 bytes', 'Value', 'x'.repeat(4097), 'cookie-error-value'],
  ])('refuses %s with a field error and sends nothing', (_title, label, text, errorId) => {
    const set = answering(JAR);
    mount(EMPTY, { set });
    fireEvent.click(screen.getByTestId('cookie-add'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'api.test' } });
    fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    expect(screen.getByTestId(errorId)).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });

  it('needs a domain', () => {
    const set = answering(JAR);
    mount(EMPTY, { set });
    fireEvent.click(screen.getByTestId('cookie-add'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'token' } });
    fireEvent.click(screen.getByTestId('cookie-dialog-save'));
    expect(screen.getByTestId('cookie-error-domain')).toBeTruthy();
    expect(set).not.toHaveBeenCalled();
  });
});
