// Preloaded into the CLI child with NODE_OPTIONS=--require: makes the `kerberos` package
// unresolvable, as on a machine without the component, so the real provider reports it unavailable.
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'kerberos/package.json') {
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
  }
  return resolve.call(this, request, ...rest);
};
