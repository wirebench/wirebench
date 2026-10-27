import type { AreaModule } from '../area-module.js';

export const explorerArea = {
  id: 'explorer',
  feature: { id: 'explorer', title: 'Explorer', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'Explorer',
    icon: 'FolderTree',
    command: 'view.showExplorer',
    order: 10,
  },
  copy: {
    title: 'Explorer',
    headline: 'No project open',
    body: 'Import a WSDL or open a project to see its interfaces, operations, and requests here.',
  },
} as const satisfies AreaModule<'explorer'>;
