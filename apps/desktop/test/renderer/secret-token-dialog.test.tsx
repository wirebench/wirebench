/**
 * The Secret token values dialog: a project's `${secret:name}` tokens with whether this machine has
 * a value for each, and a masked field to set one. A value goes to main through `secretScan.setValue`
 * and nowhere else — no store holds it, and nothing hands it back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretTokenDialog } from '../../src/renderer/features/secrets/secret-token-dialog.js';
import { registerProjectCommands } from '../../src/renderer/commands/register-project-commands.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** Obviously fake. */
const FAKE_VALUE = 'fake-value-not-real-0001';

const context = { platform: 'linux', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

const tokens = vi.fn();
const setValue = vi.fn();

function openProjects(...ids: string[]): void {
  useProjectStore.setState({
    projects: Object.fromEntries(
      ids.map((id) => [id, { id, name: id === 'p1' ? 'Billing' : 'Orders' } as ProjectWire]),
    ),
    order: ids.map((projectId) => ({ projectId, interfaceIds: [] })),
    projectOf: { ...Object.fromEntries(ids.map((id) => [id, id])), 'rest-2': 'p2' },
  });
}

function open(target: { projectId: string; name?: string } = { projectId: 'p1' }): void {
  act(() => {
    useUiStore.getState().setSecretTokenDialog(target);
  });
}

function row(name: string): HTMLElement {
  const found = screen.getAllByTestId('secret-token-row').find((element) => element.dataset['name'] === name);
  if (found === undefined) {
    throw new Error(`no row for ${name}`);
  }
  return found;
}

beforeEach(() => {
  tokens.mockReset().mockResolvedValue({
    ok: true,
    value: {
      tokens: [
        { name: 'billing_key', stored: true },
        { name: 'orders_key', stored: false },
      ],
    },
  });
  setValue.mockReset().mockResolvedValue({ ok: true, value: { replaced: false } });
  installWirebenchApi({ secretScan: { tokens, setValue } });
  openProjects('p1');
  useEditorsStore.setState({ tabs: [], activeId: undefined });
  useUiStore.setState({ secretTokenDialog: null });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ secretTokenDialog: null });
});

