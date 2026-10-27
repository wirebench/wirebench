import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnippetWire, SnippetsFileWire, SshListSnippetsResponse } from '@wirebench/wire/snippets-wire';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const listSnippets = vi.fn();
const saveSnippets = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listSnippets, saveSnippets, secretNames, setSecret } }),
}));

const { SnippetEditor } = await import('../../src/renderer/features/ssh/snippets/snippet-editor.js');
const { SnippetsPanel } = await import('../../src/renderer/features/ssh/snippets/snippets-panel.js');
const { useSnippetEditorShown, useSnippetsStore } =
  await import('../../src/renderer/features/ssh/snippets/snippets-store.js');
const { useHostsStore } = await import('../../src/renderer/features/ssh/hosts-store.js');
const { useEditorsStore } = await import('../../src/renderer/state/editors.js');
const { useRunDialogStore } = await import('../../src/renderer/features/ssh/snippets/run.js');

const s = (id: string, over: Partial<SnippetWire> = {}): SnippetWire => ({
  id,
  name: id,
  tags: [],
  variables: [],
  script: 'ls',
  enter: true,
  confirm: false,
  ...over,
});

const FILE: SnippetsFileWire = {
  version: 1,
  packages: [
    {
      id: 'deploy',
      name: 'Deploy',
      snippets: [s('restart', { name: 'Restart', script: 'sudo systemctl restart api' })],
    },
    { id: 'empty', name: 'Empty', snippets: [] },
  ],
  snippets: [s('uptime', { name: 'Uptime', script: 'uptime' })],
};

const listItem = (snippet: SnippetWire, packageId?: string, packageName?: string) => ({
  id: snippet.id,
  name: snippet.name,
  ...(packageId === undefined ? {} : { packageId, packageName }),
  tags: snippet.tags,
  firstLine: snippet.script.split('\n')[0] ?? '',
  literalStart: snippet.script,
  variables: snippet.variables,
  secrets: [],
  enter: snippet.enter,
  confirm: snippet.confirm,
  lineCount: 1,
  revision: 'r',
});
const answerFor = (file: SnippetsFileWire): SshListSnippetsResponse => ({
  file,
  snippets: [
    ...file.packages.flatMap((p) => p.snippets.map((x) => listItem(x, p.id, p.name))),
    ...file.snippets.map((x) => listItem(x)),
  ],
  problems: [],
});

/** The file of the last `ssh.saveSnippets` call. */
const saved = (): SnippetsFileWire => (saveSnippets.mock.lastCall?.[0] as { file: SnippetsFileWire }).file;

beforeEach(() => {
  listSnippets.mockReset().mockResolvedValue({ ok: true, value: answerFor(FILE) });
  saveSnippets
    .mockReset()
    .mockImplementation(({ file }: { file: SnippetsFileWire }) =>
      Promise.resolve({ ok: true, value: answerFor(file) }),
    );
  secretNames.mockReset().mockResolvedValue({
    ok: true,
    value: { names: [{ name: 'api_token', local: true, external: false }] },
  });
  setSecret.mockReset().mockResolvedValue({ ok: true, value: {} });
  useSnippetsStore.getState().reset();
  useSnippetsStore.setState({ ...answerFor(FILE), loaded: true, filter: '', selectedTags: [] });
  useHostsStore.setState({ homeView: 'snippets' });
});
afterEach(() => {
  cleanup();
  useRunDialogStore.setState({ request: null });
});

function editSnippet(id: string): void {
  useSnippetsStore.getState().openEditor({ mode: 'edit', id });
  render(<SnippetEditor />);
}

