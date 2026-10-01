/** SOAP as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { soapRun } from './run.js';
import { soapScripting } from './scripting.js';
import { soapStorage } from './storage.js';

/** The SOAP protocol: WSDL interfaces, their operations and their saved requests. */
export const soapProtocol = defineProtocol({
  kind: 'soap',
  feature: { id: 'soap', title: 'SOAP', default: true, stage: 'stable', requires: [] },
  storage: soapStorage,
  run: soapRun,
  scripting: soapScripting,
});
