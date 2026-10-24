/**
 * The project and API pages show one section at a time behind a tab. A test opens the tab its
 * fields are on, and forgets every page's remembered tab between tests so none leaks into the next.
 */
import { fireEvent, screen } from '@testing-library/react';
import { useSettingsPageTabStore } from '../../src/renderer/components/settings-page-tabs.js';

export function openSettingsTab(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name }));
}

export function resetSettingsTabs(): void {
  useSettingsPageTabStore.setState({ selected: {} });
}
