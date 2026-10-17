/**
 * The pieces the layered script APIs are built from. Each one is JavaScript source that runs inside
 * the sandbox after the common API (`ScriptUnsupported`, `ExpectationFailed`, `show`, ...) and
 * declares only the names its comment lists (helpers included), so a layer author knows which names are
 * taken and a layer is these parts joined plus its own objects. Some parts
 * use names an earlier part defines (`PART_VARIABLES` and `PART_CRYPTO` use `unsupported`).
 */

/** Declares `unsupported`: a function that throws `ScriptUnsupported` naming the call. */
export const PART_UNSUPPORTED = String.raw`
const unsupported = (name) => () => {
  throw new ScriptUnsupported(name + ' is not supported: a script cannot send requests or keep cookies');
};
`;

/** Declares `asValue` and `variables`: a variable scope over `vars` and `props`. */
export const PART_VARIABLES = String.raw`
const asValue = (value) => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : value);
const variables = Object.freeze({
  get: (name) => { const v = vars.get(name); return v !== undefined ? v : props.get(name); },
  set: (name, value) => vars.set(name, asValue(value)),
  unset: (name) => vars.set(name, ''),
  has: (name) => vars.get(name) !== undefined || props.get(name) !== undefined,
  clear: unsupported('Clearing variables'),
  toObject: () => ({}),
  replaceIn: (text) => String(text).replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (whole, name) => {
    const v = variables.get(name);
    return v === undefined ? whole : String(v);
  }),
});
`;

/** Declares `typeName`, `same`, `chain` and `chaiExpect`: the chai chains collections use. */
export const PART_EXPECT = String.raw`
// --- expect: the chai chains collections use ---------------------------------------------------
const typeName = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof RegExp) return 'regexp';
  return typeof value;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chain = (actual, flags) => {
  const assert = (passed, message) => {
    if (passed === flags.not) throw new ExpectationFailed('expected ' + show(actual) + (flags.not ? ' not ' : ' ') + message);
    return self;
  };
  const self = {};
  const word = (name) => Object.defineProperty(self, name, { get: () => self });
  for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also']) word(w);
  Object.defineProperty(self, 'not', { get: () => chain(actual, { ...flags, not: !flags.not }) });
  Object.defineProperty(self, 'deep', { get: () => chain(actual, { ...flags, deep: true }) });
  const equal = (expected) => assert(flags.deep ? same(actual, expected) : Object.is(actual, expected), 'to equal ' + show(expected));
  self.equal = self.equals = self.eq = equal;
  self.eql = self.eqls = (expected) => assert(same(actual, expected), 'to deeply equal ' + show(expected));
  self.a = self.an = (type) => assert(typeName(actual) === String(type).toLowerCase(), 'to be a ' + type);
  self.include = self.includes = self.contain = self.contains = (item) => assert(
    typeof actual === 'string' ? actual.includes(String(item))
      : Array.isArray(actual) ? actual.some((x) => (flags.deep ? same(x, item) : Object.is(x, item)))
      : actual !== null && typeof actual === 'object' && item !== null && typeof item === 'object'
        ? Object.keys(item).every((k) => same(actual[k], item[k]))
        : false,
    'to include ' + show(item));
  self.property = (name, ...value) => {
    const has = actual !== null && actual !== undefined && typeof actual === 'object' && name in actual;
    assert(has && (value.length === 0 || same(actual[name], value[0])), 'to have property ' + name + (value.length === 0 ? '' : ' of ' + show(value[0])));
    return has && !flags.not ? chain(actual[name], {}) : self;
  };
  self.above = self.gt = self.greaterThan = (n) => assert(actual > n, 'to be above ' + n);
  self.below = self.lt = self.lessThan = (n) => assert(actual < n, 'to be below ' + n);
  self.least = self.gte = (n) => assert(actual >= n, 'to be at least ' + n);
  self.most = self.lte = (n) => assert(actual <= n, 'to be at most ' + n);
  self.within = (lo, hi) => assert(actual >= lo && actual <= hi, 'to be within ' + lo + '..' + hi);
  self.lengthOf = (n) => assert(actual !== null && actual !== undefined && actual.length === n, 'to have length ' + n);
  self.oneOf = (list) => assert(list.some((x) => same(x, actual)), 'to be one of ' + show(list));
  self.match = self.matches = (re) => assert(re instanceof RegExp && re.test(String(actual)), 'to match ' + String(re));
  self.string = (text) => assert(typeof actual === 'string' && actual.includes(text), 'to contain ' + show(text));
  self.keys = self.key = (...names) => {
    const list = names.length === 1 && Array.isArray(names[0]) ? names[0] : names;
    return assert(actual !== null && typeof actual === 'object' && list.every((k) => k in actual), 'to have keys ' + show(list));
  };
  const getter = (name, test, message) => Object.defineProperty(self, name, { get: () => assert(test(), message) });
  getter('true', () => actual === true, 'to be true');
  getter('false', () => actual === false, 'to be false');
  getter('ok', () => Boolean(actual), 'to be ok');
  getter('null', () => actual === null, 'to be null');
  getter('undefined', () => actual === undefined, 'to be undefined');
  getter('exist', () => actual !== null && actual !== undefined, 'to exist');
  getter('empty', () => (typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : actual !== null && typeof actual === 'object' ? Object.keys(actual).length === 0 : false), 'to be empty');
  getter('NaN', () => Number.isNaN(actual), 'to be NaN');
  self.length = (n) => self.lengthOf(n);
  return self;
};
const chaiExpect = (actual) => chain(actual, { not: false, deep: false });
`;

