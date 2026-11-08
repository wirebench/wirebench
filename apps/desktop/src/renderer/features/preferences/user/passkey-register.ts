/**
 * Adding a passkey (two-step sign-in spec §5.2): only in the browser client, where WebAuthn runs in the page on the
 * server's own origin. The desktop does not run WebAuthn (decision 4); its *Add a passkey* opens the browser client
 * at this page instead. The options come from the server after the password; the browser's answer goes back as it is.
 */
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import type { AccountPasskeyWire } from '@shared/wire-base.js';
import { ipc } from '../../../state/ipc-client.js';

export type PasskeyAdded =
  | { readonly ok: true; readonly passkey: AccountPasskeyWire; readonly recoveryCodes?: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** A name for the new passkey from the browser and system, such as "Chrome on macOS" (spec §5.2). */
export function defaultPasskeyName(userAgent: string = navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const system = /Mac OS X|Macintosh/.test(userAgent)
    ? 'macOS'
    : /Windows/.test(userAgent)
      ? 'Windows'
      : /Android/.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/.test(userAgent)
          ? 'iOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : undefined;
  return system === undefined ? browser : `${browser} on ${system}`;
}

export async function addPasskey(url: string, password: string, name: string): Promise<PasskeyAdded> {
  const options = await ipc().account.passkeyOptions({ url, password });
  if (!options.ok) return { ok: false, message: options.error.message };
  let response: unknown;
  try {
    response = await startRegistration({
      optionsJSON: options.value as unknown as PublicKeyCredentialCreationOptionsJSON,
    });
  } catch (error) {
    // The person closed the browser's prompt, or the browser cannot make one: nothing reaches the server.
    return {
      ok: false,
      message:
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'The passkey was not added.'
          : 'This browser could not add a passkey.',
    };
  }
  const added = await ipc().account.addPasskey({ url, name, response: response as Record<string, unknown> });
  if (!added.ok) return { ok: false, message: added.error.message };
  return {
    ok: true,
    passkey: added.value.passkey,
    ...(added.value.recoveryCodes !== undefined ? { recoveryCodes: added.value.recoveryCodes } : {}),
  };
}
