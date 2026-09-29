/**
 * The one redaction step every op result passes (spec §2.2): the engine's pattern redactors where a
 * header, URL or body is built, then every secret value the call resolved, masked everywhere.
 */
import { createSecretMasker, redactStructuredBody, redactXml } from '@wirebench/engine';
import { maskDeep } from '../reporters/mask.js';
import { OpsError } from './errors.js';

/** A body as an op returns it: a WS-Security password or a JSON/form secret key masked by pattern. */
export function redactBody(text: string, contentType: string | undefined): string {
  const xml = contentType?.toLowerCase().includes('xml') === true || text.trimStart().startsWith('<');
  return xml ? redactXml(text, { show: false }) : redactStructuredBody(text, contentType, { show: false });
}

/** Every string in `value`, at any depth, with every revealed secret masked. */
export function redactResult<R>(value: R, revealed: ReadonlySet<string>): R {
  return maskDeep(value, createSecretMasker([...revealed])) as R;
}

export function redactError(error: OpsError, revealed: ReadonlySet<string>): OpsError {
  const mask = createSecretMasker([...revealed]);
  return new OpsError(
    error.code,
    mask(error.message),
    error.details === undefined ? undefined : (maskDeep(error.details, mask) as Readonly<Record<string, unknown>>),
  );
}