describe('snippet editor', () => {
  it('editing the name and script then Save sends the whole file once', async () => {
    editSnippet('uptime');
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Load');
    const script = screen.getByLabelText('Script');
    await userEvent.clear(script);
    await userEvent.type(script, 'cat /proc/loadavg');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSnippets).toHaveBeenCalledOnce();
    expect(saved().snippets).toEqual([s('uptime', { name: 'Load', script: 'cat /proc/loadavg' })]);
    expect(saved().packages).toEqual(FILE.packages);
  });

  it('a new snippet gets an id from its name and lands in the chosen package', async () => {
    useSnippetsStore.getState().openEditor({ mode: 'new', packageId: 'empty' });
    render(<SnippetEditor />);
    await userEvent.type(screen.getByLabelText('Name'), 'Disk usage');
    await userEvent.type(screen.getByLabelText('Script'), 'df -h');
    await userEvent.type(screen.getByLabelText('Tags'), 'disk, ops');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().packages[1]?.snippets).toEqual([
      s('disk-usage', { name: 'Disk usage', script: 'df -h', tags: ['disk', 'ops'] }),
    ]);
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'edit', id: 'disk-usage' });
  });

  it('a new package from the picker is created with the snippet', async () => {
    editSnippet('uptime');
    await userEvent.selectOptions(screen.getByLabelText('Package'), 'New package…');
    await userEvent.type(screen.getByLabelText('New package name'), 'Monitoring');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().packages.at(-1)).toEqual({
      id: 'monitoring',
      name: 'Monitoring',
      snippets: [s('uptime', { name: 'Uptime', script: 'uptime' })],
    });
    expect(saved().snippets).toEqual([]);
  });

  it('an undeclared ${service} offers to declare it, and declaring adds the variable', async () => {
    editSnippet('uptime');
    const script = screen.getByLabelText('Script');
    await userEvent.clear(script);
    await userEvent.type(script, 'journalctl -u ${{service} -n ${{HOME}');
    const declare = screen.getByRole('button', { name: 'Declare ${service} as a variable' });
    expect(screen.getByRole('button', { name: 'Declare ${HOME} as a variable' })).toBeDefined();
    await userEvent.click(declare);
    expect(screen.queryByRole('button', { name: 'Declare ${service} as a variable' })).toBeNull();
    await userEvent.type(screen.getByLabelText('Default of service'), 'api');
    // ${HOME} is still shell text, so Save asks once (#717) before Save anyway saves.
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('snippet-undeclared-ask').textContent).toContain('${HOME} is not a variable');
    expect(saveSnippets).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(saved().snippets[0]?.variables).toEqual([{ name: 'service', default: 'api' }]);
  });

  it('Save asks again only when the undeclared tokens change (#717)', async () => {
    editSnippet('uptime');
    const script = screen.getByLabelText('Script');
    await userEvent.clear(script);
    await userEvent.type(script, 'df -h ${{dir}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeDefined();
    await userEvent.type(script, ' ${{mount}');
    expect(screen.queryByTestId('snippet-undeclared-ask')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('snippet-undeclared-ask').textContent).toContain('${dir}, ${mount} are not variables');
  });

  it('the secret picker inserts ${secret:NAME} from the workspace secret names', async () => {
    editSnippet('uptime');
    const picker = await screen.findByLabelText('Insert secret');
    await within(picker).findByRole('option', { name: 'api_token' });
    await userEvent.selectOptions(picker, 'api_token');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Script').value).toBe('uptime${secret:api_token}');
    expect(secretNames).toHaveBeenCalled();
  });

  it('New secret… stores a value write-only and inserts its name', async () => {
    editSnippet('uptime');
    const picker = await screen.findByLabelText('Insert secret');
    await userEvent.selectOptions(picker, 'New secret…');
    await userEvent.type(screen.getByLabelText('Secret name'), 'db_pw');
    await userEvent.type(screen.getByLabelText('Secret value'), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Store and insert' }));
    expect(setSecret).toHaveBeenCalledWith({ name: 'db_pw', value: 'hunter2' });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Script').value).toBe('uptime${secret:db_pw}');
    expect(document.body.textContent).not.toContain('hunter2');
  });

  it('a save refusal shows its message inline', async () => {
    saveSnippets.mockResolvedValue({
      ok: false,
      error: { code: 'snippet-secret-invalid', message: 'malformed token' },
    });
    editSnippet('uptime');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(await screen.findByRole('alert')).getByText(/malformed token/)).toBeDefined();
  });

  it('Press Enter and Always confirm write enter and confirm; the defaults stay out', async () => {
    editSnippet('uptime');
    expect(screen.getByRole('switch', { name: 'Press Enter' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('switch', { name: 'Press Enter' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Always confirm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved().snippets[0]).toMatchObject({ enter: false, confirm: true });
  });

  it('shows only on the Snippets view with the fixed tab in front and an existing snippet', () => {
    useEditorsStore.getState().reset();
    useEditorsStore.getState().showSet('ssh');
    useEditorsStore.getState().showStart();
    const shown = (): boolean => {
      let value = false;
      function Probe() {
        value = useSnippetEditorShown();
        return null;
      }
      const { unmount } = render(<Probe />);
      unmount();
      return value;
    };
    expect(shown()).toBe(false);
    useSnippetsStore.getState().openEditor({ mode: 'edit', id: 'uptime' });
    expect(shown()).toBe(true);
    useSnippetsStore.getState().openEditor({ mode: 'edit', id: 'gone' });
    expect(shown()).toBe(false);
    useSnippetsStore.getState().openEditor({ mode: 'new' });
    expect(shown()).toBe(true);
    useHostsStore.setState({ homeView: 'hosts' });
    expect(shown()).toBe(false);
  });
});

describe('snippet editor Run and Insert', () => {
  it('keeps Run, Insert and Save in a footer under the scrolling fields (S63)', () => {
    editSnippet('uptime');
    const body = screen.getByTestId('snippet-editor-body');
    const footer = screen.getByTestId('snippet-editor-footer');
    for (const name of ['Run', 'Insert', 'Save']) {
      const button = screen.getByRole('button', { name });
      expect(footer.contains(button)).toBe(true);
      expect(body.contains(button)).toBe(false);
    }
    expect(body.className).toContain('overflow-y-auto');
    expect(footer.className).toContain('shrink-0');
  });

  it('with no terminal in front, Run and Insert open the run dialog for the saved snippet', async () => {
    editSnippet('uptime');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'uptime', mode: 'dialog' });
    await userEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'uptime', enter: false, mode: 'dialog' });
  });

  it('with unsaved changes, Run asks to save first, then saves and runs', async () => {
    editSnippet('uptime');
    await userEvent.type(screen.getByLabelText('Script'), ' -p');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(useRunDialogStore.getState().request).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Save and run' }));
    await vi.waitFor(() =>
      expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'uptime', mode: 'dialog' }),
    );
    expect(saved().snippets).toEqual([s('uptime', { name: 'Uptime', script: 'uptime -p' })]);
  });

  it('a new snippet has no Run until it is saved', () => {
    useSnippetsStore.getState().openEditor({ mode: 'new' });
    render(<SnippetEditor />);
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });
});

