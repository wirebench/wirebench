import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Server } from 'lucide-react';
import { useState } from 'react';
import { SshEmptyState, SshNoMatches, SshViewHeader } from '../../src/renderer/features/ssh/ssh-view-frame.js';
import { SSH_VIEWS } from '../../src/renderer/features/ssh/ssh-views.js';

function Searchable({ onChange }: { readonly onChange?: (value: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <SshViewHeader
      title="Hosts"
      count={3}
      description="The servers you connect to."
      search={{
        value,
        onChange: (next) => {
          setValue(next);
          onChange?.(next);
        },
        label: 'Filter hosts',
        placeholder: 'Search hosts…',
      }}
      actions={<button type="button">New host</button>}
    />
  );
}

describe('SshViewHeader', () => {
  afterEach(cleanup);

  it('shows the title, count, description, search and action', () => {
    render(<Searchable />);
    expect(screen.getByRole('heading', { name: /Hosts/ })).toBeDefined();
    expect(screen.getByTestId('ssh-view-count').textContent).toBe('3');
    expect(screen.getByText('The servers you connect to.')).toBeDefined();
    expect(screen.getByRole('searchbox', { name: 'Filter hosts' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'New host' })).toBeDefined();
  });

  it('leaves out what it is not given', () => {
    render(<SshViewHeader title="Layouts" />);
    expect(screen.queryByTestId('ssh-view-count')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('the search shortcut focuses the search, and Escape clears it', async () => {
    const onChange = vi.fn();
    render(<Searchable onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('searchbox', { name: 'Filter hosts' });
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, metaKey: true });
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, 'db');
    expect(input.value).toBe('db');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

describe('SshEmptyState and SshNoMatches', () => {
  afterEach(cleanup);

  it('the empty state says what the view is for and offers its action', () => {
    const onAdd = vi.fn();
    render(
      <SshEmptyState icon={Server} text="Save the servers you connect to." testId="hosts-empty">
        <button type="button" onClick={onAdd}>
          New host
        </button>
      </SshEmptyState>,
    );
    expect(screen.getByTestId('hosts-empty').textContent).toContain('Save the servers you connect to.');
    fireEvent.click(screen.getByRole('button', { name: 'New host' }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('a filtered-out list offers Clear search', () => {
    const onClear = vi.fn();
    render(<SshNoMatches text="No host matches the search." onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe('SSH_VIEWS', () => {
  it('names every view of the fixed tab', () => {
    expect(Object.values(SSH_VIEWS).map((view) => view.label)).toEqual([
      'Hosts',
      'Snippets',
      'Layouts',
      'Port forwarding',
      'Keychain',
      'Known hosts',
    ]);
  });
});
