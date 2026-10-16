import type { WirebenchApi } from '../../../preload/build-api.js';
import { ipc } from '../../state/ipc-client.js';
import { useHostsStore } from './hosts-store.js';

type SshApi = WirebenchApi['ssh'];

/**
 * The renderer's writes to the SSH keychain. Each one, once it succeeds, bumps the hosts store's
 * `secretsRevision`, so a count read elsewhere (the SSH menu's Keychain entry) reads again rather
 * than waiting for the menu to be used.
 */
async function written<T extends { readonly ok: boolean }>(result: Promise<T>): Promise<T> {
  const settled = await result;
  if (settled.ok) useHostsStore.getState().secretsChanged();
  return settled;
}

/** Stores a secret's value under its name. */
export function storeSshSecret(request: Parameters<SshApi['setSecret']>[0]): ReturnType<SshApi['setSecret']> {
  return written(ipc().ssh.setSecret(request));
}

/** Generates a key into the keychain (its passphrase too, when it has one). */
export function generateSshKey(request: Parameters<SshApi['generateKey']>[0]): ReturnType<SshApi['generateKey']> {
  return written(ipc().ssh.generateKey(request));
}

/** Stores a key's certificate beside it, as `<secret>_cert`. */
export function attachSshCertificate(
  request: Parameters<SshApi['attachCertificate']>[0],
): ReturnType<SshApi['attachCertificate']> {
  return written(ipc().ssh.attachCertificate(request));
}
