/** The custom name's mail (hosted edition spec §23.2): nothing without SMTP, and plain words for each notice. */
import { describe, expect, it } from 'vitest';
import { domainEmail, smtpMailer } from '../../../src/custom-domains/mail.js';

describe('smtpMailer', () => {
  it('is undefined unless both the SMTP URL and the sender are set', () => {
    expect(smtpMailer({})).toBeUndefined();
    expect(smtpMailer({ smtpUrl: 'smtp://mail.customer.test:587' })).toBeUndefined();
    expect(smtpMailer({ smtpFrom: 'wirebench@customer.test' })).toBeUndefined();
    expect(typeof smtpMailer({ smtpUrl: 'smtp://mail.customer.test:587', smtpFrom: 'wirebench@customer.test' })).toBe(
      'function',
    );
  });
});

describe('domainEmail', () => {
  it('names the domain in each notice, and tells an admin about the identity provider on activation', () => {
    const active = domainEmail('active', 'app.customer.test', 'The certificate covers the name.');
    expect(active.subject).toBe('app.customer.test now serves your team');
    expect(active.text).toMatch(/redirect URI or ACS URL/);
    const failing = domainEmail(
      'failing',
      'app.customer.test',
      'There is no TXT record at _wirebench.app.customer.test.',
    );
    expect(failing.text).toContain('There is no TXT record');
    expect(failing.text).toContain('72 hours');
    expect(domainEmail('lapsed', 'app.customer.test', 'x').subject).toBe('app.customer.test has been released');
  });
});
