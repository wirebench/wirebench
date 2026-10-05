/** Regenerates the signed assertion fixtures: `node --experimental-transform-types packages/engine/test/fixtures/saml/make.ts`. */
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// The sources import each other as `./x.js`; Node runs `.ts` directly but does not map that
// suffix, so a resolve hook retries a missing `.js` specifier as `.ts` before loading them.
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); }
      catch (error) {
        if (specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context);
        throw error;
      }
    }`),
);
const { buildSamlAssertion } = await import('../../../src/wss/saml/build.js');
const { generateSigningCert, generateTestCa } = await import('../../helpers/test-certs.js');

const ca = generateTestCa();
const issuer = generateSigningCert(ca);
const alias = { alias: 'issuer', certPem: issuer.certPem, keyPem: issuer.keyPem, chainPem: [ca.certPem] } as never;
const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
for (const version of ['2.0', '1.1'] as const) {
  const xml = buildSamlAssertion(
    {
      kind: 'saml-token',
      source: 'form',
      version,
      issuer: 'urn:sts:fixture',
      subject: 'alice',
      confirmation: 'bearer',
      lifetimeSeconds: 3600,
      attributes: [],
      sign: { keystoreRef: 'x', signatureAlgorithm: 'rsa-sha256' },
    },
    { clock: () => new Date('2026-10-05T10:00:00.000Z'), uuid: () => `fixture-${version}`, signing: { alias } },
  );
  writeFileSync(here(`assertion-${version}.xml`), xml);
}
writeFileSync(here('issuer-cert.pem'), issuer.certPem);
