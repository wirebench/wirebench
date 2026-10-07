/**
 * The `certificates.*` IPC channel: how long the certificates the open workspace relies on have
 * left. Main reads the keystores and the CA bundle and, when asked, probes the endpoints; only
 * certificate metadata crosses the bridge — no key, no PEM.
 */

import { channels } from '../../shared/ipc.js';
import type { PreferencesService } from '../preferences.js';
import type { WorkspaceService } from '../workspace-service.js';
import { registerHandler } from './register.js';

/** What the `certificates.*` channel needs; a stub stands in for each in tests. */
export interface CertificateChannelDeps {
  readonly project: Pick<WorkspaceService, 'checkCertificates'>;
  /** Read on every check, so a changed warning window applies to the next one. */
  readonly preferences: Pick<PreferencesService, 'get'>;
}

/** Registers the `certificates.*` channel. */
export function registerCertificateChannels(deps: CertificateChannelDeps): void {
  registerHandler(
    channels.certificates.check,
    async (request) =>
      await deps.project.checkCertificates({
        probeEndpoints: request.probeEndpoints,
        warnDays: deps.preferences.get().ssl.expiryWarningDays,
      }),
  );
}
