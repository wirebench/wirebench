/**
 * The `Dynamic` property scope (#333): `${#Dynamic#name}`, or `${$name}` for short, resolves to a value
 * generated at send time, such as a UUID, a timestamp or a fake name. A generator may take arguments in
 * parentheses, positional (`randomInt(1,100)`) or named (`lorem(words=5)`).
 *
 * {@link DynamicValues} remembers what it generated, so one send that uses the same reference twice
 * sends the same value twice. Randomness comes from Web Crypto, so this module runs in the renderer as
 * well as in Node; it holds no zod and does no I/O.
 */

/** A generator as the completion lists it. */
export interface DynamicGeneratorInfo {
  /** The canonical name, as `${$name}` writes it. */
  readonly name: string;
  /** Other names that resolve to it (some with default arguments of their own). */
  readonly aliases: readonly string[];
  /** One line saying what it gives. */
  readonly description: string;
  /** The arguments it takes, as written inside the parentheses, when it takes any. */
  readonly usage?: string;
}

/** What a dynamic reference resolved to: a value, or why it did not resolve. */
export type DynamicResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: 'missing' | 'bad-arguments'; readonly message: string };

interface Args {
  readonly positional: readonly string[];
  readonly named: Readonly<Record<string, string>>;
}

/** Thrown inside a generator for arguments it refuses; turned into a `bad-arguments` result. */
class BadArguments extends Error {}

interface Generator {
  readonly description: string;
  readonly usage?: string;
  /** Returns the value, or throws {@link BadArguments}. */
  readonly run: (args: Args, now: Date) => string;
}

// ---------------------------------------------------------------- randomness

/** A uniformly random integer in `[0, n)`, for `n` up to 2^32. */
function below(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buffer = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    const drawn = buffer[0]!;
    if (drawn < limit) return drawn % n;
  }
}

/** A uniformly random integer in `[min, max]`. */
function between(min: number, max: number): number {
  return min + below(max - min + 1);
}

function pick<T>(items: readonly T[]): T {
  return items[below(items.length)]!;
}

function hex(digits: number): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += below(16).toString(16);
  return out;
}

// ---------------------------------------------------------------- word lists

