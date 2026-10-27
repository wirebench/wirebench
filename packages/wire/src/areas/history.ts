import type { AreaModule } from '../area-module.js';

export const historyArea = {
  id: 'history',
  feature: { id: 'history', title: 'History', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'History',
    icon: 'History',
    command: 'view.showHistory',
    order: 40,
  },
  copy: {
    title: 'History',
    headline: 'Nothing sent yet',
    body: 'Every request you send is listed here with its status, duration, and size.',
  },
} as const satisfies AreaModule<'history'>;
