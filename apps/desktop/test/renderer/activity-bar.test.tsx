import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ActivityBar } from '../../src/renderer/shell/activity-bar.js';

describe('ActivityBar', () => {
  afterEach(() => {
    cleanup();
  });

  it('paints itself as window chrome, so a colour theme can recolour the frame', () => {
    render(
      <TooltipPrimitive.Provider>
        <ActivityBar platform="linux" />
      </TooltipPrimitive.Provider>,
    );
    const bar = screen.getByTestId('activity-bar');
    expect(bar.hasAttribute('data-chrome')).toBe(true);
    expect(bar.className).toContain('bg-surface-chrome');
    expect(bar.className).not.toContain('bg-surface-sunken');
  });
});
