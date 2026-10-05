'use strict';
// Stands in for the binding after the `kerberos` package's lib/index.js has loaded in the same
// process: it replaces KerberosClient.prototype.step on the shared native class with an async,
// promise-only function that never calls a callback.
class KerberosClient {
  constructor(service) {
    this.service = service;
    this.contextComplete = false;
  }
  async step(challenge) {
    if (this.service.includes('fail-step')) {
      throw new Error('Server HTTP/nowhere@WIREBENCH.TEST not found in Kerberos database');
    }
    this.contextComplete = challenge !== '';
    return challenge === '' ? Buffer.from(`token-for:${this.service}`).toString('base64') : '';
  }
}
async function initializeClient(service) {
  return new KerberosClient(service);
}
module.exports = { initializeClient, KerberosClient };
