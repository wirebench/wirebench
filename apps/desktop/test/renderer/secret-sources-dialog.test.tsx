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
import { registerProjectCommands } from '../../src/renderer/commands/register-project-commands.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { ProjectWire, SecretSourcesState } from '../../src/shared/wire-types.js';
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
    expect((await screen.findByLabelText<HTMLInputElement>('Name')).value).toBe('db');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'vault' } });
    fireEvent.change(screen.getByLabelText('path'), { target: { value: '-x' } });
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const message = await screen.findByText('path must not start with "-"');
    expect(screen.getByLabelText('path').getAttribute('aria-describedby')).toContain(message.id);
    expect(setShared.mock.calls).toEqual([[{ name: 'db', entry: { kind: 'vault', path: '-x', field: 'f' } }]]);
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
    await screen.findByLabelText('Name');
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'local' } });
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('db is already mapped')).toBeTruthy();
    expect(setLocal.mock.calls).toEqual([[{ name: 'db', entry: { kind: 'none' } }]]);
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'db2' } });
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
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Test' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Remove' })).toBeTruthy();
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

describe('secrets.manageSources', () => {
  const context = { platform: 'linux', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

  it('opens the dialog when a workspace has a project, and does nothing without one', async () => {
    resetCommands();
    registerProjectCommands();
    useProjectStore.setState({ projects: {}, order: [], projectOf: {} });
    expect(await runCommand('secrets.manageSources', context)).toBe(false);
    useProjectStore.setState({ projects: { p1: { id: 'p1', name: 'Billing' } as ProjectWire } });
    expect(await runCommand('secrets.manageSources', context)).toBe(true);
    expect(useUiStore.getState().secretSourcesDialog).toEqual({});
  });
});
