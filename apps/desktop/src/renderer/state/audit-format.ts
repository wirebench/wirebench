/**
 * Labels and ranges for the Audit tab (audit-log spec §3.6), kept apart from the store so a node test
 * can import them, and free of zod values (the renderer CSP trap). `audit-format.test.ts` keeps the
 * group list honest against the engine's `AUDIT_ACTION_GROUPS`.
 */
import type { AuditEventWire } from '../../shared/wire-types.js';

export const RANGE_PRESETS = ['24h', '7d', '30d', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABELS: Record<RangePreset, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};
const HOURS: Record<Exclude<RangePreset, 'all'>, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

export function rangeOf(preset: RangePreset, now: Date): { from: string | undefined; to: string | undefined } {
  if (preset === 'all') return { from: undefined, to: undefined };
  return { from: new Date(now.getTime() - HOURS[preset] * 60 * 60 * 1000).toISOString(), to: undefined };
}

export const ACTION_GROUPS = [
  'auth',
  'user',
  'team',
  'workspace',
  'secret',
  'hook',
  'ci_token',
  'license',
  'audit',
  'desktop',
] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];
export const ACTION_GROUP_LABELS: Record<ActionGroup, string> = {
  auth: 'Sign-ins',
  user: 'Users',
  team: 'Teams',
  workspace: 'Workspaces',
  secret: 'Team secrets',
  hook: 'Catch URLs',
  ci_token: 'CI tokens',
  license: 'License',
  audit: 'Audit log',
  desktop: 'Desktop activity',
};

export function actionLabel(action: string): string {
  const words = (action.split('.')[1] ?? action).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actorLabel(
  actor: Pick<AuditEventWire['actor'], 'kind'> & Partial<Pick<AuditEventWire['actor'], 'email' | 'userId' | 'tokenId'>>,
): string {
  switch (actor.kind) {
    case 'user':
      return actor.email ?? actor.userId ?? 'User';
    case 'ci-token':
      return 'CI token';
    case 'system':
      return 'Server console';
    default:
      return 'Not signed in';
  }
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export function targetLabel(event: {
  target: { kind: string; id: string | null };
  details: Record<string, unknown>;
}): string {
  const d = event.details;
  switch (event.target.kind) {
    case 'server':
      return 'This server';
    case 'user': {
      const email = str(d['emailLower']);
      return email === undefined ? 'User' : `User ${email}`;
    }
    case 'invitation':
      return `Invitation for ${str(d['emailLower']) ?? '…'}`;
    case 'team':
      return `Team ${str(d['name']) ?? str(d['previousName']) ?? ''}`.trim();
    case 'workspace':
      return `Workspace ${str(d['name']) ?? str(d['previousName']) ?? ''}`.trim();
    case 'hook':
      return `Catch URL ${str(d['name']) ?? ''}`.trim();
    case 'ci-token':
      return `CI token ${str(d['name']) ?? ''}`.trim();
    case 'license':
      return 'License';
    default:
      return event.target.kind;
  }
}
