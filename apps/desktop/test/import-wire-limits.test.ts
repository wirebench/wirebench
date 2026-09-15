import { describe, expect, it } from 'vitest';
import {
  apiImportOpenApiRequestSchema,
  apiImportPostmanRequestSchema,
  MAX_IMPORT_NAME_CHARS,
  MAX_IMPORT_TEXT_CHARS,
  openApiSourceSchema,
  postmanSourceSchema,
} from '../src/shared/wire-types.js';

describe('import request limits', () => {
  it('caps pasted text for OpenAPI and Postman sources alike', () => {
    expect(MAX_IMPORT_TEXT_CHARS).toBe(50_000_000);
    const tooLong = { kind: 'text', text: 'x'.repeat(MAX_IMPORT_TEXT_CHARS + 1) } as const;
    const atLimit = { kind: 'text', text: 'x'.repeat(MAX_IMPORT_TEXT_CHARS) } as const;

    expect(openApiSourceSchema.safeParse(tooLong).success).toBe(false);
    expect(postmanSourceSchema.safeParse(tooLong).success).toBe(false);
    expect(openApiSourceSchema.safeParse(atLimit).success).toBe(true);
    expect(postmanSourceSchema.safeParse(atLimit).success).toBe(true);
  });

  it('caps the name override at the same length for both formats', () => {
    const target = { projectId: 'p1' };
    const openApi = (name: string) =>
      apiImportOpenApiRequestSchema.safeParse({ target, source: { kind: 'text', text: '{}' }, name }).success;
    const postman = (name: string) =>
      apiImportPostmanRequestSchema.safeParse({ target, source: { kind: 'text', text: '{}' }, name }).success;
    const over = 'n'.repeat(MAX_IMPORT_NAME_CHARS + 1);
    const at = 'n'.repeat(MAX_IMPORT_NAME_CHARS);

    expect([openApi(at), postman(at)]).toEqual([true, true]);
    expect([openApi(over), postman(over)]).toEqual([false, false]);
  });
});
