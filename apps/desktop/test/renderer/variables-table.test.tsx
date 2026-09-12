import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import {
  VariablesTable,
  type InheritedScope,
  type VariablesTableTarget,
} from '../../src/renderer/features/environments/variables-table.js';

function baseTarget(patch: Partial<VariablesTableTarget> = {}): VariablesTableTarget {
  return {
    label: 'Test variables',
    scopeLabel: 'This environment',
    properties: { host: 'one.test' },
    disabled: [],
    onSet: vi.fn(),
    onRemove: vi.fn(),
    ...patch,
  };
}

function scope(patch: Partial<InheritedScope> & { readonly label: string }): InheritedScope {
  return { properties: {}, disabled: [], ...patch };
}

function renderTable(target: VariablesTableTarget) {
  return render(
    <TooltipPrimitive.Provider>
      <VariablesTable target={target} />
    </TooltipPrimitive.Provider>,
  );
}

describe('VariablesTable', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the Enabled/Variable/Value header and one row per property', () => {
    renderTable(baseTarget({ properties: { host: 'one.test', port: '80' } }));
    expect(screen.getByRole('table', { name: 'Test variables' })).toBeTruthy();
    // One row per property, plus the always-present add row.
    expect(screen.getAllByTestId('env-variable-row')).toHaveLength(3);
  });

  it('commits a value edit on Enter', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('host', 'two.test');
  });

  it('commits a value edit on blur', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.blur(value);
    expect(onSet).toHaveBeenCalledWith('host', 'two.test');
  });

  it('reverts an edit on Escape without saving', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const value = screen.getByLabelText<HTMLInputElement>('Value of host');
    fireEvent.change(value, { target: { value: 'two.test' } });
    fireEvent.keyDown(value, { key: 'Escape' });
    expect(value.value).toBe('one.test');
    expect(onSet).not.toHaveBeenCalled();
  });

  it('removes a variable', () => {
    const onRemove = vi.fn();
    renderTable(baseTarget({ onRemove }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove host' }));
    expect(onRemove).toHaveBeenCalledWith('host');
  });

  it('toggles Enabled through onSetEnabled', () => {
    const onSetEnabled = vi.fn();
    renderTable(baseTarget({ onSetEnabled }));
    fireEvent.click(screen.getByLabelText('Enable host'));
    expect(onSetEnabled).toHaveBeenCalledWith('host', false);
  });

  it('shows the Enabled checkbox read-only when onSetEnabled is not given, with a title explaining why', () => {
    renderTable(baseTarget());
    const checkbox = screen.getByLabelText<HTMLInputElement>('Enable host');
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.title).toBe("A linked project's own environment variables are managed in that project.");
  });

  it('has no title on the Enabled checkbox when it is interactive', () => {
    renderTable(baseTarget({ onSetEnabled: vi.fn() }));
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').title).toBe('');
  });

  it('mutes a disabled variable row', () => {
    renderTable(baseTarget({ disabled: ['host'] }));
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').checked).toBe(false);
    const rows = screen.getAllByTestId('env-variable-row');
    expect(rows[0]?.className).toContain('opacity-50');
  });

  it('adds a variable through the always-present add row', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('port', '8080');
  });

  it('flags an empty name and does not save it', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A variable needs a name.');
  });

  it('flags a duplicate name and does not save it', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'host' } });
    fireEvent.keyDown(screen.getByLabelText('New variable name'), { key: 'Enter' });
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A variable named "host" already exists.');
  });

  it('renames through onRename when given', () => {
    const onRename = vi.fn();
    renderTable(baseTarget({ onRename }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('host', 'hostname');
  });

  it('falls back to remove-then-set when onRename is not given', () => {
    const onSet = vi.fn();
    const onRemove = vi.fn();
    renderTable(baseTarget({ onSet, onRemove }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onRemove).toHaveBeenCalledWith('host');
    expect(onSet).toHaveBeenCalledWith('hostname', 'one.test');
  });

  it('keeps a disabled variable disabled when the remove-then-set fallback renames it', () => {
    // The remove drops the `disabled` entry (every writer prunes names with no matching
    // property), so without the third call the renamed variable comes back enabled and starts
    // resolving again with nothing to show for it.
    const onSet = vi.fn();
    const onRemove = vi.fn();
    const onSetEnabled = vi.fn();
    renderTable(baseTarget({ disabled: ['host'], onSet, onRemove, onSetEnabled }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(onRemove).toHaveBeenCalledWith('host');
    expect(onSet).toHaveBeenCalledWith('hostname', 'one.test');
    expect(onSetEnabled).toHaveBeenCalledWith('hostname', false);
  });

  it('does not touch the enabled flag when the fallback renames an enabled variable', () => {
    const onSetEnabled = vi.fn();
    renderTable(baseTarget({ disabled: [], onSetEnabled }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it('refuses to rename a disabled variable when the target declares it unsupported', () => {
    const onRename = vi.fn();
    const onSet = vi.fn();
    const onRemove = vi.fn();
    renderTable(baseTarget({ disabled: ['host'], onRename, onSet, onRemove, renameDisabledUnsupported: true }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(screen.getByRole('alert').textContent).toBe('Re-enable "host" before renaming it.');
    expect(onRename).not.toHaveBeenCalled();
    expect(onSet).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('keeps the typed name in the field when a disabled rename is refused', () => {
    renderTable(baseTarget({ disabled: ['host'], renameDisabledUnsupported: true }));
    const name = screen.getByLabelText<HTMLInputElement>('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(name.value).toBe('hostname');
  });

  it('still renames an enabled variable when the target declares disabled renames unsupported', () => {
    const onRename = vi.fn();
    renderTable(baseTarget({ disabled: [], onRename, renameDisabledUnsupported: true }));
    const name = screen.getByLabelText('Name of host');
    fireEvent.change(name, { target: { value: 'hostname' } });
    fireEvent.keyDown(name, { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('host', 'hostname');
  });
});

describe('VariablesTable — the ledger (groups, origin, inheritance)', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the header row for Resolves from', () => {
    renderTable(baseTarget());
    expect(screen.getByRole('columnheader', { name: 'Resolves from' })).toBeTruthy();
  });

  it('labels a name defined only here, with nothing inherited, plainly with the scope label', () => {
    renderTable(baseTarget({ scopeLabel: 'Globals' }));
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Globals');
  });

  it('groups own rows under "Set here · {scopeLabel}" and omits the Inherited header when nothing is inherited', () => {
    renderTable(baseTarget({ scopeLabel: 'Globals' }));
    const groups = screen.getAllByTestId('env-variable-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.textContent).toBe('Set here · Globals');
  });

  it('says an enabled own value shadows the nearest inherited scope that also defines it', () => {
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        inherited: [scope({ label: 'Workspace', properties: { host: 'ws.test' } }), scope({ label: 'Globals' })],
      }),
    );
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('This environment · shadows Workspace');
  });

  it('names the scope an enabled own value really shadows, skipping a definer that has it off', () => {
    // Workspace defines `host` but has it off, so removing this row would fall through to
    // Globals, not to Workspace — naming Workspace would promise a fallback that does not exist.
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: { host: 'here.test' },
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' } }),
        ],
      }),
    );
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('This environment · shadows Globals');
  });

  it('says an enabled own value shadows nothing when every scope defining the name has it off', () => {
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: { host: 'here.test' },
        inherited: [scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] })],
      }),
    );
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('This environment');
  });

  it('skips past an inherited scope that defines the name but disables it, per the precedence rule', () => {
    // The ordering trap: Workspace defines `host` but disables it, so it does not win — Globals
    // does. The engine drops a disabled name from its scope before the merge, so `global.test`
    // is what actually goes on the wire, and the row has to say so.
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: {},
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' } }),
        ],
      }),
    );
    // `host` is not in this scope's own properties, so it renders as an Inherited row — resolved
    // from Globals, because Workspace's copy is switched off and resolution continues past it.
    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('global.test');
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').checked).toBe(true);
    // `.at(-1)` would now be the add row's origin cell (empty, per stage 2) — the inherited row
    // is the only one shown, at index 0.
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Globals · Workspace has it off');
  });

  it('offers to override the value that actually resolves, not the disabled one above it', () => {
    // The override baseline is the resolving value: re-typing what the app already sends must
    // not be mistaken for an edit and written back as a redundant override.
    const onSet = vi.fn();
    renderTable(
      baseTarget({
        properties: {},
        onSet,
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' } }),
        ],
      }),
    );
    const value = screen.getByLabelText('Value of host');
    fireEvent.change(value, { target: { value: 'global.test' } });
    fireEvent.blur(value);
    expect(onSet).not.toHaveBeenCalled();
  });

  it('shows an inherited row every scope disables as off, with nothing resolving', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' }, disabled: ['host'] }),
        ],
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').checked).toBe(false);
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Off — no value resolves');
  });

  it('says a disabled own value falls through to the scope that would win', () => {
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: { host: 'here.test' },
        disabled: ['host'],
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' } }),
        ],
      }),
    );
    // Workspace defines `host` too but disables it — the ordering trap — so resolution continues
    // to Globals, which is who this scope's disabled value actually falls through to.
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Off — falls through to Globals');
  });

  it('says a disabled own value with nothing else defining it resolves to nothing', () => {
    renderTable(baseTarget({ properties: { host: 'here.test' }, disabled: ['host'] }));
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Off — no value resolves');
  });

  it('groups a name defined only in an inherited scope under "Inherited · read-only"', () => {
    renderTable(
      baseTarget({
        properties: { host: 'here.test' },
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const groups = screen.getAllByTestId('env-variable-group');
    expect(groups.map((group) => group.textContent)).toEqual(['Set here · This environment', 'Inherited · read-only']);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');
  });

  it('picks the nearest inherited scope when several define the same inherited-only name', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [
          scope({ label: 'Workspace', properties: { token: 'ws-token' } }),
          scope({ label: 'Globals', properties: { token: 'global-token' } }),
        ],
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('ws-token');
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Workspace');
  });

  it("keeps an inherited row's name and Enabled non-interactive, with no delete button — only the value is editable", () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const checkbox = screen.getByLabelText<HTMLInputElement>('Enable token');
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.title).toContain('Workspace');
    expect(screen.getByLabelText<HTMLInputElement>('Name of token').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').readOnly).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').title).toContain('Workspace');
    expect(screen.queryByRole('button', { name: 'Remove token' })).toBeNull();
  });

  it('mutes an inherited row whose owning scope disables it', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' }, disabled: ['token'] })],
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Enable token').checked).toBe(false);
    const rows = screen.getAllByTestId('env-variable-row');
    expect(rows[0]?.className).toContain('opacity-50');
  });

  it('omits the Set-here header when this scope defines nothing of its own', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const groups = screen.getAllByTestId('env-variable-group');
    expect(groups.map((group) => group.textContent)).toEqual(['Inherited · read-only']);
  });

  it('still shows the empty message when both this scope and every inherited scope have nothing', () => {
    renderTable(baseTarget({ properties: {} }));
    expect(screen.getByText('No variables yet.')).toBeTruthy();
  });
});

