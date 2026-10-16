import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fitTabs, Tabs } from '../../src/renderer/components/tabs.js';

const ITEMS = [
  { id: 'body', label: 'Body' },
  { id: 'headers', label: 'Headers' },
  { id: 'cookies', label: 'Cookies', badge: '2' },
  { id: 'raw', label: 'Raw' },
  { id: 'snapshot', label: 'Snapshot' },
] as const;

type Id = (typeof ITEMS)[number]['id'];

describe('fitTabs', () => {
  it('keeps every tab when they all fit', () => {
    expect(fitTabs({ widths: [50, 50, 50], available: 150, moreWidth: 60, activeIndex: 0 })).toBe(3);
  });

  it('leaves room for the More button', () => {
    expect(fitTabs({ widths: [50, 50, 50, 50], available: 160, moreWidth: 60, activeIndex: 0 })).toBe(2);
  });

  it('sizes the More button to the hidden selected tab it names', () => {
    // A long selected name needs more room than "More", so one fewer tab stays in the strip.
    expect(fitTabs({ widths: [50, 50, 50, 90], available: 200, moreWidth: 60, activeIndex: 3 })).toBe(1);
  });

  it('can hide every tab behind More', () => {
    expect(fitTabs({ widths: [100, 100], available: 50, moreWidth: 60, activeIndex: 0 })).toBe(0);
  });

  it('takes the room of a pinned tab first, and counts only unpinned tabs', () => {
    // The pinned last tab keeps its 50px; of the other three, one fits beside More.
    const pinned = [false, false, false, true];
    expect(fitTabs({ widths: [50, 50, 50, 50], available: 160, moreWidth: 60, activeIndex: 0, pinned })).toBe(1);
  });
});

describe('Tabs', () => {
  afterEach(cleanup);

  it('shows every tab when there is room (jsdom has no layout)', () => {
    render(<Tabs label="Response tabs" items={ITEMS} active="body" onSelect={() => undefined} />);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByTestId('tabs-more')).toBeNull();
    // The hidden measuring copy keeps its text out of the document's text.
    expect(screen.getAllByText('Headers')).toHaveLength(1);
  });

  describe('in a narrow strip', () => {
    beforeEach(() => {
      // Every measured tab is 100px wide; the strip has 250px.
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('moves the tabs that do not fit into a More menu', async () => {
      const onSelect = vi.fn<(id: Id) => void>();
      render(<Tabs label="Response tabs" items={ITEMS} active="body" onSelect={onSelect} />);
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Body']);
      const more = screen.getByRole('button', { name: 'More Response tabs' });
      expect(more.textContent).toBe('More');

      await userEvent.click(more);
      const items = await screen.findAllByRole('menuitemradio');
      expect(items.map((item) => item.textContent)).toEqual(['Headers', 'Cookies2', 'Raw', 'Snapshot']);
      await userEvent.click(screen.getByRole('menuitemradio', { name: 'Snapshot' }));
      expect(onSelect).toHaveBeenCalledWith('snapshot');
    });

    it('names the selected tab on the More button when it is hidden', () => {
      render(<Tabs label="Response tabs" items={ITEMS} active="snapshot" onSelect={() => undefined} />);
      const more = screen.getByRole('button', { name: 'Snapshot, more Response tabs' });
      expect(more.textContent).toBe('Snapshot');
      expect(screen.queryAllByRole('tab', { selected: true })).toHaveLength(0);
    });

    it('still steps through hidden tabs with the arrow keys', async () => {
      const onSelect = vi.fn<(id: Id) => void>();
      render(<Tabs label="Response tabs" items={ITEMS} active="body" onSelect={onSelect} />);
      screen.getByRole('tab', { name: 'Body' }).focus();
      await userEvent.keyboard('{ArrowLeft}');
      expect(onSelect).toHaveBeenCalledWith('snapshot');
    });

    it('keeps a pinned tab in the strip, in its own place', () => {
      const items = [...ITEMS.slice(0, 4), { id: 'snapshot', label: 'Snapshot', pinned: true }] as const;
      render(<Tabs label="Response tabs" items={items} active="body" onSelect={() => undefined} />);
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Snapshot']);
    });

    it('counts hidden failing tabs on the More button', () => {
      const items = [
        ...ITEMS.slice(0, 4),
        { id: 'snapshot', label: 'Snapshot', badge: '0/1', tone: 'danger' },
      ] as const;
      render(<Tabs label="Response tabs" items={items} active="body" onSelect={() => undefined} />);
      const more = screen.getByRole('button', { name: 'More Response tabs, 1 with failures' });
      expect(screen.getByTestId('tabs-more-alerts').textContent).toBe('1');
      expect(more.textContent).toBe('More1');
    });
  });
});
