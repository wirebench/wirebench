/**
 * JSON Schema → TypeScript, for a script's REST types (spec §Types, REST).
 *
 * An OpenAPI schema reaches the engine with its `$ref`s already resolved into shared — and possibly
 * cyclic — objects, so a named alias is given by identity, not by reference name: a node that is
 * reached twice, or that reaches itself, becomes `type WbT<n> = …` and every use of it refers to that
 * name. A keyword the mapping does not know widens its node to `unknown` rather than guessing, and
 * the whole output is bounded (depth, aliases, size), past which it widens too.
 */
import type { JsonSchema } from '../../json/schema/model.js';

/** Past these, a node is typed `unknown`. */
const LIMITS = { depth: 32, aliases: 500, outputChars: 1_000_000 } as const;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A property name as a TypeScript key. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** A JSDoc line for a description, or nothing. `*\/` inside it cannot end the comment. */
function docComment(description: unknown, indent: string): string {
  if (typeof description !== 'string' || description.trim() === '') {
    return '';
  }
  const text = description.trim().replace(/\*\//g, '*\\/').split(/\r?\n/).join(`\n${indent} * `);
  return `${indent}/** ${text} */\n`;
}

function literal(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function union(parts: readonly string[]): string {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return 'never';
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 1 ? unique[0]! : unique.map((p) => (p.includes('=>') ? `(${p})` : p)).join(' | ');
}

/**
 * Types many schemas into one set of declarations, sharing aliases between them: `typeOf` returns a
 * type expression, and `declarations()` the alias declarations those expressions use.
 */
export class JsonSchemaTypes {
  private readonly aliases = new Map<object, string>();
  private readonly declared: string[] = [];
  private readonly shared = new Set<object>();
  private size = 0;

  constructor(private readonly prefix = 'WbT') {}

  /** Marks the nodes that need an alias: those reached twice, or that reach themselves. */
  private scan(root: unknown): void {
    const seen = new Set<object>();
    const onPath = new Set<object>();
    const visit = (node: unknown, depth: number): void => {
      if (!isSchema(node) || depth > LIMITS.depth) return;
      if (onPath.has(node) || seen.has(node)) {
        this.shared.add(node);
        return;
      }
      seen.add(node);
      onPath.add(node);
      for (const child of this.children(node)) visit(child, depth + 1);
      onPath.delete(node);
    };
    visit(root, 0);
  }

  private children(node: JsonSchema): unknown[] {
    const out: unknown[] = [];
    if (isSchema(node.properties)) out.push(...Object.values(node.properties));
    if (node.items !== undefined) out.push(node.items);
    if (isSchema(node.additionalProperties)) out.push(node.additionalProperties);
    for (const list of [node.allOf, node.oneOf, node.anyOf])
      if (Array.isArray(list)) out.push(...(list as readonly unknown[]));
    return out;
  }

  typeOf(schema: unknown): string {
    this.scan(schema);
    return this.expression(schema, 0);
  }

  declarations(): string {
    return this.declared.join('');
  }

  private expression(schema: unknown, depth: number): string {
    if (!isSchema(schema) || depth > LIMITS.depth || this.size > LIMITS.outputChars) {
      return 'unknown';
    }
    const existing = this.aliases.get(schema);
    if (existing !== undefined) return existing;
    if (!this.shared.has(schema)) return this.body(schema, depth);
    if (this.aliases.size >= LIMITS.aliases) return 'unknown';
    const name = `${this.prefix}${String(this.aliases.size + 1)}`;
    // Named before its body is built, so a cycle back to it refers to the name.
    this.aliases.set(schema, name);
    const body = this.body(schema, depth);
    const declaration = `${docComment(schema.description, '')}type ${name} = ${body};\n`;
    this.size += declaration.length;
    this.declared.push(declaration);
    return name;
  }

  private body(schema: JsonSchema, depth: number): string {
    if (typeof schema.$ref === 'string') {
      // A reference the parser could not resolve.
      return 'unknown';
    }
    const nullable = schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
    let type = this.core(schema, depth);
    if (nullable && type !== 'unknown' && !type.split(' | ').includes('null')) {
      type = union([type, 'null']);
    }
    return type;
  }

  private core(schema: JsonSchema, depth: number): string {
    if (schema.const !== undefined) {
      return literal(schema.const) ?? 'unknown';
    }
    if (Array.isArray(schema.enum)) {
      const values = schema.enum.map(literal);
      return values.every((v) => v !== undefined) ? union(values) : 'unknown';
    }
    const parts: string[] = [];
    const own = this.ownType(schema, depth);
    if (own !== undefined) parts.push(own);
    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      const all = schema.allOf.map((s) => this.expression(s, depth + 1));
      if (all.includes('unknown')) return 'unknown';
      parts.push(...all);
      return parts.length === 1 ? parts[0]! : parts.map((p) => (p.includes('|') ? `(${p})` : p)).join(' & ');
    }
    for (const alternatives of [schema.oneOf, schema.anyOf]) {
      if (Array.isArray(alternatives) && alternatives.length > 0) {
        const choice = union(alternatives.map((s) => this.expression(s, depth + 1)));
        if (choice === 'unknown') return 'unknown';
        return own === undefined ? choice : `${own.includes('|') ? `(${own})` : own} & (${choice})`;
      }
    }
    return own ?? 'unknown';
  }

  /** The type the schema's own `type`, `properties` and `items` say, when they say anything. */
  private ownType(schema: JsonSchema, depth: number): string | undefined {
    const declared = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
    const types = declared.filter((t) => t !== 'null');
    if (types.length === 0) {
      if (isSchema(schema.properties) || schema.additionalProperties !== undefined)
        return this.objectType(schema, depth);
      if (schema.items !== undefined) return this.arrayType(schema, depth);
      return declared.includes('null') ? 'null' : undefined;
    }
    const mapped = types.map((type) => {
      switch (type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'array':
          return this.arrayType(schema, depth);
        case 'object':
          return this.objectType(schema, depth);
        default:
          return 'unknown';
      }
    });
    return union(mapped);
  }

  private arrayType(schema: JsonSchema, depth: number): string {
    const item = schema.items === undefined ? 'unknown' : this.expression(schema.items, depth + 1);
    return /^[A-Za-z0-9_$]+$/.test(item) ? `${item}[]` : `(${item})[]`;
  }

  private objectType(schema: JsonSchema, depth: number): string {
    const indent = '  '.repeat(Math.min(depth, 8) + 1);
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines: string[] = [];
    if (isSchema(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const optional = required.has(name) ? '' : '?';
        const doc = isSchema(property) ? docComment(property.description, indent) : '';
        lines.push(`${doc}${indent}${propertyKey(name)}${optional}: ${this.expression(property, depth + 1)};\n`);
      }
    }
    const extra = schema.additionalProperties;
    if (extra === true || (extra === undefined && !isSchema(schema.properties))) {
      lines.push(`${indent}[key: string]: unknown;\n`);
    } else if (isSchema(extra)) {
      // Beside declared properties an index signature must admit their types too, so it widens.
      const value = lines.length > 0 ? 'unknown' : `${this.expression(extra, depth + 1)} | undefined`;
      lines.push(`${indent}[key: string]: ${value};\n`);
    }
    const closing = '  '.repeat(Math.min(depth, 8));
    return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('')}${closing}}`;
  }
}
