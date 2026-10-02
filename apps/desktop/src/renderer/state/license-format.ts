/**
 * The License tab's pure rules (licensing spec §3.8). Kept apart from the store, which reaches `window`,
 * so the node-side test can import it, and free of zod values (the renderer CSP trap). Main checks the
 * payload against the shared schema before sending (plan ruling 14); this only gives instant feedback.
 */
import type { LicenseStateWire } from '../../shared/wire-types.js';

/** The engine's `LICENSE_TEXT_PATTERN`, restated; `test/license-format.test.ts` pins its behaviour. */
const LICENSE_LINE = /^wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function licenseLineProblem(input: string): string | undefined {
  const text = input.trim();
  if (text.length === 0) return 'Paste a license, or choose a license file.';
  if (!LICENSE_LINE.test(text))
    return 'This is not a Wirebench license. A license is one line that starts with "wbl1.".';
  return undefined;
}

const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10);

/** What server admins see on the team dialog and in Accounts; nothing for members, who never get a state. */
export function bannerText(state: LicenseStateWire): string | undefined {
  if (state.status === 'grace') {
    return `This server's license expired on ${day(state.expiresAt)}. Everything keeps working until ${day(state.graceUntil)}.`;
  }
  if (state.status === 'expired') {
    return `This server is on the Community edition. ${String(state.seats.used)} of ${String(state.seats.limit)} seats are in use.`;
  }
  return undefined;
}