describe('SecretTokenDialog', () => {
  it('is closed until something opens it', () => {
    render(<SecretTokenDialog />);
    expect(screen.queryByTestId('secret-token-dialog')).toBeNull();
  });

  it("lists the project's tokens with whether each has a value here", async () => {
    render(<SecretTokenDialog />);
    open();

    await screen.findByText('billing_key');
    expect(tokens).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(within(row('billing_key')).getByText('Set')).toBeTruthy();
    const replace = within(row('billing_key')).getByRole('button', { name: 'Replace value for billing_key' });
    expect(replace.textContent).toBe('Replace…');
    expect(within(row('orders_key')).getByText('Not on this machine')).toBeTruthy();
    const set = within(row('orders_key')).getByRole('button', { name: 'Set value for orders_key' });
    expect(set.textContent).toBe('Set…');
  });

  it('saves a value with exactly the project, the name and the value, then refreshes and says so', async () => {
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('orders_key');

    await userEvent.click(within(row('orders_key')).getByRole('button', { name: 'Set value for orders_key' }));
    const input = within(row('orders_key')).getByLabelText('Value for orders_key');
    expect(input.getAttribute('type')).toBe('password');
    await userEvent.type(input, FAKE_VALUE);
    tokens.mockResolvedValue({
      ok: true,
      value: {
        tokens: [
          { name: 'billing_key', stored: true },
          { name: 'orders_key', stored: true },
        ],
      },
    });
    await userEvent.click(within(row('orders_key')).getByRole('button', { name: 'Save' }));

    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls[0]?.[0]).toEqual({ projectId: 'p1', name: 'orders_key', value: FAKE_VALUE });
    await waitFor(() => expect(within(row('orders_key')).getByText('Set')).toBeTruthy());
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('secret-token-announce').textContent).toBe('Saved orders_key');
    expect(within(row('orders_key')).queryByLabelText('Value for orders_key')).toBeNull();
    // Focus lands on the row it came from, not on the dialog.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row('orders_key')).getByRole('button', { name: 'Replace value for orders_key' }),
      ),
    );
    // The value went to main and nowhere else.
    expect(JSON.stringify(useUiStore.getState())).not.toContain(FAKE_VALUE);
    expect(document.body.innerHTML).not.toContain(FAKE_VALUE);
  });

  it('saves on Enter', async () => {
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('billing_key');

    await userEvent.click(within(row('billing_key')).getByRole('button', { name: 'Replace value for billing_key' }));
    await userEvent.type(within(row('billing_key')).getByLabelText('Value for billing_key'), `${FAKE_VALUE}{Enter}`);

    await waitFor(() =>
      expect(setValue).toHaveBeenCalledWith({ projectId: 'p1', name: 'billing_key', value: FAKE_VALUE }),
    );
  });

  it('cancels the edit on Escape, and leaves the dialog open', async () => {
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('billing_key');

    await userEvent.click(within(row('billing_key')).getByRole('button', { name: 'Replace value for billing_key' }));
    await userEvent.type(within(row('billing_key')).getByLabelText('Value for billing_key'), `${FAKE_VALUE}{Escape}`);

    expect(within(row('billing_key')).queryByLabelText('Value for billing_key')).toBeNull();
    expect(screen.getByTestId('secret-token-dialog')).toBeTruthy();
    expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p1' });
    expect(setValue).not.toHaveBeenCalled();

    // With no edit open, Escape closes the dialog as usual.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(useUiStore.getState().secretTokenDialog).toBeNull());
  });

  it('opens on a named token with its value field focused', async () => {
    render(<SecretTokenDialog />);
    open({ projectId: 'p1', name: 'orders_key' });

    await waitFor(() =>
      expect(document.activeElement).toBe(within(row('orders_key')).getByLabelText('Value for orders_key')),
    );
  });

  it('opens on a name the project does not list yet as a row of its own, value field focused', async () => {
    // A token only in unsaved edits: main lists the saved project, so the name is not there.
    render(<SecretTokenDialog />);
    open({ projectId: 'p1', name: 'draft_key' });

    await waitFor(() =>
      expect(document.activeElement).toBe(within(row('draft_key')).getByLabelText('Value for draft_key')),
    );
    const names = screen.getAllByTestId('secret-token-row').map((element) => element.dataset['name']);
    expect(names).toEqual(['draft_key', 'billing_key', 'orders_key']);
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('');

    await userEvent.type(within(row('draft_key')).getByLabelText('Value for draft_key'), `${FAKE_VALUE}{Enter}`);
    expect(setValue).toHaveBeenCalledWith({ projectId: 'p1', name: 'draft_key', value: FAKE_VALUE });
  });

  it('keeps the named row, not a second one, once main lists it', async () => {
    render(<SecretTokenDialog />);
    open({ projectId: 'p1', name: 'draft_key' });
    await screen.findByLabelText('Value for draft_key');
    tokens.mockResolvedValue({
      ok: true,
      value: {
        tokens: [
          { name: 'billing_key', stored: true },
          { name: 'orders_key', stored: false },
          { name: 'draft_key', stored: true },
        ],
      },
    });

    await userEvent.type(screen.getByLabelText('Value for draft_key'), `${FAKE_VALUE}{Enter}`);

    await waitFor(() => expect(within(row('draft_key')).getByText('Set')).toBeTruthy());
    expect(
      screen.getAllByTestId('secret-token-row').filter((element) => element.dataset['name'] === 'draft_key'),
    ).toHaveLength(1);
  });

  it('shows nothing from a save for a project the person has since moved off', async () => {
    openProjects('p1', 'p2');
    let finish: (value: unknown) => void = () => undefined;
    setValue.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<SecretTokenDialog />);
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Replace value for billing_key' }));
    await userEvent.type(screen.getByLabelText('Value for billing_key'), `${FAKE_VALUE}{Enter}`);
    expect(screen.getByLabelText<HTMLInputElement>('Name').disabled).toBe(true);

    await userEvent.selectOptions(screen.getByLabelText('Project'), 'p2');
    await waitFor(() => expect(tokens).toHaveBeenLastCalledWith({ projectId: 'p2' }));
    await act(async () => {
      finish({ ok: false, error: { code: 'x', message: 'The store for Billing is locked.' } });
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('secret-token-announce').textContent).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Name').disabled).toBe(false);
  });

  it('sets a name not in the list, and refuses one a token cannot carry', async () => {
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('billing_key');

    const name = screen.getByLabelText('Name');
    const value = screen.getByLabelText('Value');
    const save = screen.getByTestId('secret-token-add-save');
    await userEvent.type(name, '1bad name');
    await userEvent.type(value, FAKE_VALUE);
    expect(screen.getByText('Use letters, digits and underscores, not starting with a digit.')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(value, '{Enter}');
    expect(setValue).not.toHaveBeenCalled();

    await userEvent.clear(name);
    await userEvent.type(name, 'new_key');
    await userEvent.click(save);

    expect(setValue.mock.calls[0]?.[0]).toEqual({ projectId: 'p1', name: 'new_key', value: FAKE_VALUE });
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Value').value).toBe(''));
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('');
    expect(screen.getByTestId('secret-token-announce').textContent).toBe('Saved new_key');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  });

  it('says when the project uses no tokens, and still offers a name to set', async () => {
    tokens.mockResolvedValue({ ok: true, value: { tokens: [] } });
    render(<SecretTokenDialog />);
    open();

    expect(await screen.findByText('This project uses no secret tokens.')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('offers a choice of project when several are open, and lists the chosen one', async () => {
    openProjects('p1', 'p2');
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('billing_key');

    await userEvent.selectOptions(screen.getByLabelText('Project'), 'p2');

    await waitFor(() => expect(tokens).toHaveBeenLastCalledWith({ projectId: 'p2' }));
    expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p2' });
  });

  it('shows no project choice with one project open', async () => {
    render(<SecretTokenDialog />);
    open();
    await screen.findByText('billing_key');

    expect(screen.queryByLabelText('Project')).toBeNull();
  });
});

describe('Set Secret Token Value…', () => {
  beforeEach(() => {
    resetCommands();
    registerProjectCommands();
  });

  it('opens the dialog on the project of the active tab', async () => {
    openProjects('p1', 'p2');
    useEditorsStore.setState({
      tabs: [{ id: 't1', kind: 'rest-request', title: 'Invoices', restRequestId: 'rest-2' }],
      activeId: 't1',
    });

    expect(await runCommand('secrets.setTokenValue', context)).toBe(true);

    expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p2' });
  });

  it('opens on the first open project when no tab says which', async () => {
    openProjects('p1', 'p2');

    await runCommand('secrets.setTokenValue', context);

    expect(useUiStore.getState().secretTokenDialog).toEqual({ projectId: 'p1' });
  });

  it('is unavailable with no project open', async () => {
    useProjectStore.setState({ projects: {}, order: [], projectOf: {} });

    expect(await runCommand('secrets.setTokenValue', context)).toBe(false);
    expect(useUiStore.getState().secretTokenDialog).toBeNull();
  });
});
