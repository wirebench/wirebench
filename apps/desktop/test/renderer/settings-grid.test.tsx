import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  BooleanSetting,
  EnumSetting,
  LOCKED_LABEL,
  NumberSetting,
  SettingsGroup,
  SettingsRowsControllerProvider,
  SettingsVariantProvider,
  TextSetting,
  type SettingsRowsController,
} from '../../src/renderer/components/settings-grid.js';

afterEach(() => {
  cleanup();
});

function inCard(ui: React.ReactNode, controller?: SettingsRowsController) {
  const content = <SettingsVariantProvider variant="card">{ui}</SettingsVariantProvider>;
  return render(
    controller === undefined ? (
      content
    ) : (
      <SettingsRowsControllerProvider controller={controller}>{content}</SettingsRowsControllerProvider>
    ),
  );
}

function controller(overrides: Partial<SettingsRowsController> = {}): SettingsRowsController {
  return {
    isModified: () => false,
    canReset: () => true,
    reset: vi.fn(),
    locked: () => false,
    ...overrides,
  };
}

describe('settings grid, card variant', () => {
  it('renders a boolean as a switch that commits the flipped value at once', () => {
    const onChange = vi.fn();
    inCard(
      <SettingsGroup title="Clipboard">
        <BooleanSetting label="Copy on select" value={false} onChange={onChange} testId="copy" />
      </SettingsGroup>,
    );

    const toggle = screen.getByRole('switch', { name: 'Copy on select' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The <label> is bound to the switch, so the label text finds it too.
    expect(screen.getByLabelText('Copy on select')).toBe(toggle);

    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('shows the hint as visible text under the label', () => {
    inCard(
      <SettingsGroup>
        <BooleanSetting label="Word wrap" value onChange={() => undefined} hint="Wrap long lines." />
      </SettingsGroup>,
    );
    expect(screen.getByText('Wrap long lines.')).toBeTruthy();
  });

  it('renders a short enum as a segmented control and a long one as a select', () => {
    const onChange = vi.fn();
    inCard(
      <SettingsGroup>
        <EnumSetting
          label="Theme"
          value="dark"
          testId="theme"
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
          onChange={onChange}
        />
        <EnumSetting
          label="Size"
          value="s"
          options={['xs', 's', 'm', 'l'].map((value) => ({ value, label: value }))}
          onChange={() => undefined}
        />
      </SettingsGroup>,
    );

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group.getAttribute('data-testid')).toBe('theme');
    expect(screen.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('theme-light'));
    expect(onChange).toHaveBeenCalledWith('light');

    expect(screen.getByLabelText('Size').tagName).toBe('SELECT');
  });

  it('keeps commit-on-blur for text and number fields, with Escape reverting', () => {
    const onText = vi.fn();
    const onNumber = vi.fn();
    inCard(
      <SettingsGroup>
        <TextSetting label="User-Agent" value="a" onCommit={onText} />
        <NumberSetting label="Port" value={80} onCommit={onNumber} />
      </SettingsGroup>,
    );

    const text = screen.getByLabelText<HTMLInputElement>('User-Agent');
    fireEvent.change(text, { target: { value: 'b' } });
    expect(onText).not.toHaveBeenCalled();
    fireEvent.keyDown(text, { key: 'Escape' });
    expect(text.value).toBe('a');
    fireEvent.change(text, { target: { value: 'c' } });
    fireEvent.blur(text);
    expect(onText).toHaveBeenCalledWith('c');

    const port = screen.getByLabelText('Port');
    fireEvent.change(port, { target: { value: '8080' } });
    fireEvent.keyDown(port, { key: 'Enter' });
    expect(onNumber).toHaveBeenCalledWith(8080);
  });

  it('shows a modified dot and a per-row Reset that resets only that key', () => {
    const reset = vi.fn();
    inCard(
      <SettingsGroup>
        <BooleanSetting label="Word wrap" value onChange={() => undefined} setting="editor.wordWrap" />
        <BooleanSetting label="Line numbers" value onChange={() => undefined} setting="editor.lineNumbers" />
      </SettingsGroup>,
      controller({ isModified: (key) => key === 'editor.wordWrap', reset }),
    );

    expect(screen.getAllByTestId('setting-modified')).toHaveLength(1);
    const resetButtons = screen.getAllByRole('button', { name: /^Reset .* to default$/ });
    expect(resetButtons).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Word wrap to default' }));
    expect(reset).toHaveBeenCalledWith('editor.wordWrap');
  });

  it('offers no Reset for a modified key it cannot restore on its own', () => {
    inCard(
      <SettingsGroup>
        <NumberSetting label="Port" value={3128} onCommit={() => undefined} setting="proxy.port" />
      </SettingsGroup>,
      controller({ isModified: () => true, canReset: () => false }),
    );
    expect(screen.getByTestId('setting-modified')).toBeTruthy();
    expect(screen.queryByTestId('setting-reset')).toBeNull();
  });

  it('marks a locked row Managed, disables its control and offers no Reset', () => {
    inCard(
      <SettingsGroup>
        <BooleanSetting
          label="Check for updates on launch"
          value
          onChange={() => undefined}
          setting="updates.checkOnLaunch"
        />
      </SettingsGroup>,
      controller({ isModified: () => true, locked: () => true }),
    );
    const toggle = screen.getByRole('switch', { name: 'Check for updates on launch' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.closest('[data-locked]')?.textContent).toContain(LOCKED_LABEL);
    expect(LOCKED_LABEL).toBe('Managed');
    expect(screen.queryByTestId('setting-reset')).toBeNull();
  });
});

describe('settings grid, compact variant', () => {
  it('keeps the checkbox and the hint tooltip the Details panel relies on', () => {
    render(
      <SettingsGroup>
        <BooleanSetting label="Strip whitespace" value onChange={() => undefined} hint="Before sending." />
      </SettingsGroup>,
    );
    expect(screen.getByRole('checkbox', { name: 'Strip whitespace' })).toBeTruthy();
    expect(screen.getByTitle('Before sending.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
