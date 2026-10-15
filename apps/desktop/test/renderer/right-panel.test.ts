import { describe, expect, it } from 'vitest';
import { rightPanelFor } from '../../src/renderer/shell/right-panel.js';

describe('rightPanelFor', () => {
  it('keeps Code where requests are', () => {
    expect(rightPanelFor('explorer')).toBe('code');
    expect(rightPanelFor('history')).toBe('code');
  });

  it('gives SSH its host details and Environments its environment details', () => {
    expect(rightPanelFor('ssh')).toBe('host-details');
    expect(rightPanelFor('environments')).toBe('environment-details');
  });
});