/** Declares `pairs`: a header or metadata list as a key/value collection. */
export const PART_PAIRS = String.raw`
const pairs = (list) => Object.freeze({
  get: (name) => list.get(name),
  has: (name, value) => (value === undefined ? list.has(name) : list.get(name) === String(value)),
  toObject: () => list.toObject(),
  all: () => list.list().map((h) => ({ key: h.name, value: h.value })),
  each: (fn) => list.list().forEach((h) => fn({ key: h.name, value: h.value })),
});
`;

/**
 * Declares `Hex`, `Base64`, `Utf8`, `Latin1`, `words`, `text`, `hashOf`, `hmacOf` and `CryptoJS`, and
 * defines `CryptoJS`, `btoa` and `atob`: hashes, HMACs and the encoders over `crypto` and `encoding`.
 */
export const PART_CRYPTO = String.raw`
// --- CryptoJS: hashes, HMACs and the encoders, over crypto and encoding --------------------------
const Hex = { name: 'hex' };
const Base64 = {
  name: 'base64',
  stringify: (words) => words.toString(Base64),
  parse: (text) => words({ utf8: encoding.fromBase64(String(text)) }),
};
const Utf8 = {
  name: 'utf8',
  stringify: (w) => w.toString(Utf8),
  parse: (text) => words({ utf8: String(text) }),
};
const Latin1 = Utf8;
const words = (source) => ({
  toString(encoder) {
    const target = encoder === undefined ? Hex : encoder;
    if (source.utf8 !== undefined) {
      if (target === Base64) return encoding.base64(source.utf8);
      if (target === Utf8) return source.utf8;
      throw new ScriptUnsupported('CryptoJS: hex of a text word array');
    }
    if (target === Utf8) throw new ScriptUnsupported('CryptoJS: a hash as UTF-8 text');
    return source.digest(target === Base64 ? 'base64' : 'hex');
  },
});
const text = (value) => (value !== null && typeof value === 'object' && typeof value.toString === 'function' ? value.toString(Utf8) : String(value));
const hashOf = (algorithm) => (data) => words({ digest: (enc) => crypto.hash(algorithm, text(data), enc) });
const hmacOf = (algorithm) => (data, key) => words({ digest: (enc) => crypto.hmac(algorithm, text(key), text(data), enc) });
const CryptoJS = Object.freeze({
  MD5: hashOf('md5'),
  SHA1: hashOf('sha1'),
  SHA256: hashOf('sha256'),
  SHA512: hashOf('sha512'),
  HmacSHA1: hmacOf('sha1'),
  HmacSHA256: hmacOf('sha256'),
  HmacSHA512: hmacOf('sha512'),
  enc: Object.freeze({ Hex, Base64, Utf8, Latin1 }),
  AES: Object.freeze({ encrypt: unsupported('CryptoJS.AES'), decrypt: unsupported('CryptoJS.AES') }),
});
define('CryptoJS', CryptoJS);
define('btoa', (value) => encoding.base64(String(value)));
define('atob', (value) => encoding.fromBase64(String(value)));
`;
