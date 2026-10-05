'use strict';
// Stands in for build/Release/kerberos.node: callback-style, as the N-API binding is.
const calls = [];
class KerberosClient {
  constructor(service, options) {
    this.service = service;
    this.options = options;
    this.contextComplete = false;
  }
  step(challenge, callback) {
    calls.push({ step: challenge, service: this.service });
    this.contextComplete = challenge !== '';
    callback(null, challenge === '' ? Buffer.from(`token-for:${this.service}`).toString('base64') : '');
  }
}
function initializeClient(service, options, callback) {
  calls.push({ init: service, options });
  if (service.includes('fail-init')) return callback(new Error('No Kerberos credentials available (default cache: FILE:/tmp/krb5cc_501)'));
  callback(null, new KerberosClient(service, options));
}
module.exports = { initializeClient, KerberosClient, __calls: calls };
