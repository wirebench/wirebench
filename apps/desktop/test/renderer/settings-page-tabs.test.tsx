import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsPageTabs, type SettingsPageTab } from '../../src/renderer/components/settings-page-tabs.js';
import { openSettingsTab, resetSettingsTabs } from '../helpers/settings-page-tabs.js';

const TABS: SettingsPageTab<'general' | 'auth'>[] = [
  { id: 'general', label: 'General', content: <p>General fields</p> },
  { id: 'auth', label: 'Authentication', content: <p>Auth fields</p> },
];

function mount(pageId: string, tabs = TABS): void {
  render(<SettingsPageTabs pageId={pageId} label="API settings" tabs={tabs} />);
}

beforeEach(() => {
  resetSettingsTabs();
});

afterEach(() => {
  cleanup();
});

describe('SettingsPageTabs', () => {
  it('shows the first tab, and one section at a time', () => {
    mount('api-1');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('General fields')).toBeTruthy();
    expect(screen.queryByText('Auth fields')).toBeNull();

    openSettingsTab('Authentication');
    expect(screen.getByText('Auth fields')).toBeTruthy();
    expect(screen.queryByText('General fields')).toBeNull();
  });

  it('keeps the tab a page was on when it is shown again, per page', () => {
    mount('api-1');
    openSettingsTab('Authentication');
    cleanup();

    mount('api-1');
    expect(screen.getByText('Auth fields')).toBeTruthy();
    cleanup();

    mount('api-2');
    expect(screen.getByText('General fields')).toBeTruthy();
  });

  it('falls back to the first tab when the remembered one is gone', () => {
    mount('api-1');
    openSettingsTab('Authentication');
    cleanup();

    mount('api-1', TABS.slice(0, 1));
    expect(screen.getByText('General fields')).toBeTruthy();
  });
});
