import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathBar } from '../../src/renderer/features/ssh/files/path-bar.js';

afterEach(() => {
  cleanup();
});

function renderBar(onNavigate = vi.fn().mockResolvedValue(true), editRequest = 0) {
  const view = render(
    <PathBar path="/var/log/app" home="/home/me" onNavigate={onNavigate} editRequest={editRequest} />,
  );
  return { onNavigate, ...view };
}

describe('the path bar', () => {
  it('shows a crumb per folder; a crumb click navigates there', () => {
    const { onNavigate } = renderBar();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['/', 'var', 'log', 'app']);
    fireEvent.click(screen.getByRole('button', { name: 'log' }));
    expect(onNavigate).toHaveBeenCalledWith('/var/log');
  });

  it('a click beside the crumbs turns it into a field; Enter goes to the typed folder', async () => {
    const { onNavigate } = renderBar();
    fireEvent.click(screen.getByTestId('files-path-bar'));
    const input = screen.getByTestId<HTMLInputElement>('files-path-input');
    expect(input.value).toBe('/var/log/app');
    fireEvent.change(input, { target: { value: '/etc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('/etc');
    await waitFor(() => {
      expect(screen.queryByTestId('files-path-input')).toBeNull();
    });
  });

  it('~ is the pane’s home', () => {
    const { onNavigate } = renderBar();
    fireEvent.click(screen.getByTestId('files-path-bar'));
    const input = screen.getByTestId('files-path-input');
    fireEvent.change(input, { target: { value: '~' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('/home/me');
  });

  it('Escape restores the crumbs without navigating', () => {
    const { onNavigate } = renderBar();
    fireEvent.click(screen.getByTestId('files-path-bar'));
    const input = screen.getByTestId('files-path-input');
    fireEvent.change(input, { target: { value: '/elsewhere' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('files-path-bar')).toBeDefined();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('a refused path keeps the field open with what was typed', async () => {
    const onNavigate = vi.fn().mockResolvedValue(false);
    renderBar(onNavigate);
    fireEvent.click(screen.getByTestId('files-path-bar'));
    const input = screen.getByTestId<HTMLInputElement>('files-path-input');
    fireEvent.change(input, { target: { value: '/nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('/nope');
    });
    expect(screen.getByTestId<HTMLInputElement>('files-path-input').value).toBe('/nope');
  });

  it('an edit request (⌘L) opens the field focused', () => {
    const onNavigate = vi.fn().mockResolvedValue(true);
    const view = renderBar(onNavigate, 0);
    view.rerender(<PathBar path="/var/log/app" home="/home/me" onNavigate={onNavigate} editRequest={1} />);
    expect(document.activeElement).toBe(screen.getByTestId('files-path-input'));
  });
});
