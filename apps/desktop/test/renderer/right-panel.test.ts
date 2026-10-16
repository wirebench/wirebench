import { describe, expect, it } from 'vitest';
import { rightPanelFor } from '../../src/renderer/shell/right-panel.js';

const TABS = [
  { id: 'r', kind: 'rest-request' },
  { id: 'h', kind: 'history' },
  { id: 'e', kind: 'environment' },
];

describe('rightPanelFor', () => {
  it('keeps Code where requests are, History entries included', () => {
    expect(rightPanelFor({ displayedSet: 'explorer', tabs: TABS, activeId: 'r' })).toBe('code');
    expect(rightPanelFor({ displayedSet: 'explorer', tabs: TABS, activeId: 'h' })).toBe('code');
    expect(rightPanelFor({ displayedSet: 'explorer', tabs: TABS, activeId: undefined })).toBe('code');
  });

  it('gives SSH its host details and an environment tab its environment details', () => {
    expect(rightPanelFor({ displayedSet: 'ssh', tabs: TABS, activeId: undefined })).toBe('host-details');
    expect(rightPanelFor({ displayedSet: 'explorer', tabs: TABS, activeId: 'e' })).toBe('environment-details');
  });
});
