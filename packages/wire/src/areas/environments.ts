import type { AreaModule } from '../area-module.js';

export const environmentsArea = {
  id: 'environments',
  feature: { id: 'environments', title: 'Environments', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'Environments',
    icon: 'Braces',
    command: 'view.showEnvironments',
    order: 20,
    testId: 'activity-environments',
  },
  copy: {
    title: 'Environments',
    headline: 'No workspace open',
    body: 'Open a workspace to see its environments here.',
  },
} as const satisfies AreaModule<'environments'>;