// prettier-ignore
const FIRST_NAMES = [
  'Ada', 'Alan', 'Amara', 'Anna', 'Ben', 'Carla', 'Chen', 'Daniel', 'Elena', 'Emma', 'Farah', 'Grace',
  'Hana', 'Ivan', 'James', 'Jonas', 'Kofi', 'Laila', 'Liam', 'Maria', 'Mateo', 'Mia', 'Nadia', 'Noah',
  'Omar', 'Priya', 'Rosa', 'Sam', 'Sofia', 'Tomas', 'Yara', 'Zoe',
];
// prettier-ignore
const LAST_NAMES = [
  'Adams', 'Baker', 'Costa', 'Dubois', 'Evans', 'Fischer', 'Garcia', 'Hansen', 'Ito', 'Jensen', 'Khan',
  'Lopez', 'Martin', 'Nakamura', 'Novak', 'Okafor', 'Patel', 'Quinn', 'Rossi', 'Silva', 'Smith', 'Tanaka',
  'Ueda', 'Varga', 'Weber', 'Young', 'Zhang',
];
const STREET_SUFFIXES = ['Street', 'Road', 'Avenue', 'Lane', 'Way', 'Drive', 'Court', 'Place'];
// prettier-ignore
const CITIES = [
  'Amsterdam', 'Auckland', 'Berlin', 'Bogota', 'Cairo', 'Chicago', 'Dublin', 'Lagos', 'Lisbon', 'Madrid',
  'Montreal', 'Mumbai', 'Nairobi', 'Oslo', 'Paris', 'Seoul', 'Sydney', 'Tokyo', 'Toronto', 'Vienna',
];
// prettier-ignore
const COUNTRIES: readonly (readonly [string, string])[] = [
  ['Australia', 'AU'], ['Austria', 'AT'], ['Brazil', 'BR'], ['Canada', 'CA'], ['Colombia', 'CO'],
  ['Egypt', 'EG'], ['France', 'FR'], ['Germany', 'DE'], ['India', 'IN'], ['Ireland', 'IE'], ['Japan', 'JP'],
  ['Kenya', 'KE'], ['Mexico', 'MX'], ['Netherlands', 'NL'], ['New Zealand', 'NZ'], ['Nigeria', 'NG'],
  ['Norway', 'NO'], ['Portugal', 'PT'], ['South Korea', 'KR'], ['Spain', 'ES'], ['United Kingdom', 'GB'],
  ['United States', 'US'],
];
const COMPANY_SUFFIXES = ['Group', 'Labs', 'Systems', 'Partners', 'Industries', 'Holdings', 'Ltd', 'Inc'];
// prettier-ignore
const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do', 'eiusmod',
  'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim',
  'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea',
  'commodo', 'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate', 'velit', 'esse',
  'cillum', 'fugiat', 'nulla', 'pariatur',
];
const DOMAIN_WORDS = ['acme', 'blue', 'cloud', 'data', 'fast', 'green', 'net', 'north', 'pixel', 'star', 'web'];
const TLDS = ['com', 'org', 'net', 'io', 'dev', 'test'];
// prettier-ignore
const COLORS = [
  'black', 'blue', 'brown', 'cyan', 'gold', 'green', 'grey', 'indigo', 'lime', 'magenta', 'maroon', 'navy',
  'olive', 'orange', 'pink', 'purple', 'red', 'silver', 'teal', 'violet', 'white', 'yellow',
];
const CURRENCIES = ['AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'INR', 'JPY', 'MXN', 'NOK', 'SEK', 'USD', 'ZAR'];
// prettier-ignore
const FILE_TYPES: readonly (readonly [string, string])[] = [
  ['txt', 'text/plain'], ['csv', 'text/csv'], ['html', 'text/html'], ['json', 'application/json'],
  ['xml', 'application/xml'], ['pdf', 'application/pdf'], ['zip', 'application/zip'], ['png', 'image/png'],
  ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['mp3', 'audio/mpeg'],
  ['mp4', 'video/mp4'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
];

// ---------------------------------------------------------------- arguments

function noArgs(args: Args): void {
  if (args.positional.length > 0 || Object.keys(args.named).length > 0) {
    throw new BadArguments('takes no arguments');
  }
}

/** The argument at `index` or named `name`, whichever was given; `undefined` when neither. */
function arg(args: Args, index: number, name: string): string | undefined {
  return args.named[name] ?? args.positional[index];
}

function only(args: Args, names: readonly string[], maxPositional: number): void {
  if (args.positional.length > maxPositional) throw new BadArguments('too many arguments');
  for (const name of Object.keys(args.named)) {
    if (!names.includes(name)) throw new BadArguments(`unknown argument "${name}"`);
  }
}

function integer(text: string | undefined, fallback: number, min: number, max: number, what: string): number {
  if (text === undefined) return fallback;
  if (!/^[+-]?\d{1,15}$/.test(text)) throw new BadArguments(`${what} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new BadArguments(`${what} must be between ${min} and ${max}`);
  return n;
}

const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `now` moved by an offset such as `+1d` or `-30m`; `now` itself when there is none. */
function offsetTime(args: Args, now: Date): number {
  only(args, ['offset'], 1);
  const text = arg(args, 0, 'offset');
  if (text === undefined) return now.getTime();
  const match = /^([+-]?)(\d{1,9})([smhdw])$/.exec(text);
  if (match === null) throw new BadArguments('the offset must look like +1d, -2h or 30m');
  const sign = match[1] === '-' ? -1 : 1;
  return now.getTime() + sign * Number(match[2]) * UNIT_MS[match[3]!]!;
}

/** A date within `days` of `now`, before it (`direction` -1) or after it (+1). */
function dateWithin(args: Args, now: Date, fallbackDays: number, direction: 1 | -1): string {
  only(args, ['days'], 1);
  const days = integer(arg(args, 0, 'days'), fallbackDays, 1, 36_500, 'days');
  return new Date(now.getTime() + direction * below(days * 86_400) * 1000).toISOString();
}

// ---------------------------------------------------------------- generators

function firstName(): string {
  return pick(FIRST_NAMES);
}

function lastName(): string {
  return pick(LAST_NAMES);
}

function word(): string {
  return pick(LOREM);
}

function sentence(): string {
  const words = Array.from({ length: between(6, 12) }, word).join(' ');
  return `${words[0]!.toUpperCase()}${words.slice(1)}.`;
}

function paragraph(): string {
  return Array.from({ length: between(3, 5) }, sentence).join(' ');
}

function domain(): string {
  return `${pick(DOMAIN_WORDS)}${pick(DOMAIN_WORDS)}.${pick(TLDS)}`;
}

function lorem(args: Args): string {
  only(args, ['words', 'sentences', 'paragraphs'], 0);
  const given = Object.keys(args.named);
  if (given.length > 1) throw new BadArguments('give one of words, sentences or paragraphs');
  const [kind = 'sentences'] = given;
  const count = integer(args.named[kind], 1, 1, 1000, kind);
  if (kind === 'words') return Array.from({ length: count }, word).join(' ');
  if (kind === 'paragraphs') return Array.from({ length: count }, paragraph).join('\n\n');
  return Array.from({ length: count }, sentence).join(' ');
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

const GENERATORS: Readonly<Record<string, Generator>> = {
  guid: { description: 'A random UUID (version 4)', run: (args) => (noArgs(args), globalThis.crypto.randomUUID()) },
  timestamp: {
    description: 'The current time in Unix seconds',
    usage: 'offset, e.g. +1d or -30m',
    run: (args, now) => String(Math.floor(offsetTime(args, now) / 1000)),
  },
  isoTimestamp: {
    description: 'The current time in ISO 8601 (UTC)',
    usage: 'offset, e.g. +1d or -30m',
    run: (args, now) => new Date(offsetTime(args, now)).toISOString(),
  },
  randomInt: {
    description: 'A whole number, 0 to 1000 unless bounds are given',
    usage: 'min,max',
    run: (args) => {
      only(args, ['min', 'max'], 2);
      const min = integer(arg(args, 0, 'min'), 0, -1e15, 1e15, 'min');
      const max = integer(arg(args, 1, 'max'), Math.max(min, 1000), -1e15, 1e15, 'max');
      if (min > max) throw new BadArguments('min must not be greater than max');
      if (max - min >= 0x1_0000_0000) throw new BadArguments('the range is too wide');
      return String(between(min, max));
    },
  },
  randomBoolean: { description: 'true or false', run: (args) => (noArgs(args), String(below(2) === 1)) },
  randomAlphaNumeric: {
    description: 'Random letters and digits, one unless a length is given',
    usage: 'length',
    run: (args) => {
      only(args, ['length'], 1);
      const length = integer(arg(args, 0, 'length'), 1, 1, 4096, 'length');
      return Array.from({ length }, () => ALPHANUMERIC[below(ALPHANUMERIC.length)]).join('');
    },
  },
  firstName: { description: 'A first name', run: (args) => (noArgs(args), firstName()) },
  lastName: { description: 'A last name', run: (args) => (noArgs(args), lastName()) },
  fullName: { description: 'A first and last name', run: (args) => (noArgs(args), `${firstName()} ${lastName()}`) },
  userName: {
    description: 'A user name',
    run: (args) => (noArgs(args), `${firstName()}.${lastName()}${between(1, 99)}`.toLowerCase()),
  },
  email: {
    description: 'An email address at an example domain',
    run: (args) => (noArgs(args), `${firstName()}.${lastName()}@example.${pick(['com', 'org', 'net'])}`.toLowerCase()),
  },
  phone: {
    description: 'A phone number in the reserved 555 range',
    run: (args) => (noArgs(args), `+1-555-${between(100, 999)}-${String(below(10_000)).padStart(4, '0')}`),
  },
  streetAddress: {
    description: 'A street address',
    run: (args) => (noArgs(args), `${between(1, 9999)} ${lastName()} ${pick(STREET_SUFFIXES)}`),
  },
  city: { description: 'A city', run: (args) => (noArgs(args), pick(CITIES)) },
  country: { description: 'A country', run: (args) => (noArgs(args), pick(COUNTRIES)[0]) },
  countryCode: { description: 'A two-letter country code', run: (args) => (noArgs(args), pick(COUNTRIES)[1]) },
  company: {
    description: 'A company name',
    run: (args) => (noArgs(args), `${lastName()} ${pick(COMPANY_SUFFIXES)}`),
  },
  lorem: {
    description: 'Placeholder text, one sentence unless told otherwise',
    usage: 'words=N, sentences=N or paragraphs=N',
    run: lorem,
  },
  datePast: {
    description: 'A date in the past year, ISO 8601',
    usage: 'days',
    run: (args, now) => dateWithin(args, now, 365, -1),
  },
  dateFuture: {
    description: 'A date in the coming year, ISO 8601',
    usage: 'days',
    run: (args, now) => dateWithin(args, now, 365, 1),
  },
  dateRecent: {
    description: 'A date in the last day, ISO 8601',
    usage: 'days',
    run: (args, now) => dateWithin(args, now, 1, -1),
  },
  ip: {
    description: 'An IPv4 address',
    run: (args) => (noArgs(args), [between(1, 223), below(256), below(256), between(1, 254)].join('.')),
  },
  ipv6: {
    description: 'An IPv6 address',
    run: (args) => (noArgs(args), Array.from({ length: 8 }, () => hex(4)).join(':')),
  },
  mac: {
    description: 'A MAC address',
    run: (args) => (noArgs(args), Array.from({ length: 6 }, () => hex(2)).join(':')),
  },
  url: { description: 'An https URL', run: (args) => (noArgs(args), `https://${domain()}`) },
  domain: { description: 'A domain name', run: (args) => (noArgs(args), domain()) },
  color: { description: 'A colour name', run: (args) => (noArgs(args), pick(COLORS)) },
  hexColor: { description: 'A colour as #rrggbb', run: (args) => (noArgs(args), `#${hex(6)}`) },
  currencyCode: { description: 'An ISO 4217 currency code', run: (args) => (noArgs(args), pick(CURRENCIES)) },
  price: {
    description: 'A price with two decimals',
    run: (args) => (noArgs(args), (between(100, 99_999) / 100).toFixed(2)),
  },
  fileName: {
    description: 'A file name with an extension',
    run: (args) => (noArgs(args), `${word()}.${pick(FILE_TYPES)[0]}`),
  },
  mimeType: { description: 'A MIME type', run: (args) => (noArgs(args), pick(FILE_TYPES)[1]) },
};

/** Other spellings, the `random…` ones imported files use among them, with any arguments they imply. */
const ALIASES: Readonly<Record<string, { readonly name: string; readonly args?: string }>> = {
  uuid: { name: 'guid' },
  randomUUID: { name: 'guid' },
  randomFirstName: { name: 'firstName' },
  randomLastName: { name: 'lastName' },
  randomFullName: { name: 'fullName' },
  randomUserName: { name: 'userName' },
  randomEmail: { name: 'email' },
  randomExampleEmail: { name: 'email' },
  randomPhoneNumber: { name: 'phone' },
  randomStreetAddress: { name: 'streetAddress' },
  randomCity: { name: 'city' },
  randomCountry: { name: 'country' },
  randomCountryCode: { name: 'countryCode' },
  randomCompanyName: { name: 'company' },
  randomWord: { name: 'lorem', args: 'words=1' },
  randomWords: { name: 'lorem', args: 'words=3' },
  randomLoremWord: { name: 'lorem', args: 'words=1' },
  randomLoremWords: { name: 'lorem', args: 'words=3' },
  randomLoremSentence: { name: 'lorem', args: 'sentences=1' },
  randomLoremSentences: { name: 'lorem', args: 'sentences=3' },
  randomLoremParagraph: { name: 'lorem', args: 'paragraphs=1' },
  randomLoremParagraphs: { name: 'lorem', args: 'paragraphs=3' },
  randomDatePast: { name: 'datePast' },
  randomDateFuture: { name: 'dateFuture' },
  randomDateRecent: { name: 'dateRecent' },
  randomIP: { name: 'ip' },
  randomIPV6: { name: 'ipv6' },
  randomMACAddress: { name: 'mac' },
  randomUrl: { name: 'url' },
  randomDomainName: { name: 'domain' },
  randomColor: { name: 'color' },
  randomHexColor: { name: 'hexColor' },
  randomCurrencyCode: { name: 'currencyCode' },
  randomPrice: { name: 'price' },
  randomFileName: { name: 'fileName' },
  randomMimeType: { name: 'mimeType' },
};

/** Every generator, in the order the completion lists them. */
export const DYNAMIC_GENERATORS: readonly DynamicGeneratorInfo[] = Object.entries(GENERATORS).map(
  ([name, generator]) => ({
    name,
    aliases: Object.keys(ALIASES).filter((alias) => ALIASES[alias]!.name === name),
    description: generator.description,
    ...(generator.usage !== undefined ? { usage: generator.usage } : {}),
  }),
);

/** True when `name` (no arguments) is a generator or one of its aliases. */
export function isDynamicName(name: string): boolean {
  return Object.hasOwn(GENERATORS, name) || Object.hasOwn(ALIASES, name);
}

// ---------------------------------------------------------------- parsing

interface Call {
  readonly name: string;
  readonly args: Args;
  /** A key equal for every spelling of the same call: canonical name plus normalised arguments. */
  readonly key: string;
}

const CALL = /^([A-Za-z][A-Za-z0-9]*)(?:\((.*)\))?$/s;

function parseArgs(text: string | undefined): Args {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  if (text === undefined || text.trim() === '') return { positional, named };
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    const eq = /^([A-Za-z]+)\s*=\s*(.*)$/s.exec(trimmed);
    if (eq !== null) {
      if (Object.hasOwn(named, eq[1]!)) throw new BadArguments(`"${eq[1]}" is given twice`);
      named[eq[1]!] = eq[2]!.trim();
    } else {
      positional.push(trimmed);
    }
  }
  return { positional, named };
}

/** `expr` as a call, or a result saying why it is not one. */
function parseCall(expr: string): Call | Exclude<DynamicResult, { ok: true }> {
  const trimmed = expr.trim();
  const match = CALL.exec(trimmed);
  if (match === null) {
    const name = /^[A-Za-z][A-Za-z0-9]*/.exec(trimmed)?.[0];
    return name !== undefined && isDynamicName(name)
      ? { ok: false, code: 'bad-arguments', message: `${name}: the arguments are not closed with ")"` }
      : { ok: false, code: 'missing', message: `There is no dynamic value called "${trimmed}"` };
  }
  const written = match[1]!;
  const alias = Object.hasOwn(ALIASES, written) ? ALIASES[written] : undefined;
  const name = alias?.name ?? written;
  if (!Object.hasOwn(GENERATORS, name)) {
    return { ok: false, code: 'missing', message: `There is no dynamic value called "${written}"` };
  }
  try {
    const args = parseArgs(match[2] ?? alias?.args);
    const named = Object.keys(args.named)
      .sort()
      .map((key) => `${key}=${args.named[key]}`);
    return { name, args, key: `${name}(${[...args.positional, ...named].join(',')})` };
  } catch (error) {
    if (error instanceof BadArguments)
      return { ok: false, code: 'bad-arguments', message: `${written}: ${error.message}` };
    throw error;
  }
}

function run(call: Call, now: Date): DynamicResult {
  try {
    return { ok: true, value: GENERATORS[call.name]!.run(call.args, now) };
  } catch (error) {
    if (error instanceof BadArguments) {
      return { ok: false, code: 'bad-arguments', message: `${call.name}: ${error.message}` };
    }
    throw error;
  }
}

/** A fresh value for `expr` (a generator name with optional arguments), not remembered. */
export function generateDynamic(expr: string, now: Date = new Date()): DynamicResult {
  const call = parseCall(expr);
  return 'key' in call ? run(call, now) : call;
}

/**
 * The dynamic values of one send: each distinct reference is generated once and then given back the
 * same, so `${$guid}` in a URL and a header carries one value. One instance per send; the clock is
 * read once, when it is made.
 */
export class DynamicValues {
  private readonly values = new Map<string, DynamicResult>();
  private readonly now: Date;

  constructor(now: Date = new Date()) {
    this.now = now;
  }

  resolve(expr: string): DynamicResult {
    const call = parseCall(expr);
    if (!('key' in call)) return call;
    const known = this.values.get(call.key);
    if (known !== undefined) return known;
    const result = run(call, this.now);
    this.values.set(call.key, result);
    return result;
  }
}
