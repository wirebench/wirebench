import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { SlideOver } from '../../src/renderer/shell/slide-over.js';

function renderSlideOver(overrides: { width?: number; open?: boolean } = {}) {
  const onClose = vi.fn();
  const onWidthChange = vi.fn();
  const onToggle = vi.fn();
  const width = overrides.width ?? 420;
  const open = overrides.open ?? true;
  render(
    <TooltipPrimitive.Provider>
      <SlideOver
        label="Code"
        open={open}
        width={width}
        onWidthChange={onWidthChange}
        onToggle={onToggle}
        onClose={onClose}
      >
        <p>panel body</p>
      </SlideOver>
    </TooltipPrimitive.Provider>,
  );
  return { onClose, onWidthChange, onToggle };
}

describe('SlideOver', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders its children under the given label, at the given width', () => {
    renderSlideOver({ width: 500 });

    const panel = screen.getByTestId('slide-over');
    expect(panel).toBeTruthy();
    expect(panel.getAttribute('aria-label')).toBe('Code');
    expect(panel.style.width).toBe('500px');
    expect(screen.getByText('panel body')).toBeTruthy();
  });

  it('closes on the close icon', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSlideOver();

    await user.click(screen.getByTestId('slide-over-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const { onClose } = renderSlideOver();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('widens as the left-edge handle is dragged toward the left, and remembers the width', () => {
    const { onWidthChange } = renderSlideOver({ width: 420 });
    const handle = screen.getByTestId('panel-handle-slide-over');

    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 500 });

    // Dragging the handle 100px to the left, on a panel anchored to the right edge, widens it
    // by that same 100px.
    expect(onWidthChange).toHaveBeenLastCalledWith(520);

    fireEvent.pointerUp(window);
  });

  it('stops resizing once the pointer is released', () => {
    const { onWidthChange } = renderSlideOver({ width: 420 });
    const handle = screen.getByTestId('panel-handle-slide-over');

    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.pointerUp(window);
    onWidthChange.mockClear();

    fireEvent.pointerMove(window, { clientX: 400 });

    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it('clamps the dragged width to its minimum and maximum', () => {
    const { onWidthChange } = renderSlideOver({ width: 420 });
    const handle = screen.getByTestId('panel-handle-slide-over');

    fireEvent.pointerDown(handle, { clientX: 600 });
    fireEvent.pointerMove(window, { clientX: -5000 });
    expect(onWidthChange).toHaveBeenLastCalledWith(720);

    fireEvent.pointerMove(window, { clientX: 5000 });
    expect(onWidthChange).toHaveBeenLastCalledWith(280);

    fireEvent.pointerUp(window);
  });

  it('renders nothing at all while closed — the panel overlays the editor, so no leftover strip may sit over it', () => {
    // The regression: a closed slide-over used to leave its 8px `z-30` col-resize handle over the
    // editor's right edge, where it swallowed clicks and drag-selection and took a tab stop.
    renderSlideOver({ open: false });

    expect(screen.queryByText('panel body')).toBeNull();
    expect(screen.queryByTestId('slide-over-close')).toBeNull();
    expect(screen.queryByTestId('slide-over')).toBeNull();
    expect(screen.queryByTestId('panel-handle-slide-over')).toBeNull();
  });

  it('unmounts its handle on close and brings it back, labelled for resizing, on reopen', () => {
    const { rerender } = render(
      <TooltipPrimitive.Provider>
        <SlideOver label="Code" open={true} width={420} onWidthChange={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()}>
          <p>panel body</p>
        </SlideOver>
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByTestId('panel-handle-slide-over').getAttribute('aria-label')).toBe('Resize Code');

    rerender(
      <TooltipPrimitive.Provider>
        <SlideOver label="Code" open={false} width={420} onWidthChange={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()}>
          <p>panel body</p>
        </SlideOver>
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByTestId('panel-handle-slide-over')).toBeNull();

    rerender(
      <TooltipPrimitive.Provider>
        <SlideOver label="Code" open={true} width={420} onWidthChange={vi.fn()} onToggle={vi.fn()} onClose={vi.fn()}>
          <p>panel body</p>
        </SlideOver>
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByTestId('panel-handle-slide-over').getAttribute('aria-label')).toBe('Resize Code');
  });

  it('double-clicking the handle of an open panel calls onToggle', () => {
    const { onToggle } = renderSlideOver({ open: true });

    fireEvent.doubleClick(screen.getByTestId('panel-handle-slide-over'));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while closed — there is no listener to leave behind', () => {
    const { onClose } = renderSlideOver({ open: false });

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
