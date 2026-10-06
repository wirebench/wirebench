/**
 * The Secret Sources dialog: the workspace's mapped names, one entry per write, issues shown beside
 * the field they name. A value never appears here; `test` answers a length only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SecretSourcesDialog } from '../../src/renderer/features/secret-sources/secret-sources-dialog.js';
import {
  openSecretSourcesApproval,
  openSecretSourcesDialog,
} from '../../src/renderer/features/secret-sources/actions.js';
import { registerWorkspaceCommands } from '../../src/renderer/commands/register-workspace-commands.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { SecretSourcesState, WorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const STATE: SecretSourcesState = {
  open: true,
  entries: [
    { name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: false },
    { name: 'pw', origin: 'local', kind: 'keychain', fields: { service: 's', account: 'me' }, overridden: false },
  ],
  hash: 'a'.repeat(64),
  trusted: true,
  changes: [],
};

const get = vi.fn();
const setShared = vi.fn();
const setLocal = vi.fn();
const test = vi.fn();

function answer(state: SecretSourcesState): void {
  get.mockResolvedValue({ ok: true, value: state });
}

beforeEach(() => {
  get.mockReset();
  setShared.mockReset().mockResolvedValue({ ok: true, value: { ok: true, issues: [] } });
  setLocal.mockReset().mockResolvedValue({ ok: true, value: { ok: true, issues: [] } });
  test.mockReset();
  installWirebenchApi({ secretSources: { get, setShared, setLocal, test } });
  useUiStore.setState({ secretSourcesDialog: null, secretSourcesApproval: false });
});

afterEach(() => {
  cleanup();
  resetCommands();
  useUiStore.setState({ secretSourcesDialog: null, secretSourcesApproval: false });
});

function openDialog(name?: string): void {
  act(() => {
    openSecretSourcesDialog(name);
  });
}

describe('SecretSourcesDialog', () => {
  it('is closed until something opens it', () => {
    render(<SecretSourcesDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists entries with their scope and tests one without showing a value', async () => {
    answer(STATE);
    test.mockResolvedValue({ ok: true, value: { ok: true, length: 24 } });
    render(<SecretSourcesDialog />);
    openDialog();
    const row = await screen.findByRole('row', { name: 'Secret source db' });
    expect(within(row).getByText('kv/app')).toBeTruthy();
    expect(within(row).getByText('Shared')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: 'Secret source pw' })).getByText('This machine')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    expect(await within(row).findByText('OK, 24 characters')).toBeTruthy();
    expect(test.mock.calls).toEqual([[{ name: 'db' }]]);
  });

  it('shows a failed test message in the row', async () => {
    answer(STATE);
    test.mockResolvedValue({
      ok: true,
      value: { ok: false, code: 'secret-source-tool-missing', message: 'vault is missing' },
    });
    render(<SecretSourcesDialog />);
    openDialog();
    const row = await screen.findByRole('row', { name: 'Secret source db' });
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    expect(await within(row).findByText('vault is missing')).toBeTruthy();
  });

  it('marks an overridden shared entry', async () => {
    answer({ ...STATE, entries: [{ ...STATE.entries[0]!, overridden: true }] });
    render(<SecretSourcesDialog />);
    openDialog();
    expect(await screen.findByText('(overridden here)')).toBeTruthy();
  });

  it('says so when no workspace is open', async () => {
    answer({ open: false, entries: [], trusted: true, changes: [] });
    render(<SecretSourcesDialog />);
    openDialog();
    expect(await screen.findByText('Open a workspace to map secrets to a secret manager.')).toBeTruthy();
  });

  it('adds a shared entry, one entry per call, and shows the issues main returns beside the field', async () => {
    answer({ open: true, entries: [], trusted: true, changes: [] });
    setShared.mockResolvedValue({
      ok: true,
      value: { ok: false, issues: [{ name: 'db', field: 'path', reason: 'path must not start with "-"' }] },
    });
    render(<SecretSourcesDialog />);
    openDialog('db');
    expect((await screen.findByLabelText<HTMLInputElement>('Secret name')).value).toBe('db');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'vault' } });
    fireEvent.change(screen.getByLabelText('path'), { target: { value: '-x' } });
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const message = await screen.findByText('path must not start with "-"');
    expect(screen.getByLabelText('path').getAttribute('aria-describedby')).toContain(message.id);
    expect(setShared.mock.calls).toEqual([
      [{ name: 'db', entry: { kind: 'vault', path: '-x', field: 'f' }, create: true }],
    ]);
    // The form stays open for a correction.
    expect(screen.getByLabelText('path')).toBeTruthy();
  });

  it('shows an issue with no field at the top of the form', async () => {
    answer({ open: true, entries: [], trusted: true, changes: [] });
    setLocal.mockResolvedValue({
      ok: true,
      value: { ok: false, issues: [{ name: 'db', reason: 'db is already mapped' }] },
    });
    render(<SecretSourcesDialog />);
    openDialog('db');
    await screen.findByLabelText('Secret name');
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'local' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('db is already mapped')).toBeTruthy();
    expect(setLocal.mock.calls).toEqual([[{ name: 'db', entry: { kind: 'none' }, create: true }]]);
  });

  it('offers the none kind only for this machine', async () => {
    answer({ open: true, entries: [], trusted: true, changes: [] });
    render(<SecretSourcesDialog />);
    openDialog('db');
    const kind = await screen.findByLabelText<HTMLSelectElement>('Kind');
    expect([...kind.options].map((option) => option.value)).not.toContain('none');
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'local' } });
    expect([...kind.options].map((option) => option.value)).toContain('none');
  });

  it('renames an entry by sending previousName and drops empty optional fields', async () => {
    answer(STATE);
    render(<SecretSourcesDialog />);
    openDialog();
    fireEvent.click(
      within(await screen.findByRole('row', { name: 'Secret source db' })).getByRole('button', { name: 'Edit' }),
    );
    expect((await screen.findByLabelText<HTMLInputElement>('path')).value).toBe('kv/app');
    fireEvent.change(screen.getByLabelText('Secret name'), { target: { value: 'db2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(setShared.mock.calls).toEqual([
        [{ name: 'db2', previousName: 'db', entry: { kind: 'vault', path: 'kv/app', field: 'password' } }],
      ]),
    );
  });

  it('removes an entry by sending a null entry', async () => {
    answer(STATE);
    render(<SecretSourcesDialog />);
    openDialog();
    fireEvent.click(
      within(await screen.findByRole('row', { name: 'Secret source db' })).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(setShared.mock.calls).toEqual([[{ name: 'db', entry: null }]]));
    fireEvent.click(
      within(screen.getByRole('row', { name: 'Secret source pw' })).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(setLocal.mock.calls).toEqual([[{ name: 'pw', entry: null }]]));
  });

  it('shows an invalid entry with its reason and offers no edit or test', async () => {
    answer({
      ...STATE,
      entries: [
        {
          name: 'bad',
          origin: 'shared',
          kind: 'invalid',
          fields: { kind: 'vault', extra: 'x' },
          reason: 'unknown field "extra"',
          overridden: false,
        },
      ],
    });
    render(<SecretSourcesDialog />);
    openDialog();
    const row = await screen.findByRole('row', { name: 'Secret source bad' });
    expect(within(row).getByText('Invalid: unknown field "extra"')).toBeTruthy();
    // What is there is shown, so a person can see what an approval covers.
    expect(within(row).getByText('extra')).toBeTruthy();
    expect(within(row).getByText('x')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('shows an entry with fields the form cannot show as invalid, and an unknown kind too', async () => {
    answer({
      ...STATE,
      entries: [
        {
          name: 'wide',
          origin: 'shared',
          kind: 'vault',
          fields: { path: 'p', field: 'f', note: 'keep me' },
          overridden: false,
        },
        { name: 'odd', origin: 'local', kind: 'etcd', fields: { key: 'k' }, overridden: false },
      ],
    });
    render(<SecretSourcesDialog />);
    openDialog();
    const wide = await screen.findByRole('row', { name: 'Secret source wide' });
    expect(within(wide).getByText('Invalid: fields this dialog cannot show: note')).toBeTruthy();
    expect(within(wide).getByText('keep me')).toBeTruthy();
    const odd = screen.getByRole('row', { name: 'Secret source odd' });
    expect(within(odd).getByText('Invalid: unknown kind "etcd"')).toBeTruthy();
    for (const row of [wide, odd]) {
      expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Test' })).toBeNull();
      expect(within(row).getByRole('button', { name: 'Remove' })).toBeTruthy();
    }
  });

  it('refuses an add onto a name that is already mapped in that scope, without sending', async () => {
    answer(STATE);
    render(<SecretSourcesDialog />);
    openDialog('db');
    fireEvent.change(await screen.findByLabelText('path'), { target: { value: 'kv/other' } });
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('"db" is already mapped here; edit or remove it instead')).toBeTruthy();
    expect(setShared).not.toHaveBeenCalled();
  });

  it('allows the same name in the other scope and sends create', async () => {
    answer(STATE);
    render(<SecretSourcesDialog />);
    openDialog('db');
    await screen.findByLabelText('path');
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'local' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setLocal.mock.calls).toEqual([[{ name: 'db', entry: { kind: 'none' }, create: true }]]));
  });

  it('shows main refusing an add onto a name that appeared since the view loaded', async () => {
    answer({ open: true, entries: [], trusted: true, changes: [] });
    setShared.mockResolvedValue({
      ok: true,
      value: { ok: false, issues: [{ name: 'db', reason: '"db" is already mapped here; edit or remove it instead' }] },
    });
    render(<SecretSourcesDialog />);
    openDialog('db');
    fireEvent.change(await screen.findByLabelText('path'), { target: { value: 'kv/app' } });
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('"db" is already mapped here; edit or remove it instead')).toBeTruthy();
    expect(setShared.mock.calls[0]?.[0]).toMatchObject({ create: true });
  });

  it('does not offer Test on a shared entry that a local one overrides', async () => {
    answer({
      ...STATE,
      entries: [
        { ...STATE.entries[0]!, overridden: true },
        { name: 'db', origin: 'local', kind: 'keychain', fields: { service: 's', account: 'me' }, overridden: false },
      ],
    });
    test.mockResolvedValue({ ok: true, value: { ok: true, length: 3 } });
    render(<SecretSourcesDialog />);
    openDialog();
    const rows = await screen.findAllByRole('row', { name: 'Secret source db' });
    expect(within(rows[0]!).queryByRole('button', { name: 'Test' })).toBeNull();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Test' }));
    expect(await within(rows[1]!).findByText('OK, 3 characters')).toBeTruthy();
    expect(within(rows[0]!).queryByText('OK, 3 characters')).toBeNull();
  });

  it("drops a row's Test result when that entry is edited or saved", async () => {
    answer(STATE);
    test.mockResolvedValue({ ok: true, value: { ok: true, length: 24 } });
    render(<SecretSourcesDialog />);
    openDialog();
    const row = await screen.findByRole('row', { name: 'Secret source db' });
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    await within(row).findByText('OK, 24 characters');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(within(row).queryByText('OK, 24 characters')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
    await within(row).findByText('OK, 24 characters');
    fireEvent.change(await screen.findByLabelText('path'), { target: { value: 'kv/new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setShared).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(row).queryByText('OK, 24 characters')).toBeNull());
  });

  it('labels the entry name apart from an azure field called name', async () => {
    answer({ open: true, entries: [], trusted: true, changes: [] });
    render(<SecretSourcesDialog />);
    openDialog('az');
    fireEvent.change(await screen.findByLabelText('Kind'), { target: { value: 'azure' } });
    expect(screen.getByLabelText('Secret name')).toBeTruthy();
    expect(screen.getByLabelText('name')).toBeTruthy();
    expect(screen.getByLabelText('vault')).toBeTruthy();
  });

  it('shows the state problem as a banner', async () => {
    answer({ ...STATE, problem: 'secretSources in workspace.yaml is not a mapping' });
    render(<SecretSourcesDialog />);
    openDialog();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'secretSources in workspace.yaml is not a mapping',
    );
  });

  it('offers approval when the shared mapping is not trusted', async () => {
    answer({ ...STATE, trusted: false, changes: [{ name: 'db', change: 'added' }] });
    render(<SecretSourcesDialog />);
    openDialog();
    expect(
      await screen.findByText("This workspace's shared secret sources are not approved on this machine."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and approve…' }));
    expect(useUiStore.getState().secretSourcesApproval).toBe(true);
  });

  it('reloads when the approval dialog settles', async () => {
    answer({ ...STATE, trusted: false });
    render(<SecretSourcesDialog />);
    openDialog();
    await screen.findByRole('button', { name: 'Review and approve…' });
    answer(STATE);
    act(() => {
      openSecretSourcesApproval();
    });
    act(() => {
      useUiStore.getState().setSecretSourcesApproval(false);
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review and approve…' })).toBeNull());
  });
});

describe('workspace.secretSources', () => {
  const context = { platform: 'linux', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

  it('opens the dialog whenever a workspace is open, even one with no project, and not otherwise', async () => {
    resetCommands();
    registerWorkspaceCommands();
    useProjectStore.setState({ projects: {}, order: [], projectOf: {} });
    useWorkspaceStore.setState({ workspace: null });
    expect(await runCommand('workspace.secretSources', context)).toBe(false);
    useWorkspaceStore.setState({ workspace: { id: 'w1', name: 'Team' } as WorkspaceWire });
    expect(await runCommand('workspace.secretSources', context)).toBe(true);
    expect(useUiStore.getState().secretSourcesDialog).toEqual({});
    useWorkspaceStore.setState({ workspace: null });
  });
});
