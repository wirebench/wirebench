import { createSecureContext } from 'node:tls';
import forge from 'node-forge';
import { describe, expect, it } from 'vitest';
import { generateServerCert, generateTestCa } from '../helpers/test-certs.js';

/**
 * Regression guard for the flaky "asn1 … illegal padding" failures seen in
 * `integration/http/proxy.test.ts` and the `wss/outgoing/{encryption,signature}` suites.
 *
 * node-forge writes `cert.serialNumber` straight into the DER INTEGER's content bytes with no
 * sign or minimality handling: `asn1.create(..., forge.util.hexToBytes(cert.serialNumber))` in
 * `pki.getTBSCertificate`. A serial built from raw random bytes therefore produces invalid DER
 * about half the time — either a negative integer (top bit of the first byte set) or a
 * non-minimal encoding (an unconditional `00` prefix in front of a byte whose top bit is clear) —
 * both of which strict ASN.1/X.509 parsers, including Node's TLS stack, can reject.
 *
 * `generateServerCert` is memoised per commonName/SAN pair, so 200 distinct pairs force 200
 * fresh calls to `serial()` (and 200 fresh RSA-2048 keys) rather than hitting the cache.
 */
describe('test-certs serial numbers', () => {
  it('produces 200 certificates that are all valid, even-length, positive DER integers', () => {
    const ca = generateTestCa();
    const certs = Array.from({ length: 200 }, (_, i) =>
      generateServerCert(ca, { commonName: `serial-test-${i}.example`, sans: [`serial-test-${i}.example`] }),
    );

    const serials = new Set<string>();

    for (const { certPem, keyPem } of certs) {
      // Parses with forge's own strict DER integer reader.
      const parsed = forge.pki.certificateFromPem(certPem);
      const serialNumber = parsed.serialNumber;

      expect(serialNumber.length % 2).toBe(0);
      // First byte's high nibble must be < 8, i.e. the DER INTEGER is positive.
      expect(parseInt(serialNumber[0]!, 16)).toBeLessThan(8);

      serials.add(serialNumber);

      // Loads into Node's own (OpenSSL-backed) TLS stack — this is what actually rejected the
      // malformed certificates in the flaky runs, not forge's more lenient parser.
      expect(() => createSecureContext({ cert: certPem, key: keyPem })).not.toThrow();
    }

    // Serials are unique across calls (deterministic counter, not colliding random draws).
    expect(serials.size).toBe(certs.length);
    // 200 RSA-2048 keygens: comfortably inside 30s on a laptop, but the coverage job runs the
    // same work under v8 instrumentation on a shared runner, where it needs several times that.
  }, 180_000);
});
