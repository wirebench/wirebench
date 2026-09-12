import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('skips past an inherited scope that defines the name but disables it, per the precedence rule', () => {
    // The ordering trap: Workspace defines `host` but disables it, so it does not win — Globals
    // does, and that's who should be named both as the shadow target and the fallback target.
    renderTable(
      baseTarget({
        scopeLabel: 'This environment',
        properties: {},
        disabled: ['host'],
        inherited: [
          scope({ label: 'Workspace', properties: { host: 'ws.test' }, disabled: ['host'] }),
          scope({ label: 'Globals', properties: { host: 'global.test' } }),
        ],
      }),
    );
    // `host` is not in this scope's own properties, so it renders as an Inherited row, owned by
    // the nearest scope that defines it at all — Workspace — even though Workspace disables it.
    expect(screen.getByLabelText<HTMLInputElement>('Value of host').value).toBe('ws.test');
    expect(screen.getByLabelText<HTMLInputElement>('Enable host').checked).toBe(false);
    expect(screen.getAllByTestId('env-variable-origin').at(-1)?.textContent).toBe('Workspace');
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

  it('renders an inherited row read-only: no delete button, disabled Enabled checkbox with a title naming the owner', () => {
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
    expect(screen.getByLabelText<HTMLInputElement>('Value of token').readOnly).toBe(true);
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
