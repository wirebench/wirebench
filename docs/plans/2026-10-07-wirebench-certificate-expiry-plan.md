# Certificate expiry warnings across a workspace — plan

Issue [#70](https://github.com/wirebench/wirebench/issues/70). Done when: endpoint chains and keystores in
the open workspace are checked, and expiry is warned about ahead of time.

## Design

- **What is checked.** Every open project of the workspace contributes:
  - its endpoints: SOAP interface endpoints, environment endpoint overrides, REST API base URLs and
    servers, TLS gRPC targets, WebSocket request URLs, absolute REST request URLs. Each is expanded under
    every environment (and none); only URLs that fully resolve to `https:`, `wss:` or a TLS gRPC target
    count. Unique `host:port` pairs are probed once.
  - its keystores (`wss/keystores.yaml`): every alias's leaf and the chain it carries.
  - the preferred CA bundle (`ssl.caBundlePath`), once for the whole workspace.
- **Probe.** A bare TLS handshake (`tls.connect`, SNI = host) — no request is sent. Through the proxy a send
  to that URL would use (HTTP `CONNECT`), verified against the trust anchors a send would use. Timeout 10 s,
  4 at a time. A chain that verifies is read (leaf to root) and judged by date. One that does not (expired,
  untrusted, wrong host) fails the handshake and Node keeps nothing of it, so it is reported as untrusted with
  OpenSSL's reason (`CERT_HAS_EXPIRED`, …) — an error, as a send there fails too. Verification stays on
  rather than being turned off to read such chains. An unreachable endpoint is reported as such, not as a
  certificate problem.
- **Threshold.** New preference `ssl.expiryWarningDays` (default 30). Expired → error; within the window →
  warning.
- **Where it shows.**
  - Problems view, source `certificate`: one row per expiring/expired certificate, so the status bar's
    problem count warns.
  - Keystores and CA bundle are local reads: checked automatically when the workspace opens and when a
    project changes. Endpoints touch the network: checked only on demand, from the command
    *Check Certificate Expiry* (also runs the local checks).
  - SSL inspector: a certificate inside the window reads in the warning tone.

## Tasks

1. Engine: `certificateExpiry`, `pemCertificates`, `tlsProbeTarget`, `probeTlsChain` (+ tests, direct and
   through the test proxy).
2. Preference `ssl.expiryWarningDays` (engine schema, wire, Preferences › Network field).
3. Desktop main: `ProjectHost.certificateSources`, workspace-wide `certificates.check` IPC channel (+ tests).
4. Renderer: Problems source `certificate`, automatic local check, the command, SSL inspector tone (+ tests).
5. User docs and changelog.
