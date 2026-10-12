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

describe('NumberSetting validation', () => {
  function port(props: Partial<React.ComponentProps<typeof NumberSetting>> = {}) {
    const onCommit = vi.fn();
    inCard(<NumberSetting label="Port" value={8080} min={1} max={65_535} onCommit={onCommit} {...props} />);
    return { onCommit, input: screen.getByLabelText<HTMLInputElement>('Port') };
  }

  it('cannot take a letter, a dot or a minus sign in a whole-number field', () => {
    const { input } = port();
    for (const value of ['8080a', '80.5', '-1', '1e3', '0x10']) {
      fireEvent.change(input, { target: { value } });
      expect(input.value, value).toBe('8080');
    }
    fireEvent.change(input, { target: { value: '3128' } });
    expect(input.value).toBe('3128');
  });

  it('refuses a pasted value with any other character whole, but drops surrounding whitespace', () => {
    const { input } = port();
    fireEvent.change(input, { target: { value: '31 28' } });
    expect(input.value).toBe('8080');
    fireEvent.change(input, { target: { value: 'port: 3128' } });
    expect(input.value).toBe('8080');
    fireEvent.change(input, { target: { value: ' 3128\t' } });
    expect(input.value).toBe('3128');
  });

  it('accepts a minus sign only when the minimum is negative', () => {
    const { input } = port({ min: -10, max: 10 });
    fireEvent.change(input, { target: { value: '-5' } });
    expect(input.value).toBe('-5');
  });

  it('says what is wrong as it is typed, marks the field invalid and never commits', () => {
    const { input, onCommit } = port();
    fireEvent.change(input, { target: { value: '99999' } });
    const message = screen.getByText('Enter a whole number from 1 to 65535');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    expect(input.className).toContain('border-status-danger');

    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    // Blur keeps the draft and the message, for the user to fix.
    expect(input.value).toBe('99999');
    expect(screen.getByText('Enter a whole number from 1 to 65535')).toBeTruthy();

    fireEvent.change(input, { target: { value: '0' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: '65535' } });
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByTestId('setting-error')).toBeNull();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(65_535);
  });

  it('reverts an invalid draft on Escape', () => {
    const { input, onCommit } = port();
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('8080');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByTestId('setting-error')).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('takes decimals only when integer is false', () => {
    const { input, onCommit } = port({ integer: false, min: 0.01, max: 1024, value: 5 });
    fireEvent.change(input, { target: { value: '0.5' } });
    expect(input.value).toBe('0.5');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(0.5);

    fireEvent.change(input, { target: { value: '.' } });
    expect(screen.getByText('Enter a number from 0.01 to 1024')).toBeTruthy();
    fireEvent.change(input, { target: { value: '1.2.3' } });
    expect(input.value).toBe('.');
  });

  it('commits undefined for an empty field and shows the placeholder', () => {
    const { input, onCommit } = port({ placeholder: '3128' });
    expect(input.placeholder).toBe('3128');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(undefined);
  });

  it('shows a unit after the field and describes the field with it', () => {
    inCard(<NumberSetting label="Socket timeout" value={60_000} unit="ms" onCommit={() => undefined} />);
    const input = screen.getByLabelText('Socket timeout');
    const unit = screen.getByTestId('setting-unit');
    expect(unit.textContent).toBe('ms');
    expect(input.getAttribute('aria-describedby')).toBe(unit.id);
  });

  it('describes the rule when only a minimum is set', () => {
    inCard(<NumberSetting label="Threshold" value={0} min={0} onCommit={() => undefined} />);
    const input = screen.getByLabelText('Threshold');
    fireEvent.change(input, { target: { value: '99999999999999999999' } });
    expect(screen.getByText('Enter a whole number of 0 or more')).toBeTruthy();
  });

  it('does not commit or validate a read-only field', () => {
    const { input, onCommit } = port({ readOnly: true });
    expect(input.hasAttribute('readonly')).toBe(true);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('TextSetting validation', () => {
  const noSpaces = (value: string): string | undefined => (value.includes(' ') ? 'No spaces' : undefined);

  it('shows the rule inline, keeps the draft and does not commit an invalid value', () => {
    const onCommit = vi.fn();
    inCard(<TextSetting label="Host" value="a" validate={noSpaces} trim onCommit={onCommit} />);
    const input = screen.getByLabelText<HTMLInputElement>('Host');
    fireEvent.change(input, { target: { value: 'a b' } });
    const message = screen.getByText('No spaces');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('a b');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('a');
    expect(screen.queryByText('No spaces')).toBeNull();
  });

  it('trims surrounding whitespace before validating and committing', () => {
    const onCommit = vi.fn();
    inCard(<TextSetting label="Host" value="a" validate={noSpaces} trim onCommit={onCommit} />);
    const input = screen.getByLabelText<HTMLInputElement>('Host');
    fireEvent.change(input, { target: { value: '  proxy  ' } });
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('proxy');
    expect(input.value).toBe('proxy');
  });

  it('leaves whitespace alone without trim', () => {
    const onCommit = vi.fn();
    inCard(<TextSetting label="Value" value="" onCommit={onCommit} />);
    const input = screen.getByLabelText('Value');
    fireEvent.change(input, { target: { value: ' x ' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(' x ');
  });
});
