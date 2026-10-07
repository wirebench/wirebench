/**
 * Certificate expiry across the open workspace (`certificates.check`): which endpoints and
 * keystores each project names, and how long their certificates have left.
 *
 * Keystores and the CA bundle are local reads, cheap enough to check whenever a project opens or
 * changes. Endpoints are reached over the network — one TLS handshake per `host:port`, through the
 * proxy a send would use — so they are probed only when the caller asks. No request is ever sent:
 * the handshake is the whole conversation.
 *
 * `ProjectHost` only gathers what a project names; the probing and the judging live here so they
 * can be tested without a project on disk or a network.
 */

import {
  certificateExpiry,
  expand,
  tlsProbeTarget,
  type GrpcApi,
  type PemCertificateSummary,
  type Project,
  type PropertyScopes,
  type RestFolder,
  type RestRequestDef,
  type SslInfo,
  type TlsProbeTarget,
  type WsFolder,
  type WsRequestDef,
} from '@wirebench/engine';
import type {
  CertificateFindingWire,
  CertificateSkippedWire,
  CertificatesCheckResponse,
  CertificateSourceWire,
} from '../shared/wire-types.js';

/** A URL scheme at the start of a target: when present it, not a `tls` flag, decides TLS. */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A gRPC API's target as a URL {@link tlsProbeTarget} understands, or `undefined` for plaintext. */
function grpcTargetUrl(api: Pick<GrpcApi, 'target' | 'tls'>): string | undefined {
  if (SCHEME.test(api.target)) {
    return api.target;
  }
  return api.tls ? `grpcs://${api.target}` : undefined;
}

function restRequests(folders: readonly RestFolder[], requests: readonly RestRequestDef[]): RestRequestDef[] {
  return [...requests, ...folders.flatMap((folder) => restRequests(folder.folders, folder.requests))];
}

function wsRequests(folders: readonly WsFolder[], requests: readonly WsRequestDef[]): WsRequestDef[] {
  return [...requests, ...folders.flatMap((folder) => wsRequests(folder.folders, folder.requests))];
}

/**
 * Every endpoint URL a project names, as written (so possibly holding `${…}`): SOAP interface
 * endpoints, environment endpoint overrides, REST base URLs and servers, WebSocket server URLs,
 * request URLs that name their own scheme, and TLS gRPC targets.
 *
 * @param project the open project
 * @param extra more raw URLs, e.g. the workspace environments' overrides for this project
 * @returns the distinct non-empty URLs, in model order
 */
export function endpointCandidates(project: Project, extra: readonly string[] = []): string[] {
  const urls: string[] = [];
  const ownScheme = (url: string): string[] => (SCHEME.test(url) ? [url] : []);
  for (const iface of project.interfaces) {
    urls.push(...iface.endpoints.map((endpoint) => endpoint.url));
  }
  for (const environment of project.environments) {
    urls.push(...Object.values(environment.endpoints));
  }
  for (const api of project.apis) {
    urls.push(api.baseUrl, ...api.servers.map((server) => server.url));
    urls.push(...restRequests(api.folders, api.requests).flatMap((request) => ownScheme(request.url)));
  }
  for (const api of project.grpcApis) {
    const url = grpcTargetUrl(api);
    if (url !== undefined) urls.push(url);
  }
  for (const api of project.wsApis) {
    urls.push(api.url, ...wsRequests(api.folders, api.requests).flatMap((request) => ownScheme(request.url)));
  }
  urls.push(...extra);
  return [...new Set(urls.map((url) => url.trim()).filter((url) => url.length > 0))];
}

/** One TLS endpoint to probe, with a URL that reaches it (what the proxy lookup is keyed on). */
export interface EndpointTarget extends TlsProbeTarget {
  readonly url: string;
}

/** `host:port`, bracketing an IPv6 literal: how an endpoint is named in a warning. */
export function endpointLabel(target: TlsProbeTarget): string {
  return `${target.host.includes(':') ? `[${target.host}]` : target.host}:${String(target.port)}`;
}

/**
 * The TLS endpoints behind `candidates`, each expanded under every scope set given (one per
 * environment, so an endpoint only one environment reaches is still checked). A URL that does not
 * fully resolve, or does not speak TLS, contributes nothing.
 *
 * @returns one entry per distinct `host:port`; the first URL seen reaching it wins
 */
export function resolveEndpointTargets(
  candidates: readonly string[],
  scopes: readonly PropertyScopes[],
): EndpointTarget[] {
  const byKey = new Map<string, EndpointTarget>();
  for (const candidate of candidates) {
    for (const scope of scopes) {
      const expanded = expand(candidate, scope);
      if (expanded.unresolved.length > 0) continue;
      const url = expanded.text.trim();
      const target = tlsProbeTarget(url);
      if (target === undefined) continue;
      const key = endpointLabel(target).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { ...target, url });
    }
  }
  return [...byKey.values()];
}

