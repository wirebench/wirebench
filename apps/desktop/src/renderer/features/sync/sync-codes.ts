/**
 * What the Sync badge and panel say about the server-sync codes (server-sync spec §3.4, §3.5).
 *
 * Restated here rather than read from main: renderer modules import only types from
 * `shared/wire-types.ts` and the engine (a value import pulls zod in, which the CSP refuses), and
 * main's list lives beside `ServerBackend`. `test/sync-codes.test.ts` keeps the two equal. A git or
 * folder code has no entry, so those shares look exactly as they did before.
 */

/** What the Sync panel offers beside a code's message. */
export type SyncCodeAction = 'sign-in' | 'open-team-workspace';

export interface SyncCodeInfo {
  /** The badge's word while the status is `error` with this code; absent keeps *Error*. */
  readonly badge?: string;
  /** The one action the Sync panel shows beside the message; absent shows the message alone. */
  readonly action?: SyncCodeAction;
}

/** After these, main does not re-arm the fetch timer until an account changes (§3.4). */
export const STOP_POLLING_SYNC_CODES: readonly string[] = [
  'sync-signed-out',
  'sync-account-disabled',
  'sync-access-removed',
];

const SYNC_CODES: Readonly<Record<string, SyncCodeInfo>> = {
  // Each stop-polling state ends on an account change, and signing in is how the user makes one.
  'sync-signed-out': { badge: 'Sign in', action: 'sign-in' },
  'sync-account-disabled': { badge: 'Account disabled', action: 'sign-in' },
  'sync-access-removed': { badge: 'No access', action: 'sign-in' },
  // State-keeping codes: the reason is the whole message, and there is nothing to click.
  'sync-forbidden': {},
  'sync-too-large': {},
  // The local copy and the server's history no longer line up; opening it again is the fix (§3.5, §4.2).
  'sync-history-mismatch': { action: 'open-team-workspace' },
  'sync-state-corrupt': { action: 'open-team-workspace' },
};

/** The entry for `code`, or `undefined` for a code this module does not describe (every git one). */
export function syncCodeInfo(code: string | undefined): SyncCodeInfo | undefined {
  return code !== undefined && Object.hasOwn(SYNC_CODES, code) ? SYNC_CODES[code] : undefined;
}

export const SYNC_ACTION_LABELS: Readonly<Record<SyncCodeAction, string>> = {
  'sign-in': 'Sign in…',
  'open-team-workspace': 'Open a team workspace…',
};

/** Why Push and Push on save are disabled for a viewer (§3.4). */
export const VIEWER_PUSH_REASON = 'You have viewer access in this workspace; changes stay on this machine.';

/** Share refusals the dialog words itself (§3.4 step 6); main's own message for every other code. */
const SHARE_REFUSALS: Readonly<Record<string, string>> = {
  'teams-workspace-name-taken': 'A workspace with that name already exists in this team.',
};

export function shareRefusalMessage(refusal: { readonly code: string; readonly message: string }): string {
  return Object.hasOwn(SHARE_REFUSALS, refusal.code)
    ? (SHARE_REFUSALS[refusal.code] ?? refusal.message)
    : refusal.message;
}
