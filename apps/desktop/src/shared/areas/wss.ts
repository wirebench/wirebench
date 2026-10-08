import type { AreaModule } from '../area-module.js';

export const wssArea = {
  id: 'wss',
  feature: { id: 'wss', title: 'WS-Security', default: true, stage: 'stable', requires: [] },
  rail: {
    label: 'WS-Security',
    icon: 'ShieldCheck',
    command: 'view.showWss',
    order: 50,
  },
  copy: {
    title: 'WS-Security',
    headline: 'WS-Security',
    body: 'Client keystores, and the outgoing/incoming configurations requests can apply.',
  },
} as const satisfies AreaModule<'wss'>;
