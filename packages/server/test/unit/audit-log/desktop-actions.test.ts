import { AUDIT_ACTION_GROUPS, AUDIT_ACTIONS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';

describe('desktop audit actions (#211)', () => {
  it('are in the closed list under the desktop group', () => {
    for (const action of [
      'workspace.desktop_recording_changed',
      'desktop.request_sent',
      'desktop.run_finished',
      'desktop.events_dropped',
    ] as const) {
      expect(AUDIT_ACTIONS).toContain(action);
    }
    expect(AUDIT_ACTION_GROUPS).toContain('desktop');
  });
});
