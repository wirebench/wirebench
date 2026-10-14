import { z } from 'zod';
import { SECRET_NAME, SECRET_TOKEN } from './secret-token.js';

/** A variable name as a shell takes it: the grammar of a secret name. */
export const ENV_NAME = new RegExp(`^${SECRET_NAME.source}$`);

/**
 * A value is literal text, or a whole `${secret:NAME}` token resolved at connect. A token inside other
 * text is refused: it would otherwise be sent as written. The issue never echoes the value.
 */
const envValueSchema = z
  .union([z.string(), z.number().transform(String), z.boolean().transform(String)])
  .superRefine((value, ctx) => {
    if (value.includes('${secret:') && !SECRET_TOKEN.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'must be literal text, or a ${secret:NAME} token as the whole value' });
    }
  });

/** `env: { NAME: value }` on a host or group; an empty map reads as none, so the file round-trips. */
export const envSchema = z
  .record(z.string().regex(ENV_NAME, 'must be a variable name ([A-Za-z_][A-Za-z0-9_]*)'), envValueSchema)
  .transform((env) => (Object.keys(env).length === 0 ? undefined : env))
  .optional();

/** The secret a value names when it is a whole `${secret:NAME}` token; undefined for literal text. */
export function envSecretName(value: string): string | undefined {
  return SECRET_TOKEN.exec(value)?.[1];
}
