import type { AreaModule } from '../area-module.js';

export const searchArea = {
  id: 'search',
  feature: { id: 'search', title: 'Search', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'Search',
    icon: 'Search',
    command: 'view.showSearch',
    order: 30,
  },
  copy: {
    title: 'Search',
    headline: 'Search the project',
    body: 'Find operations, requests, and endpoints once a project is open.',
  },
} as const satisfies AreaModule<'search'>;
