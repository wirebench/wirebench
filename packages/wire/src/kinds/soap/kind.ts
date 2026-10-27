import type { KindModule } from '../kind-module.js';

export const soapKind = {
  kind: 'soap',
  feature: { id: 'soap', title: 'SOAP', default: true, stage: 'stable', requires: [] },
  label: 'SOAP',
  tabs: { request: 'request', container: 'interface' },
} as const satisfies KindModule<'soap'>;
