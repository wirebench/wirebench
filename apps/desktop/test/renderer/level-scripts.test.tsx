/**
 * API, interface and folder scripts in the app (#334): the Script tab lists each level that ran
 * under its heading, the Scripts editor says it runs for every request inside a level, and a folder's
 * Scripts… dialog edits the folder's own scripts.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ScriptResultWire } from '../../src/shared/wire-base.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const { ScriptResults, scriptLevelHeading } = await import('../../src/renderer/features/scripts/script-results.js');
const { ScriptsTab } = await import('../../src/renderer/features/scripts/scripts-tab.js');
const { FolderScriptsDialog } = await import('../../src/renderer/features/scripts/folder-scripts-dialog.js');
const { useProjectStore } = await import('../../src/renderer/state/project.js');
const { useUiStore } = await import('../../src/renderer/state/ui.js');

const updateRequestScripts = vi.fn();

beforeEach(() => {
  updateRequestScripts.mockReset().mockResolvedValue(undefined);
  installWirebenchApi({
    script: { diagnostics: vi.fn().mockResolvedValue({ ok: true, value: { diagnostics: [] } }) },
  });
  useProjectStore.setState({ updateRequestScripts });
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setFolderScriptsId(undefined);
});

const RESULT: ScriptResultWire = {
  tests: [
    { name: 'api ok', passed: true },
    { name: 'order', passed: false, message: 'expected 1 to be 2' },
  ],
  log: ['api pre', 'folder post'],
  truncated: false,
  error: { code: 'script-error', message: 'Orders/folder.post.ts:1:1: broke' },
  levels: [
    { level: 'api', name: 'Shop', phase: 'pre', tests: [], log: ['api pre'], truncated: false },
    {
      level: 'folder',
      name: 'Orders',
      phase: 'post',
      tests: [{ name: 'api ok', passed: true }],
      log: ['folder post'],
      truncated: false,
      error: { code: 'script-error', message: 'Orders/folder.post.ts:1:1: broke' },
    },
    {
      level: 'request',
      name: 'Echo',
      phase: 'post',
      tests: [{ name: 'order', passed: false, message: 'expected 1 to be 2' }],
      log: [],
      truncated: false,
    },
  ],
};

describe('the Script tab', () => {
  it('lists each script that ran, in order, under its level’s heading', () => {
    render(<ScriptResults script={RESULT} />);

    const sections = screen.getAllByTestId('script-level');
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'API "Shop" · pre-request',
      'Folder "Orders" · post-response',
      'Request "Echo" · post-response',
    ]);
    expect(sections[0]?.textContent).toContain('api pre');
    expect(sections[1]?.textContent).toContain('Orders/folder.post.ts:1:1: broke');
    expect(sections[2]?.textContent).toContain('expected 1 to be 2');
    expect(screen.getByTestId('script-results-error').textContent).toContain('broke');
  });

  it('looks as it did when only the request’s own scripts ran', () => {
    render(
      <ScriptResults
        script={{
          ...RESULT,
          error: undefined,
          levels: [{ level: 'request', name: 'Echo', phase: 'post', tests: [], log: [], truncated: false }],
        }}
      />,
    );
    expect(screen.queryAllByTestId('script-level')).toEqual([]);
    expect(screen.getByTestId('script-log').textContent).toBe('api pre\nfolder post');
  });

  it('names an interface’s level', () => {
    expect(scriptLevelHeading({ level: 'interface', name: 'Stock', phase: 'post' })).toBe(
      'Interface "Stock" · post-response',
    );
  });
});

describe('a level’s Scripts editor', () => {
  it('says it runs for every request in the level, and what a problem stops', () => {
    render(
      <ScriptsTab
        requestId="api-1"
        level="API"
        scripts={{
          api: 'wirebench',
          enabled: true,
          secrets: [],
          problems: [{ phase: 'pre', code: 'script-file-missing' }],
        }}
      />,
    );
    expect(screen.getByTestId('scripts-level-hint').textContent).toContain('Runs for every request in this API');
    // Its editor's name differs from a request's, so both can be open at once.
    expect(screen.getByLabelText('Pre-request script for this API')).toBeTruthy();
    expect(screen.getByTestId('scripts-problem-pre').textContent).toContain(
      'no request in this API will send until it is fixed',
    );
  });
});

describe('the folder Scripts… dialog', () => {
  it('edits the folder’s own scripts', async () => {
    useProjectStore.setState({
      folders: {
        f1: {
          id: 'f1',
          apiId: 'api-1',
          name: 'Orders',
          order: 0,
          auth: { type: 'inherit' },
          scripts: { api: 'postman', enabled: false, secrets: [], pre: 'pm.test("t", () => {});' },
        } as never,
      },
    });
    render(<FolderScriptsDialog />);
    act(() => {
      useUiStore.getState().setFolderScriptsId('f1');
    });

    expect(screen.getByTestId('folder-scripts-dialog').textContent).toContain('Scripts for “Orders”');
    expect((await screen.findByTestId('scripts-level-hint')).textContent).toContain('every request in this folder');
    fireEvent.click(screen.getByTestId('scripts-switch-on'));
    expect(updateRequestScripts).toHaveBeenCalledWith('f1', { enabled: true });
  });
});
