import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorArea } from '../../src/renderer/shell/editor-area.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { makeDraft } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { wsRequestWire } from '../helpers/wire-defaults.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

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

  it('shows no scroll buttons while every tab fits', () => {
    expect(screen.queryByTestId('editor-tabs-scroll-left')).toBeNull();
    expect(screen.queryByTestId('editor-tabs-scroll-right')).toBeNull();
  });

  it('pages the strip with the chevrons instead of a scrollbar once the tabs overflow', () => {
    const strip = screen.getByRole('tablist', { name: 'Open editors' });
    // jsdom lays nothing out, so give the strip a width its tabs overflow.
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 1000 });
    fireEvent.scroll(strip);

    fireEvent.click(screen.getByRole('button', { name: 'Scroll tabs right' }));

    expect(strip.scrollLeft).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Scroll tabs left' })).toBeTruthy();
  });

  it('lists every open tab in the menu, and switches to the one picked', async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show all open tabs' }), { key: 'Enter' });

    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Start', 'A', 'B']);

    fireEvent.click(items[1] as HTMLElement);
    expect(useEditorsStore.getState().activeId).toBe('a');
  });

  it('tells same-named request tabs apart in the menu by their operation', async () => {
    useProjectStore.setState({
      requests: {
        a: makeDraft({ id: 'a', name: 'Request 1', operationName: 'Add' }),
        b: makeDraft({ id: 'b', name: 'Request 1', operationName: 'Subtract' }),
      },
    });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Show all open tabs' }), { key: 'Enter' });

    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Start', 'Request 1 · Add', 'Request 1 · Subtract']);
    useProjectStore.setState({ requests: {} });
  });
});

describe('EditorArea — a WebSocket request tab', () => {
  afterEach(() => {
    cleanup();
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
    useProjectStore.setState({ wsRequests: {} });
  });

  it('opens the placeholder, named for the request, until the WebSocket editor exists', () => {
    installWirebenchApi();
    useProjectStore.setState({ wsRequests: { 'ws-1': wsRequestWire({ id: 'ws-1', name: 'Lobby' }) } });
    useEditorsStore.setState({ tabs: [], activeId: undefined, formViewTypes: {} });
    useEditorsStore.getState().open({ id: 'ws:ws-1', kind: 'ws-request', title: 'Lobby', wsRequestId: 'ws-1' });

    render(<EditorArea />);

    const placeholder = screen.getByTestId('ws-editor-placeholder');
    expect(placeholder).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lobby' })).toBeTruthy();
    expect(screen.getByText('The WebSocket editor is not here yet.')).toBeTruthy();
  });
});