describe('Snippets panel actions', () => {
  async function renderPanel(): Promise<void> {
    render(<SnippetsPanel />);
    await screen.findByText('Uptime');
  }
  const rowMenu = async (id: string): Promise<void> => {
    await userEvent.click(
      within(screen.getByTestId(`snippet-item-${id}`)).getByRole('button', { name: 'Snippet actions' }),
    );
  };

  it('Run and Insert on a row, a double-click and Run… in its menu start a run', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Run Uptime' }));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'uptime', mode: 'dialog' });
    await userEvent.click(screen.getByRole('button', { name: 'Insert Restart' }));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'restart', enter: false, mode: 'dialog' });
    useRunDialogStore.setState({ request: null });
    await userEvent.dblClick(screen.getByText('Uptime'));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'uptime', mode: 'dialog' });
    useRunDialogStore.setState({ request: null });
    await rowMenu('restart');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Run…' }));
    expect(useRunDialogStore.getState().request).toEqual({ snippetId: 'restart', mode: 'dialog' });
  });

  it('clicking a row opens it in the editor', async () => {
    await renderPanel();
    await userEvent.click(screen.getByText('Uptime'));
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'edit', id: 'uptime' });
  });

  it('New snippet opens an empty editor; New package asks a name and saves', async () => {
    await renderPanel();
    await userEvent.click(screen.getByRole('button', { name: 'New snippet' }));
    expect(useSnippetsStore.getState().editor).toEqual({ mode: 'new' });
    await userEvent.click(screen.getByRole('button', { name: 'More ways to add' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New package' }));
    await userEvent.type(screen.getByLabelText('Package name'), 'Ops');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(saved().packages.map((p) => p.id)).toEqual(['deploy', 'empty', 'ops']);
  });

  it('Duplicate, Move to package and Delete (after asking) edit the file', async () => {
    await renderPanel();
    await rowMenu('uptime');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(saved().snippets.map((x) => x.id)).toEqual(['uptime', 'uptime-copy']);

    await rowMenu('uptime');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to package…' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Empty' }));
    expect(saved().packages[1]?.snippets.map((x) => x.id)).toEqual(['uptime']);

    await rowMenu('restart');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(saveSnippets).toHaveBeenCalledTimes(2); // nothing until confirmed
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(saved().packages[0]?.snippets).toEqual([]);
  });

  it('Copy script puts the script on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderPanel();
    await rowMenu('restart');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy script' }));
    expect(writeText).toHaveBeenCalledWith('sudo systemctl restart api');
  });

  it('a package renames, and deletes only once empty', async () => {
    await renderPanel();
    const deploy = screen.getByRole('region', { name: 'Deploy' });
    await userEvent.click(within(deploy).getByRole('button', { name: 'Package actions' }));
    const remove = await screen.findByRole('menuitem', { name: /Delete/ });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.textContent).toContain('holds snippets');
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const input = screen.getByLabelText('Package name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Releases');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(saved().packages[0]).toMatchObject({ id: 'deploy', name: 'Releases' });

    const empty = screen.getByRole('region', { name: 'Empty' });
    await userEvent.click(within(empty).getByRole('button', { name: 'Package actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(saved().packages.map((p) => p.id)).toEqual(['deploy']);
  });
});
