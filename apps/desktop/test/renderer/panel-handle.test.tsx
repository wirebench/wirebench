import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PanelHandle } from '../../src/renderer/shell/panel-handle.js';

describe('PanelHandle', () => {
  afterEach(() => {
    cleanup();
  });

  it('carries the separator a11y contract', () => {
    render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={vi.fn()}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );

    const handle = screen.getByTestId('panel-handle-sidebar');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize Sidebar');
    expect(handle.getAttribute('aria-valuenow')).toBe('20');
    expect(handle.getAttribute('aria-valuemin')).toBe('12');
    expect(handle.getAttribute('aria-valuemax')).toBe('40');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('rounds fractional values for the aria-value* attributes', () => {
    render(
      <PanelHandle
        testId="panel-handle-console"
        label="Resize Console"
        orientation="horizontal"
        valueNow={24.6}
        valueMin={10}
        valueMax={70}
        onDrag={vi.fn()}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );

    expect(screen.getByTestId('panel-handle-console').getAttribute('aria-valuenow')).toBe('25');
  });

  it('a vertical handle steps on ArrowRight (+1) and ArrowLeft (-1), and ignores other keys', () => {
    const onStep = vi.fn();
    render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={vi.fn()}
        onStep={onStep}
        onDoubleClick={vi.fn()}
      />,
    );
    const handle = screen.getByTestId('panel-handle-sidebar');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });

    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('a horizontal handle steps on ArrowDown (+1) and ArrowUp (-1)', () => {
    const onStep = vi.fn();
    render(
      <PanelHandle
        testId="panel-handle-console"
        label="Resize Console"
        orientation="horizontal"
        valueNow={25}
        valueMin={10}
        valueMax={70}
        onDrag={vi.fn()}
        onStep={onStep}
        onDoubleClick={vi.fn()}
      />,
    );
    const handle = screen.getByTestId('panel-handle-console');

    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  it('reports the pixel delta since the last pointer position while dragging', () => {
    const onDrag = vi.fn();
    render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={onDrag}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );
    const handle = screen.getByTestId('panel-handle-sidebar');

    fireEvent.pointerDown(handle, { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 230 });
    fireEvent.pointerMove(window, { clientX: 210 });
    fireEvent.pointerUp(window);

    expect(onDrag.mock.calls).toEqual([[30], [-20]]);
  });

  it('stops reporting drags once the pointer is released', () => {
    const onDrag = vi.fn();
    const onDragEnd = vi.fn();
    render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );
    const handle = screen.getByTestId('panel-handle-sidebar');

    fireEvent.pointerDown(handle, { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 230 });
    fireEvent.pointerUp(window);
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    onDrag.mockClear();
    fireEvent.pointerMove(window, { clientX: 400 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  it('keeps reporting correct deltas even when the caller re-renders with a new onDrag between moves', () => {
    // A live caller closes `onDrag` over its own current size and passes a *new* function
    // identity on every render — exactly what happens once a drag actually updates the store.
    // The handle must swap in the fresh listener rather than run the whole gesture against
    // whatever `onDrag` was bound at the first `pointerdown`.
    const calls: number[] = [];
    const { rerender } = render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={(delta) => calls.push(delta)}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );
    const handle = screen.getByTestId('panel-handle-sidebar');

    fireEvent.pointerDown(handle, { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 210 });

    rerender(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={22}
        valueMin={12}
        valueMax={40}
        onDrag={(delta) => calls.push(delta * 1)}
        onStep={vi.fn()}
        onDoubleClick={vi.fn()}
      />,
    );

    fireEvent.pointerMove(window, { clientX: 225 });
    fireEvent.pointerUp(window);

    expect(calls).toEqual([10, 15]);
  });

  it('calls onDoubleClick on a double-click', () => {
    const onDoubleClick = vi.fn();
    render(
      <PanelHandle
        testId="panel-handle-sidebar"
        label="Resize Sidebar"
        orientation="vertical"
        valueNow={20}
        valueMin={12}
        valueMax={40}
        onDrag={vi.fn()}
        onStep={vi.fn()}
        onDoubleClick={onDoubleClick}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId('panel-handle-sidebar'));

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
