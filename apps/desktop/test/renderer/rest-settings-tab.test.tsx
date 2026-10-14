/**
 * The REST request's Settings tab (#560): an unset field shows the value it inherits as its
 * placeholder, says where that value comes from and opens it, and an overridden on/off row can go
 * back to inheriting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsTab, type InheritedRestSettings } from '../../src/renderer/features/rest-editor/settings-tab.js';
import type { RestSettingsWire } from '../../src/shared/kinds/rest/wire.js';

const INHERITED: InheritedRestSettings = {
  timeoutMs: 45_000,
  followRedirects: true,
  maxRedirects: 7,
  encodeUrl: true,
  sendCookies: false,
};

afterEach(() => cleanup());

function mount(settings: RestSettingsWire = {}) {
  const onChange = vi.fn();
  const onOpenSource = vi.fn();
  render(<SettingsTab settings={settings} inherited={INHERITED} onChange={onChange} onOpenSource={onOpenSource} />);
  return { onChange, onOpenSource };
}

describe('SettingsTab', () => {
  it('shows each inherited number as the empty field’s placeholder', () => {
    mount();
    const timeout = screen.getByTestId<HTMLInputElement>('rest-setting-timeout');
    expect(timeout.value).toBe('');
    expect(timeout.placeholder).toBe('45000');
    expect(screen.getByTestId<HTMLInputElement>('rest-setting-max-redirects').placeholder).toBe('7');
    expect(screen.getByTestId<HTMLInputElement>('rest-setting-max-size').placeholder).toBe('No limit');
  });

  it('says where each inherited value comes from, and opens it', () => {
    const { onOpenSource } = mount();
    const timeout = screen.getByTestId('rest-setting-timeout-source');
    expect(timeout.textContent).toBe('from Project settings');
    fireEvent.click(timeout);
    expect(onOpenSource).toHaveBeenLastCalledWith('project');

    for (const id of ['rest-setting-max-redirects-source', 'rest-setting-follow-redirects-source']) {
      const link = screen.getByTestId(id);
      expect(link.textContent).toBe('from Preferences ▸ REST');
      fireEvent.click(link);
      expect(onOpenSource).toHaveBeenLastCalledWith('preferences-rest');
    }
  });

  it('names a built-in default as text, with nothing to open', () => {
    mount();
    const source = screen.getByTestId('rest-setting-encode-url-source');
    expect(source.textContent).toBe('from the default');
    expect(source.tagName).toBe('SPAN');
  });

  it('drops the source once the request sets its own value', () => {
    mount({ timeoutMs: 1000 });
    expect(screen.getByTestId<HTMLInputElement>('rest-setting-timeout').value).toBe('1000');
    expect(screen.queryByTestId('rest-setting-timeout-source')).toBeNull();
  });

  it('lets an overridden on/off row inherit again', () => {
    const { onChange } = mount({ followRedirects: false, timeoutMs: 1000 });
    expect(screen.queryByTestId('rest-setting-follow-redirects-source')).toBeNull();
    fireEvent.click(screen.getByTestId('rest-setting-follow-redirects-inherit'));
    expect(onChange).toHaveBeenCalledWith({ settings: { timeoutMs: 1000 } });
  });
});
