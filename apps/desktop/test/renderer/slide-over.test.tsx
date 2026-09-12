import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { SlideOver } from '../../src/renderer/shell/slide-over.js';

function renderSlideOver(overrides: { width?: number } = {}) {
  const onClose = vi.fn();
  const onWidthChange = vi.fn();
  const width = overrides.width ?? 420;
  render(
    <TooltipPrimitive.Provider>
      <SlideOver label="Code" width={width} onWidthChange={onWidthChange} onClose={onClose}>
        <p>panel body</p>
      </SlideOver>
    </TooltipPrimitive.Provider>,
  );
  return { onClose, onWidthChange };
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
});
