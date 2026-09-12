import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function setUp() {
  installWirebenchApi();
  useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
  const store = useEditorsStore.getState();
  store.open({ id: 'a', kind: 'request', title: 'A', requestId: 'a' });
  store.open({ id: 'b', kind: 'request', title: 'B', requestId: 'b' });
  render(<EditorArea />);
}

describe('EditorArea tabs', () => {
  beforeEach(() => {
    setUp();
  });

  afterEach(() => {
    cleanup();
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
  });

  it('pairs every tab with the panel it controls', () => {
    const selected = screen.getByRole('tab', { name: /^B/ });
    const panel = screen.getByRole('tabpanel');
    expect(selected.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(selected.id);
    expect(selected.id.length).toBeGreaterThan(0);
    expect(panel.id.length).toBeGreaterThan(0);
  });

  it('is a single tab stop: only the selected tab is reachable with Tab', () => {
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('moves between tabs with Left/Right and wraps, activating as it goes', () => {
    const tabs = () => screen.getAllByRole('tab');
    fireEvent.keyDown(tabs()[2] as HTMLElement, { key: 'ArrowLeft' });
    expect(useEditorsStore.getState().activeId).toBe('a');
    expect(document.activeElement).toBe(tabs()[1]);

    fireEvent.keyDown(tabs()[1] as HTMLElement, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'ArrowLeft' });
    expect(useEditorsStore.getState().activeId).toBe('b');
  });

  it('jumps to the first and last tab with Home and End', () => {
    const tabs = () => screen.getAllByRole('tab');
    fireEvent.keyDown(tabs()[2] as HTMLElement, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Start' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tabs()[0] as HTMLElement, { key: 'End' });
    expect(useEditorsStore.getState().activeId).toBe('b');
  });

  it('still closes the focused tab with Delete', () => {
    fireEvent.keyDown(screen.getAllByRole('tab')[2] as HTMLElement, { key: 'Delete' });
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a']);
  });

  it('moves the focused tab with Mod+Shift+Left/Right instead of moving focus', () => {
    const tabB = screen.getByRole('tab', { name: /^B/ });
    fireEvent.keyDown(tabB, { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['b', 'a']);
    expect(useEditorsStore.getState().activeId).toBe('b');

    fireEvent.keyDown(tabB, { key: 'ArrowRight', metaKey: true, shiftKey: true });
    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
  });

  it('reorders tabs by drag and drop', () => {
    const tabA = screen.getByRole('tab', { name: /^A/ });
    const tabB = screen.getByRole('tab', { name: /^B/ });
    // jsdom lays nothing out, so every rect is zero-wide and a drop always lands "after".
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(tabA, { dataTransfer });
    fireEvent.dragOver(tabB, { dataTransfer, clientX: 10 });
    fireEvent.drop(tabB, { dataTransfer });
    fireEvent.dragEnd(tabA, { dataTransfer });

    expect(useEditorsStore.getState().tabs.map((tab) => tab.id)).toEqual(['b', 'a']);
  });
});
