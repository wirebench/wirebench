/** The breadcrumb's folding of a deep trail (#686 E23). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Breadcrumb, foldedTrail } from '../../src/renderer/components/breadcrumb.js';

describe('foldedTrail (#686 E23)', () => {
  it('draws a short trail as it is', () => {
    expect(foldedTrail(['Payments', 'Petstore', 'v2'])).toEqual([
      { kind: 'segment', segment: { text: 'Payments' }, whole: false },
      { kind: 'segment', segment: { text: 'Petstore' }, whole: false },
      { kind: 'segment', segment: { text: 'v2' }, whole: false },
    ]);
  });

  it('keeps the first segment whole and folds the rest of a deep trail', () => {
    expect(foldedTrail(['Payments', 'Petstore', 'v2 internal', 'legacy'])).toEqual([
      { kind: 'segment', segment: { text: 'Payments' }, whole: true },
      { kind: 'folded', segments: [{ text: 'Petstore' }, { text: 'v2 internal' }, { text: 'legacy' }] },
    ]);
  });
});

describe('Breadcrumb parts that open', () => {
  afterEach(() => {
    cleanup();
  });

  it('draws a part that opens as a button, and a plain one as text', () => {
    const openProject = vi.fn();
    render(
      <Breadcrumb
        label="Request path"
        testidPrefix="crumb"
        trail={[{ text: 'Payments', open: openProject }, 'Petstore']}
        name="Get pet"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Payments' }));
    expect(openProject).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Petstore' })).toBeNull();
    expect(screen.getByText('Petstore')).toBeTruthy();
  });

  it('opens a folded part from the … menu', async () => {
    const openFolder = vi.fn();
    render(
      <Breadcrumb
        label="Request path"
        testidPrefix="crumb"
        trail={['Payments', 'Petstore', { text: 'v2', open: openFolder }, 'legacy']}
        name="Get pet"
      />,
    );
    fireEvent.pointerDown(screen.getByTestId('crumb-folded'), { button: 0, ctrlKey: false });
    const item = (await screen.findAllByTestId('crumb-folded-segment')).find((entry) => entry.textContent === 'v2')!;
    fireEvent.click(item);
    expect(openFolder).toHaveBeenCalledOnce();
  });
});

describe('Breadcrumb with a deep trail (#686 E23)', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows the first segment and the name, and lists the folded ones behind …', async () => {
    render(
      <Breadcrumb
        label="Request path"
        testidPrefix="crumb"
        trail={['Payments', 'Petstore', 'v2 internal', 'legacy']}
        name="Find legacy pets"
      />,
    );
    const nav = screen.getByTestId('crumb');
    expect(nav.textContent).toContain('Payments');
    expect(nav.textContent).not.toContain('v2 internal');
    expect(screen.getByTestId('crumb-name').textContent).toBe('Find legacy pets');

    fireEvent.keyDown(screen.getByTestId('crumb-folded'), { key: 'Enter' });
    const folded = await screen.findAllByTestId('crumb-folded-segment');
    expect(folded.map((item) => item.textContent)).toEqual(['Petstore', 'v2 internal', 'legacy']);
  });
});
