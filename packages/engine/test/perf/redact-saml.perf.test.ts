import { describe, expect, it } from 'vitest';
import { SKIP_PERF } from '../bench/budgets.js';
import { redactXml } from '../../src/redact/index.js';

describe.skipIf(SKIP_PERF)('security-token redaction', () => {
  it('stays linear on an unclosed assertion in a large response', { retry: 1 }, () => {
    const text = '<saml2:Assertion>' + '<saml2:Assertion>'.repeat(2000) + 'x'.repeat(256 * 1024);
    redactXml(text);
    const started = performance.now();
    redactXml(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
