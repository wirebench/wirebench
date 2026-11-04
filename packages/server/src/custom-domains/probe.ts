/**
 * The certificate probe (hosted edition spec §23.4): what moves a `verified` name to `active`. It opens TLS to the
 * proxy at `WIREBENCH_SERVER_PROXY_TLS_ADDRESS` (`traefik:443` in the recipe) with the name as SNI, and passes only
 * when the chain verifies against the system roots, or against `WIREBENCH_SERVER_PROXY_TLS_CA_FILE` instead when that
 * is set, and the certificate covers the name. It sends nothing over the connection and closes it at once.
 *
 * - `ok`: a certificate for the name that verifies.
 * - `wrong`: a certificate came, but it does not verify or does not cover the name. Until Traefik has issued one, this
 *   is its own default certificate.
 * - `missing`: no certificate at all: the proxy refused, reset or did not answer within 5 seconds.
 */
import { readFile } from 'node:fs/promises';
import { checkServerIdentity, connect } from 'node:tls';
import { parseHostPort, type ServerConfig } from '../config.js';
import type { CertificateProbe, ProbeResult } from './job.js';

/** How long a probe waits for the proxy's handshake (spec §23.4). */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeOptions {
  /** The proxy's TLS address. */
  readonly host: string;
  readonly port: number;
  /** PEM roots to verify against instead of the system's; the Pebble test's CA, say. */
  readonly ca?: string;
  readonly timeoutMs?: number;
}

/** A probe against the proxy at `options`. Never throws: every failure is a verdict with its reason in words. */
export function certificateProbe(options: ProbeOptions): CertificateProbe {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return (name) =>
    new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const finish = (result: ProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      // Verified below rather than refused in the handshake, so a certificate that fails is told from none at all.
      const socket = connect({
        host: options.host,
        port: options.port,
        servername: name,
        rejectUnauthorized: false,
        ...(options.ca !== undefined ? { ca: options.ca } : {}),
        ALPNProtocols: ['http/1.1'],
      });
      const timer = setTimeout(() => {
        finish({ verdict: 'missing', message: `The proxy did not answer within ${String(timeoutMs / 1000)} seconds.` });
      }, timeoutMs);
      socket.once('secureConnect', () => {
        const certificate = socket.getPeerCertificate();
        if (Object.keys(certificate).length === 0) {
          finish({ verdict: 'missing', message: 'The proxy sent no certificate for this name.' });
          return;
        }
        // Node reports a name the certificate does not cover as an authorization error too, since the probe sends
        // the name as SNI; anything else it reports is the chain.
        const failure = socket.authorizationError as (Error & { readonly code?: string }) | string | null;
        const reason = typeof failure === 'string' ? failure : (failure?.code ?? failure?.message);
        const notCovering = reason === 'ERR_TLS_CERT_ALTNAME_INVALID';
        if (!socket.authorized && !notCovering) {
          finish({
            verdict: 'wrong',
            message: `The proxy's certificate for this name is not trusted yet (${reason ?? 'unverified'}).`,
          });
          return;
        }
        if (notCovering || checkServerIdentity(name, certificate) !== undefined) {
          finish({ verdict: 'wrong', message: "The proxy's certificate does not cover this name yet." });
          return;
        }
        finish({ verdict: 'ok', message: 'The certificate for this name is live.' });
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        finish({
          verdict: 'missing',
          message: `The proxy could not be reached for a certificate${error.code !== undefined ? ` (${error.code})` : ''}.`,
        });
      });
    });
}

/**
 * The probe `config` asks for: undefined without `WIREBENCH_SERVER_PROXY_TLS_ADDRESS` (or outside hosted mode), and
 * then a verified name waits in `verified`.
 *
 * @throws Error when `WIREBENCH_SERVER_PROXY_TLS_CA_FILE` cannot be read.
 */
export async function probeFromConfig(
  config: Pick<ServerConfig, 'mode' | 'proxyTlsAddress' | 'proxyTlsCaFile'>,
): Promise<CertificateProbe | undefined> {
  if (config.mode !== 'hosted' || config.proxyTlsAddress === undefined) return undefined;
  const address = parseHostPort(config.proxyTlsAddress);
  if (address === undefined) return undefined;
  let ca: string | undefined;
  if (config.proxyTlsCaFile !== undefined) {
    try {
      ca = await readFile(config.proxyTlsCaFile, 'utf8');
    } catch (error) {
      const code = (error as { readonly code?: unknown }).code;
      throw new Error(
        `WIREBENCH_SERVER_PROXY_TLS_CA_FILE cannot be read${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }
  }
  return certificateProbe({ ...address, ...(ca !== undefined ? { ca } : {}) });
}
