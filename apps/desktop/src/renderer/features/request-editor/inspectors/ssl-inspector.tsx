import { Copy } from 'lucide-react';
import type { ExchangeSummary, PeerCertWire, SslInfoWire } from '../../../../shared/wire-types.js';
import { InspectorIconButton } from './inspector-strip.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SslInspectorProps {
  /** The exchange whose connection to describe; absent before the first send. */
  readonly exchange: ExchangeSummary | undefined;
}

/** How long this certificate has left, as a phrase — or that it is already past its `validTo`. */
function expiry(validTo: string): { readonly text: string; readonly expired: boolean } {
  const end = new Date(validTo).getTime();
  if (Number.isNaN(end)) {
    return { text: validTo, expired: false };
  }
  const remaining = end - Date.now();
  if (remaining <= 0) {
    return { text: 'Expired', expired: true };
  }
  // Rounded up, so a certificate with hours left reads "expires in 1 day" rather than "0 days".
  const days = Math.ceil(remaining / DAY_MS);
  return { text: `expires in ${String(days)} day${days === 1 ? '' : 's'}`, expired: false };
}

/** A label/value pair of the connection summary; absent values are simply not rendered. */
function Field({ label, value }: { readonly label: string; readonly value: string | undefined }) {
  if (value === undefined || value.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 gap-2">
      <span className="shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 font-mono break-all text-fg-default">{value}</span>
    </div>
  );
}

/** Formats an ISO date for display, falling back to the raw text when it is not a date. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().replace('T', ' ').slice(0, 19);
}

function CertCard({ cert, index }: { readonly cert: PeerCertWire; readonly index: number }) {
  const { text, expired } = expiry(cert.validTo);
  return (
    <details data-testid="ssl-cert-card" open={index === 0} className="rounded border border-hairline">
      <summary className="cursor-pointer px-2 py-1 text-xs text-fg-default">
        <span className="font-mono break-all">{cert.subject}</span>
        {cert.isCA === true && <span className="ml-2 text-fg-faint">CA</span>}
      </summary>
      <div className="flex flex-col gap-1 px-2 pt-1 pb-2 text-xs">
        <Field label="Issuer" value={cert.issuer} />
        <div className="flex min-w-0 gap-2">
          <span className="shrink-0 text-fg-subtle">Valid</span>
          <span className="min-w-0 font-mono break-all text-fg-default">
            {formatDate(cert.validFrom)} → {formatDate(cert.validTo)}
          </span>
          <span className={expired ? 'shrink-0 text-status-danger' : 'shrink-0 text-fg-faint'}>{text}</span>
        </div>
        <Field label="Serial" value={cert.serialNumber} />
        <Field label="SANs" value={cert.sans.length > 0 ? cert.sans.join(', ') : undefined} />
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-fg-subtle">SHA-256</span>
          <span className="min-w-0 font-mono break-all text-fg-default">{cert.fingerprint256}</span>
          <InspectorIconButton
            label={`Copy fingerprint of ${cert.subject}`}
            onClick={() => {
              void navigator.clipboard?.writeText(cert.fingerprint256);
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </InspectorIconButton>
        </div>
      </div>
    </details>
  );
}

/** The connection summary plus the peer chain, once we know there was a TLS handshake. */
function TlsDetails({ tls }: { readonly tls: SslInfoWire }) {
  return (
    <div className="flex flex-col gap-2 p-2 text-xs">
      <div className="flex flex-col gap-1">
        <div data-testid="ssl-authorized" className="flex items-center gap-2">
          <span className={tls.authorized === true ? 'text-status-success' : 'text-status-danger'}>
            {tls.authorized === true ? '● Trusted' : '● Not trusted'}
          </span>
          {tls.authorizationError !== undefined && (
            <span className="font-mono break-all text-status-danger">{tls.authorizationError}</span>
          )}
        </div>
        <Field label="Protocol" value={tls.protocol} />
        <Field label="Cipher" value={tls.cipher} />
        <Field label="ALPN" value={tls.alpn} />
        <Field label="SNI" value={tls.servername} />
      </div>

      {tls.peerChain.length === 0 ? (
        <p className="text-fg-subtle">The peer presented no certificate.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {tls.peerChain.map((cert, index) => (
            <CertCard key={`${cert.fingerprint256}:${index}`} cert={cert} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The SSL Info inspector, shown identically in both panes: what was negotiated on the
 * connection this exchange travelled over, and the certificate chain the peer presented.
 * A plain-HTTP exchange says so rather than showing an empty table.
 */
export function SslInspector({ exchange }: SslInspectorProps) {
  if (exchange === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">No exchange yet. Send this request to inspect its connection.</p>;
  }
  const tls = exchange.http.tls;
  if (tls === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">No TLS — plain HTTP. Send over https:// to see certificates.</p>;
  }
  return <TlsDetails tls={tls} />;
}
