/**
 * The second-step page's one script (two-step sign-in spec §4.1, plan ruling 2), served at `/sign-in/two-factor.js`
 * under the page's `script-src 'self'`. Hand-written, since the server bundles no page assets: it asks the server
 * for the passkey options, runs `navigator.credentials.get`, posts the answer and follows where the server says to
 * go (the app after a browser sign-in, the desktop's loopback after its hand-off). Without it the code forms still
 * work: they are plain posts.
 */
export const TWO_FACTOR_SCRIPT_PATH = '/sign-in/two-factor.js';

export const TWO_FACTOR_SCRIPT = `'use strict';
(() => {
  const button = document.getElementById('passkey');
  const status = document.getElementById('passkey-status');
  if (button === null || status === null) return;
  const fromB64 = (text) => {
    const base = text.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const toB64 = (buffer) => {
    let raw = '';
    for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
    return btoa(raw).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };
  const flow = button.dataset.flow;
  const query = flow ? '?flow=' + encodeURIComponent(flow) : '';
  const post = async (path, body) => {
    const res = await fetch(path + query, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.message || 'The passkey could not be used. Try again or use another method.');
    return answer;
  };
  if (!window.PublicKeyCredential) {
    button.disabled = true;
    status.textContent = 'This browser cannot use passkeys.';
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const options = await post('/sign-in/two-factor/passkey/options', {});
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: fromB64(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: options.userVerification,
          allowCredentials: (options.allowCredentials || []).map((c) => ({
            type: 'public-key',
            id: fromB64(c.id),
            transports: c.transports,
          })),
        },
      });
      if (credential === null) throw new Error('No passkey was chosen.');
      const r = credential.response;
      const answer = await post('/sign-in/two-factor/passkey/verify', {
        redirectTo: button.dataset.redirect || '/',
        add: button.dataset.add === '1',
        response: {
          id: credential.id,
          rawId: toB64(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON),
            authenticatorData: toB64(r.authenticatorData),
            signature: toB64(r.signature),
            ...(r.userHandle ? { userHandle: toB64(r.userHandle) } : {}),
          },
          clientExtensionResults: credential.getClientExtensionResults(),
          ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
        },
      });
      window.location.assign(answer.location);
    } catch (error) {
      status.textContent =
        error instanceof DOMException
          ? 'The passkey was not used. Try again or use another method.'
          : error.message;
      button.disabled = false;
    }
  });
})();
`;
