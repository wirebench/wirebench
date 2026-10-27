import type { MainKind } from '../kind-main.js';
import { SoapHost } from './host.js';
import { soapEntityIds, soapRoutes } from './router.js';
import { soapSend } from './send.js';
import { soapSearch } from './search.js';
import { soapLog } from './log.js';
import { registerSoapChannels } from './ipc.js';
import { soapMutations } from './mutations.js';

/** SOAP's main half. */
export const soapMain: MainKind<'soap'> = {
  kind: 'soap',
  createHost: (core) => new SoapHost(core),
  routes: soapRoutes,
  entityIds: soapEntityIds,
  send: soapSend,
  search: soapSearch,
  log: soapLog,
  registerChannels: registerSoapChannels,
  mutations: soapMutations,
};
