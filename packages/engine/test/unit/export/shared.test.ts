import { describe, expect, it } from 'vitest';
import { colonPath, ExportContext, isSecretOnly, uniqueFileStem } from '../../../src/export/shared.js';

describe('ExportContext.mustache', () => {
  const rewrite = (text: string): { text: string; ctx: ExportContext } => {
    const ctx = new ExportContext();
    return { text: ctx.mustache(text), ctx };
  };

  it('writes a plain reference as {{name}} with nothing to report', () => {
    const { text, ctx } = rewrite('https://${host}/a');
    expect(text).toBe('https://{{host}}/a');
    expect(ctx.report.build()).toEqual({ warnings: [], notes: [] });
  });

  it('flattens the four property scopes, noting each scope once', () => {
    const { text, ctx } = rewrite('${#Project#a} ${#Env#b} ${#Workspace#c} ${#Global#d} ${#Env#e}');
    expect(text).toBe('{{a}} {{b}} {{c}} {{d}} {{e}}');
    expect(ctx.report.build().notes).toHaveLength(4);
  });

  it('writes a secret as a variable and declares its name', () => {
    const { text, ctx } = rewrite('Bearer ${secret:apiToken}');
    expect(text).toBe('Bearer {{apiToken}}');
    expect([...ctx.secrets]).toEqual(['apiToken']);
    expect(ctx.report.build().notes[0]).toContain('apiToken');
  });

  it('keeps System, Sequence and nested references as written, with a warning', () => {
    const { text, ctx } = rewrite('${#System#HOME} ${#Sequence#id} ${a${b}}');
    expect(text).toBe('${#System#HOME} ${#Sequence#id} ${a${b}}');
    expect(ctx.report.build().warnings).toHaveLength(3);
  });

  it('turns the $${ escape into a literal ${ and leaves an unterminated one alone', () => {
    expect(rewrite('cost $${x} and ${y').text).toBe('cost ${x} and ${y');
  });
});

describe('helpers', () => {
  it('writes {name} path parameters as :name and leaves {{name}} alone', () => {
    expect(colonPath('https://h/users/{id}/pets/{petId}')).toBe('https://h/users/:id/pets/:petId');
    expect(colonPath('{{base}}/users/{id}')).toBe('{{base}}/users/:id');
    expect(colonPath('${base}/x')).toBe('${base}/x');
  });

  it('knows a value made of one secret reference', () => {
    expect(isSecretOnly('${secret:token}')).toBe(true);
    expect(isSecretOnly('Bearer ${secret:token}')).toBe(false);
    expect(isSecretOnly('${secret:bad name}')).toBe(false);
  });

  it('makes file stems unique and lower-case', () => {
    const taken = new Set<string>();
    expect(uniqueFileStem('Staging', taken)).toBe('staging');
    expect(uniqueFileStem('staging', taken)).toBe('staging-2');
    expect(uniqueFileStem('Pet Store', taken)).toBe('pet-store');
  });
});
