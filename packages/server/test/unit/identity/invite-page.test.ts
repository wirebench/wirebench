import { describe, expect, it } from 'vitest';
import { renderInvitePage } from '../../../src/identity/invite-page.js';

describe('the invitation page (§3.1)', () => {
  it('tells an invited person what to do, with the server URL and the code, and escapes the email', () => {
    const html = renderInvitePage({
      publicUrl: 'https://wirebench.test',
      state: 'open',
      email: 'a<b>@example.com',
      secret: 'S'.repeat(43),
    });
    expect(html).toContain('https://wirebench.test');
    expect(html).toContain('S'.repeat(43));
    expect(html).toContain('a&lt;b&gt;@example.com');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src=|href="http/);
  });
  it('renders the same page with the expired line when the invitation is closed, without a code', () => {
    const html = renderInvitePage({ publicUrl: 'https://wirebench.test', state: 'closed' });
    expect(html).toContain('This invitation has expired or was already used.');
    expect(html).not.toContain('invitation code');
  });
});
