import type { KindModule } from '../kind-module.js';

export const restKind = {
  kind: 'rest',
  feature: { id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] },
  label: 'REST',
  tabs: { request: 'rest-request', container: 'api', extra: ['api-docs'] },
} as const satisfies KindModule<'rest'>;
