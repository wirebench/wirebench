/** The breadcrumb's folding of a deep trail (#686 E23). */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Breadcrumb, foldedTrail } from '../../src/renderer/components/breadcrumb.js';

describe('foldedTrail (#686 E23)', () => {
  it('draws a short trail as it is', () => {
    expect(foldedTrail(['Payments', 'Petstore', 'v2'])).toEqual([
      { kind: 'segment', text: 'Payments', whole: false },
      { kind: 'segment', text: 'Petstore', whole: false },
      { kind: 'segment', text: 'v2', whole: false },
    ]);
  });

  it('keeps the first segment whole and folds the rest of a deep trail', () => {
    expect(foldedTrail(['Payments', 'Petstore', 'v2 internal', 'legacy'])).toEqual([
      { kind: 'segment', text: 'Payments', whole: true },
      { kind: 'folded', segments: ['Petstore', 'v2 internal', 'legacy'] },
    ]);
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
