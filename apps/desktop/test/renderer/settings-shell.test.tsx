import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsShell } from '../../src/renderer/features/preferences/settings-shell.js';

function Harness({ onBack, children }: { readonly onBack: () => void; readonly children?: ReactNode }) {
  const [value, setValue] = useState('');
  return (
    <SettingsShell
      area="user"
      header={<div data-testid="shell-header">Server picker</div>}
      nav={<p>menu</p>}
      search={{ value, onChange: setValue, placeholder: 'Search settings' }}
      onBack={onBack}
    >
      {children ?? <p>page</p>}
    </SettingsShell>
  );
}

afterEach(() => {
  cleanup();
});

describe('SettingsShell (settings split spec §2)', () => {
  it('Escape clears the search, then calls onBack', () => {
    const onBack = vi.fn();
    render(<Harness onBack={onBack} />);
    const search = screen.getByLabelText<HTMLInputElement>('Search settings');
    fireEvent.change(search, { target: { value: 'proxy' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('settings-back'));
    expect(screen.getByTestId('settings-back').textContent).toBe('Back to workspace');
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('Escape inside an open menu does not leave', () => {
    const onBack = vi.fn();
    render(
      <Harness onBack={onBack}>
        <div role="menu">
          <button type="button">Item</button>
        </div>
      </Harness>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Item' }), { key: 'Escape' });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('⌘F focuses the search', () => {
    render(<Harness onBack={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Search settings'));
  });

  it('renders the header above the search', () => {
    render(<Harness onBack={vi.fn()} />);
    const header = screen.getByTestId('shell-header');
    const search = screen.getByLabelText('Search settings');
    expect(header.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