describe('VariablesTable — the growing row (stage 2)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the add row Enabled toggle unchecked and non-interactive while the name is empty', () => {
    renderTable(baseTarget());
    const checkbox = screen.getByLabelText<HTMLInputElement>('New variable enabled');
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
  });

  it('checks the add row Enabled toggle the moment a name is typed, still non-interactive', () => {
    renderTable(baseTarget());
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    const checkbox = screen.getByLabelText<HTMLInputElement>('New variable enabled');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
  });

  it('leaves the add row origin cell empty when the name is empty or defined nowhere inherited', () => {
    renderTable(baseTarget({ inherited: [scope({ label: 'Workspace', properties: { host: 'ws.test' } })] }));
    expect(screen.getAllByTestId('env-variable-origin').at(-1)?.textContent).toBe('');
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'brandNew' } });
    expect(screen.getAllByTestId('env-variable-origin').at(-1)?.textContent).toBe('');
  });

  it('warns "will shadow {X}" in the add row while typing a name an inherited scope defines', () => {
    renderTable(baseTarget({ inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })] }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'token' } });
    expect(screen.getAllByTestId('env-variable-origin').at(-1)?.textContent).toBe('will shadow Workspace');
  });

  it('still warns "will shadow" when the defining inherited scope disables the name there', () => {
    // nearestDefining, not resolvingScope — a disabled definer still shadows visibly.
    renderTable(
      baseTarget({
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' }, disabled: ['token'] })],
      }),
    );
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'token' } });
    expect(screen.getAllByTestId('env-variable-origin').at(-1)?.textContent).toBe('will shadow Workspace');
  });

  it('keeps focus in the add row name input after Enter in the value field commits', () => {
    renderTable(baseTarget({ onSet: vi.fn() }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.keyDown(screen.getByLabelText('New variable value'), { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByLabelText('New variable name'));
  });

  it('keeps focus in the add row name input after blur on the value field commits', () => {
    renderTable(baseTarget({ onSet: vi.fn() }));
    fireEvent.change(screen.getByLabelText('New variable name'), { target: { value: 'port' } });
    fireEvent.change(screen.getByLabelText('New variable value'), { target: { value: '8080' } });
    fireEvent.blur(screen.getByLabelText('New variable value'));
    expect(document.activeElement).toBe(screen.getByLabelText('New variable name'));
  });

  it('does not paste-hijack a single-line paste into the name field', () => {
    renderTable(baseTarget());
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'onlyName=onlyValue' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    expect(screen.queryByTestId('env-variable-paste-confirm')).toBeNull();
  });

  it('shows a confirmation list for a multi-line paste of name=value pairs', () => {
    renderTable(baseTarget());
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'a=1\nb=2\n' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    const container = screen.getByTestId('env-variable-paste-confirm');
    expect(container.textContent).toContain('a');
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('b');
    expect(container.textContent).toContain('2');
    expect(screen.getByTestId('env-variable-paste-add').textContent).toBe('Add 2 variables');
  });

  it('parses "name: value", ignores blank lines and # comments, and splits on the first separator', () => {
    renderTable(baseTarget());
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'a: 1\n\n# a comment\nb=x=y\n' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    const container = screen.getByTestId('env-variable-paste-confirm');
    expect(container.textContent).toContain('a');
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('b');
    expect(container.textContent).toContain('x=y');
    expect(screen.getByTestId('env-variable-paste-add').textContent).toBe('Add 2 variables');
  });

  it('marks a pasted name that already exists in this scope as an overwrite', () => {
    renderTable(baseTarget({ properties: { host: 'one.test' } }));
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'host=two.test\nport=8080' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    const container = screen.getByTestId('env-variable-paste-confirm');
    expect(container.textContent).toMatch(/host.*overwrit/i);
  });

  it('marks a pasted name an inherited scope defines as a shadow', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'token=xyz\nother=1' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    const container = screen.getByTestId('env-variable-paste-confirm');
    expect(container.textContent).toMatch(/token.*shadow.*Workspace/i);
  });

  it('writes every pasted variable through onSet on confirm, then clears the row and refocuses the name field', async () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const name = screen.getByLabelText<HTMLInputElement>('New variable name');
    const clipboardData = { getData: () => 'a=1\nb=2' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    fireEvent.click(screen.getByTestId('env-variable-paste-add'));
    expect(onSet).toHaveBeenCalledWith('a', '1');
    expect(onSet).toHaveBeenCalledWith('b', '2');
    expect(screen.queryByTestId('env-variable-paste-confirm')).toBeNull();
    expect(name.value).toBe('');
    // The dialog's own focus trap returns focus on a macrotask once it unmounts — it was the
    // active element when the dialog opened, so this is Radix's restore, not a manual jump.
    await waitFor(() => {
      expect(document.activeElement).toBe(name);
    });
  });

  it('commits a paste as a single batch when the target can take one', () => {
    // A scope whose writes are not serialised would drop all but the last of N `onSet` calls, so
    // the whole block has to reach it as one write.
    const onSet = vi.fn();
    const onSetMany = vi.fn();
    renderTable(baseTarget({ onSet, onSetMany }));
    const name = screen.getByLabelText('New variable name');
    name.focus();
    fireEvent.paste(name, { clipboardData: { getData: () => 'a=1\nb=2' } });
    fireEvent.click(screen.getByTestId('env-variable-paste-add'));
    expect(onSetMany).toHaveBeenCalledTimes(1);
    expect(onSetMany).toHaveBeenCalledWith([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
    ]);
    expect(onSet).not.toHaveBeenCalled();
  });

  it('writes nothing when the paste confirmation is cancelled', () => {
    const onSet = vi.fn();
    renderTable(baseTarget({ onSet }));
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => 'a=1\nb=2' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    fireEvent.click(screen.getByTestId('env-variable-paste-cancel'));
    expect(onSet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('env-variable-paste-confirm')).toBeNull();
  });

  it('falls back to plain-text paste when the pasted block parses to nothing usable', () => {
    renderTable(baseTarget());
    const name = screen.getByLabelText('New variable name');
    const clipboardData = { getData: () => '# just a comment\n\n' };
    // A real paste can only land on a focused field — give the name input focus first, matching
    // reality (and letting the dialog's own focus-restore hand focus back here on close).
    name.focus();
    fireEvent.paste(name, { clipboardData });
    expect(screen.queryByTestId('env-variable-paste-confirm')).toBeNull();
  });
});

