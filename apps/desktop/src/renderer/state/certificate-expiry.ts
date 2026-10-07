/**
 * Certificate expiry warnings in the Problems view.
 *
 * Main checks the workspace's certificates (`certificates.check`); every one that has expired, or
 * expires within the `ssl.expiryWarningDays` window, becomes a `certificate` problem — an error once
 * expired, a warning before — so the status bar's problem count says so wherever the user is.
 *
 * Two kinds of check feed it. Keystores and the CA bundle are local reads, re-checked on their own
 * whenever the open projects, their keystores or the warning window change. Endpoints are reached
 * over the network, so they are checked only by the *Check Certificate Expiry* command; a local
 * re-check leaves the endpoint rows of the last such run in place.
 */

import { showToast } from '../components/toast.js';
import type { CertificateFindingWire, CertificatesCheckResponse } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import { usePreferencesStore } from './preferences.js';
import type { Problem } from './problems.js';
import { useProblemsStore } from './problems.js';
import { useProjectStore } from './project.js';
import { useUiStore } from './ui.js';

/** The problems group every certificate row belongs to. */
export const CERTIFICATE_GROUP = 'certificates';

function plural(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

/** One finding as the sentence a Problems row shows. */
export function certificateMessage(finding: CertificateFindingWire): string {
  const date = finding.validTo.slice(0, 10);
  if (finding.status === 'expired') {
    const ago = -finding.daysLeft;
    const when = ago < 1 ? 'today' : `${plural(ago, 'day')} ago`;
    return `Certificate ${finding.subject} expired ${when} (${date}).`;
  }
  return `Certificate ${finding.subject} expires in ${plural(finding.daysLeft, 'day')} (${date}).`;
}

/** The problems a check reports: every expired or expiring certificate, and nothing that is fine. */
export function certificateProblems(response: CertificatesCheckResponse): Problem[] {
  return response.certificates
    .filter((finding) => finding.status !== 'ok')
    .map((finding) => ({
      groupId: CERTIFICATE_GROUP,
      source: 'certificate' as const,
      severity: finding.status === 'expired' ? ('error' as const) : ('warning' as const),
      problem: {
        code: `certificate-${finding.status}`,
        message: certificateMessage(finding),
        source: finding.source,
        location: finding.where,
      },
    }));
}

/**
 * Replaces the certificate problems a check covers with what it found: all of them after a check
 * that probed endpoints, and all but the endpoint rows after a local one.
 */
export function applyCertificateCheck(response: CertificatesCheckResponse): void {
  const covered = (item: Problem): boolean =>
    item.source === 'certificate' && (response.probedEndpoints || item.problem.source !== 'endpoint');
  useProblemsStore.setState((state) => ({
    items: [...state.items.filter((item) => !covered(item)), ...certificateProblems(response)],
  }));
}

/** The toast after a check the user asked for: what was found, and what could not be checked. */
export function certificateCheckSummary(response: CertificatesCheckResponse): string {
  const expired = response.certificates.filter((finding) => finding.status === 'expired').length;
  const expiring = response.certificates.filter((finding) => finding.status === 'expiring').length;
  const window = plural(response.warnDays, 'day');
  const found = [
    ...(expired > 0 ? [`${plural(expired, 'certificate')} expired`] : []),
    ...(expiring > 0 ? [`${plural(expiring, 'certificate')} expiring within ${window}`] : []),
  ];
  const parts = [found.length === 0 ? `No certificate expires within ${window}.` : `${found.join(', ')}.`];
  if (response.skipped.length > 0) {
    const names = response.skipped.map((skipped) => skipped.where).join(', ');
    parts.push(`Could not check ${plural(response.skipped.length, 'item')}: ${names}.`);
  }
  return parts.join(' ');
}

/**
 * Runs a check and puts its findings into Problems.
 *
 * @param probeEndpoints reach every TLS endpoint too (the command); without it only keystores and
 * the CA bundle are read (the automatic check)
 * @returns the response, or `undefined` when the check failed
 */
export async function checkCertificateExpiry(probeEndpoints: boolean): Promise<CertificatesCheckResponse | undefined> {
  const result = await ipc().certificates.check({ probeEndpoints });
  if (!result.ok) {
    // The automatic check runs in the background; only a check the user asked for says it failed.
    if (probeEndpoints) {
      showToast(`Certificate check failed: ${result.error.message}`);
    }
    return undefined;
  }
  applyCertificateCheck(result.value);
  return result.value;
}

/** The *Check Certificate Expiry* command: everything, endpoints included, then a summary. */
export async function runCertificateCheckCommand(): Promise<void> {
  showToast('Checking certificates…');
  const response = await checkCertificateExpiry(true);
  if (response === undefined) {
    return;
  }
  const flagged = response.certificates.some((finding) => finding.status !== 'ok');
  showToast(
    certificateCheckSummary(response),
    flagged
      ? {
          label: 'Show problems',
          onClick: () => {
            useUiStore.getState().showConsoleTab('problems');
          },
        }
      : undefined,
  );
}

/** How long the automatic check waits for a burst of project changes to settle. */
const LOCAL_CHECK_DEBOUNCE_MS = 1000;

/**
 * Re-checks keystores and the CA bundle whenever the open projects, their keystores or the warning
 * window change, and once at the start. Returns the unsubscribe function.
 */
export function subscribeToCertificateExpiry(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void checkCertificateExpiry(false);
    }, LOCAL_CHECK_DEBOUNCE_MS);
  };
  const offProject = useProjectStore.subscribe((state, previous) => {
    if (state.keystores !== previous.keystores || state.projects !== previous.projects) schedule();
  });
  const offPreferences = usePreferencesStore.subscribe((state, previous) => {
    const ssl = state.preferences.ssl;
    const before = previous.preferences.ssl;
    if (ssl.expiryWarningDays !== before.expiryWarningDays || ssl.caBundlePath !== before.caBundlePath) schedule();
  });
  schedule();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    offProject();
    offPreferences();
  };
}
