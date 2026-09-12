import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SaveIndicator } from '../../src/renderer/features/project/save-indicator.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

/** The renderer's mirror of one project, with only the fields the indicator reads varying. */
function mirror(patch: { readonly dirty?: boolean; readonly lastSavedAt?: string }) {
  return {
    id: 'p1',
    name: 'Calculator',
    dir: '/w/p1',
    settings: PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    dirty: patch.dirty ?? false,
    ...(patch.lastSavedAt === undefined ? {} : { lastSavedAt: patch.lastSavedAt }),
  };
}

function setUp(patch: Parameters<typeof mirror>[0], saveStatus: Record<string, string> = {}) {
  useProjectStore.setState({ projects: { p1: mirror(patch) }, saveStatus } as never);
  render(<SaveIndicator projectId="p1" />);
}

afterEach(cleanup);

describe('SaveIndicator', () => {
  it('says nothing before anything has been edited or written', () => {
    setUp({});
    expect(screen.queryByTestId('project-save-indicator')).toBeNull();
  });

  it('reports an edit that has not reached disk', () => {
    setUp({ dirty: true });
    const indicator = screen.getByTestId('project-save-indicator');
    expect(indicator.textContent).toBe('Unsaved changes');
    expect(indicator.dataset['pending']).toBe('true');
  });

  it('settles on the time the autosave landed', () => {
    setUp({ dirty: false, lastSavedAt: new Date(2026, 8, 12, 14, 5, 9).toISOString() });
    const indicator = screen.getByTestId('project-save-indicator');
    expect(indicator.textContent).toBe('Saved 14:05:09');
    expect(indicator.dataset['pending']).toBe('false');
  });

  it('still reports pending work while an explicit save is in flight', () => {
    // `project.save` clears `dirty` in main before the renderer hears back, so the in-flight
    // status has to keep the indicator pending on its own.
    setUp({ dirty: false, lastSavedAt: new Date(2026, 8, 12, 14, 5, 9).toISOString() }, { p1: 'saving' });
    const indicator = screen.getByTestId('project-save-indicator');
    expect(indicator.textContent).toBe('Saving…');
    expect(indicator.dataset['pending']).toBe('true');
  });

  it('reports only its own project', () => {
    setUp({ dirty: false, lastSavedAt: new Date(2026, 8, 12, 14, 5, 9).toISOString() }, { p2: 'saving' });
    expect(screen.getByTestId('project-save-indicator').textContent).toBe('Saved 14:05:09');
  });
});
