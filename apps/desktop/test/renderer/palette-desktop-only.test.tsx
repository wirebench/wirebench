/**
 * The palette's empty state in a browser tab (#905): a search that names only commands the tab leaves
 * out for want of a capability says they are in the desktop app, not just "No matching command."
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import { noCommandText } from '../../src/renderer/shell/command-palette.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function install(host: 'browser' | 'desktop'): void {
  const api = installWirebenchApi();
  if (host === 'browser') {
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
    });
  }
  registerShellCommands(() => undefined);
}

afterEach(() => resetCommands());

describe('noCommandText (#905)', () => {
  it('names the one desktop-only command a search finds', () => {
    install('browser');
    expect(noCommandText('updates')).toBe('Check for Updates… is in the desktop app.');
    expect(noCommandText('mock start')).toBe('Mock: Start is in the desktop app.');
  });

  it('says the commands are in the desktop app when a search names several', () => {
    install('browser');
    expect(noCommandText('mock')).toBe('These commands are in the desktop app.');
  });

  it('says so for an area the browser tab has switched off', () => {
    install('browser');
    resetCommands();
    // Nothing registered: the SSH area's commands are left out the way a browser tab leaves them out.
    expect(noCommandText('ssh')).toBe('These commands are in the desktop app.');
  });

  it('keeps the plain empty state for a search that names nothing', () => {
    install('browser');
    expect(noCommandText('qqqzzz')).toBe('No matching command.');
  });

  it('keeps the plain empty state on the desktop', () => {
    install('desktop');
    expect(noCommandText('mock')).toBe('No matching command.');
  });
});
