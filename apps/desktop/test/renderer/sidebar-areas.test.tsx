import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AREAS } from '../../src/shared/area-module.js';
import { RENDERER_AREAS } from '../../src/renderer/areas/index.js';

vi.mock('../../src/renderer/features/explorer/explorer-view.js', () => ({ ExplorerView: () => <p>explorer-view</p> }));

describe('renderer areas', () => {
  it('has a renderer half for every shared area', () => {
    for (const area of AREAS) expect(RENDERER_AREAS[area.id].View).toBeTypeOf('function');
  });

  it('renders the explorer view for the explorer area', () => {
    const View = RENDERER_AREAS.explorer.View;
    render(<View />);
    expect(screen.getByText('explorer-view')).toBeTruthy();
  });
});
