/**
 * Every auth scheme with the name a person sees for it ("Bearer token"), in the order the type
 * picker offers them. Shared so main names a scheme the same way the form does (the exported API
 * documentation states the API's auth). Types only: nothing here pulls a schema into the renderer.
 */
import type { AuthConfigWire } from './wire-base.js';

export const AUTH_TYPE_OPTIONS: readonly { readonly value: AuthConfigWire['type']; readonly label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic' },
  { value: 'ntlm', label: 'NTLM' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'api-key', label: 'API key' },
  { value: 'oauth2', label: 'OAuth2' },
  { value: 'kerberos', label: 'Kerberos' },
  { value: 'digest', label: 'Digest' },
  { value: 'aws-sigv4', label: 'AWS Signature v4' },
  { value: 'jwt', label: 'JWT (signed here)' },
];

/** A scheme's name as the type picker shows it ("Basic", "Bearer token"). */
export function authTypeLabel(type: AuthConfigWire['type']): string {
  return AUTH_TYPE_OPTIONS.find((entry) => entry.value === type)?.label ?? type;
}