/** One keystore's certificates, or why it could not be read. */
export interface KeystoreCertificates {
  readonly name: string;
  /** Every alias's leaf and the chain it carries; absent when the keystore did not load. */
  readonly certificates?: readonly (PemCertificateSummary & { readonly alias: string })[];
  readonly error?: string;
}

/** What one open project contributes to the check. */
export interface ProjectCertificateSources {
  readonly projectId: string;
  readonly endpoints: readonly EndpointTarget[];
  readonly keystores: readonly KeystoreCertificates[];
}

/** What {@link checkCertificates} needs; each is a stub in tests. */
export interface CertificateCheckInput {
  readonly sources: readonly ProjectCertificateSources[];
  /** The CA bundle's own anchors (not the system roots it is added to); empty when none is set. */
  readonly caBundle: readonly PemCertificateSummary[];
  readonly warnDays: number;
  /** Probe endpoints over the network; without it only keystores and the CA bundle are read. */
  readonly probeEndpoints: boolean;
  /** Reads the chain an endpoint presents: `probeTlsChain` with the send's proxy and anchors. */
  readonly probe: (projectId: string, target: EndpointTarget) => Promise<SslInfo>;
  /** How many handshakes run at once. Default 4. */
  readonly concurrency?: number;
  readonly now?: number;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the input order in the result. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** A certificate judged against the window, or nothing when its date does not parse. */
function finding(
  base: { readonly source: CertificateSourceWire; readonly projectId?: string; readonly where: string },
  cert: { readonly subject: string; readonly validTo: string },
  warnDays: number,
  now: number,
): CertificateFindingWire | undefined {
  const expiry = certificateExpiry(cert.validTo, warnDays, now);
  if (expiry.status === 'unknown' || expiry.daysLeft === undefined) {
    return undefined;
  }
  return { ...base, subject: cert.subject, validTo: cert.validTo, status: expiry.status, daysLeft: expiry.daysLeft };
}

/**
 * Checks every certificate the workspace relies on against the warning window.
 *
 * An endpoint two projects both name is probed once, under the first project that names it. An
 * endpoint that does not answer, or a keystore that does not load, is `skipped` with the reason —
 * not a certificate problem, and not silently dropped either.
 */
export async function checkCertificates(input: CertificateCheckInput): Promise<CertificatesCheckResponse> {
  const now = input.now ?? Date.now();
  const certificates: CertificateFindingWire[] = [];
  const skipped: CertificateSkippedWire[] = [];
  const add = (found: CertificateFindingWire | undefined): void => {
    if (found !== undefined) certificates.push(found);
  };

  for (const cert of input.caBundle) {
    add(finding({ source: 'ca-bundle', where: 'CA bundle' }, cert, input.warnDays, now));
  }

  for (const source of input.sources) {
    for (const keystore of source.keystores) {
      if (keystore.certificates === undefined) {
        skipped.push({
          source: 'keystore',
          projectId: source.projectId,
          where: keystore.name,
          message: keystore.error ?? 'The keystore could not be read.',
        });
        continue;
      }
      for (const cert of keystore.certificates) {
        const where = `${keystore.name} › ${cert.alias}`;
        add(finding({ source: 'keystore', projectId: source.projectId, where }, cert, input.warnDays, now));
      }
    }
  }

  if (input.probeEndpoints) {
    const seen = new Set<string>();
    const work: { readonly projectId: string; readonly target: EndpointTarget }[] = [];
    for (const source of input.sources) {
      for (const target of source.endpoints) {
        const key = endpointLabel(target).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        work.push({ projectId: source.projectId, target });
      }
    }
    const probed = await mapLimit(work, input.concurrency ?? 4, async (item) => {
      try {
        return { item, info: await input.probe(item.projectId, item.target) };
      } catch (error) {
        return { item, error: error instanceof Error ? error.message : String(error) };
      }
    });
    for (const result of probed) {
      const base = {
        source: 'endpoint' as const,
        projectId: result.item.projectId,
        where: endpointLabel(result.item.target),
      };
      if (result.info === undefined) {
        skipped.push({ ...base, message: result.error ?? 'The endpoint did not answer.' });
        continue;
      }
      for (const cert of result.info.peerChain) {
        add(finding(base, cert, input.warnDays, now));
      }
    }
  }

  return { warnDays: input.warnDays, certificates, skipped, probedEndpoints: input.probeEndpoints };
}