describe('VariablesTable — overriding an inherited row', () => {
  afterEach(() => {
    cleanup();
  });

  it('calls onSet with the typed name and value when a value is committed on an inherited row', () => {
    const onSet = vi.fn();
    renderTable(
      baseTarget({
        properties: {},
        onSet,
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const value = screen.getByLabelText('Value of token');
    fireEvent.change(value, { target: { value: 'xyz' } });
    fireEvent.keyDown(value, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('token', 'xyz');
  });

  it('moves the row to "Set here" with origin "{scopeLabel} · shadows {X}" once the override exists', () => {
    // Once `onSet` has actually written `token` into this scope's own properties, the row is no
    // longer "inherited-only" — it belongs to Set here, and the existing origin logic already
    // says it shadows Workspace with no special-casing needed.
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: { token: 'xyz' },
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const groups = screen.getAllByTestId('env-variable-group');
    expect(groups.map((group) => group.textContent)).toEqual(['Set here · This environment']);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('xyz');
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').readOnly).toBe(false);
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('This environment · shadows Workspace');
  });

  it('returns the row to the inherited group, showing the inherited value again, once the override is removed', () => {
    const onRemove = vi.fn();
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: { token: 'xyz' },
        onRemove,
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    expect(onRemove).toHaveBeenCalledWith('token');

    // Simulate the caller re-rendering after the removal actually took effect: `token` drops out
    // of this scope's own properties, so it falls back to being inherited.
    cleanup();
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    const groups = screen.getAllByTestId('env-variable-group');
    expect(groups.map((group) => group.textContent)).toEqual(['Inherited · read-only']);
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').value).toBe('abc');
    expect(screen.getAllByTestId('env-variable-origin')[0]?.textContent).toBe('Workspace');
  });

  it('leaves the name input and Enabled toggle non-interactive on an inherited row', () => {
    renderTable(
      baseTarget({
        properties: {},
        inherited: [scope({ label: 'Workspace', properties: { token: 'abc' } })],
      }),
    );
    expect(screen.getByLabelText<HTMLInputElement>('Name of token').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Enable token').disabled).toBe(true);
  });
});
