# Bruno classic on-disk format (folders of `.bru` files) - importer research

Scope: the classic Bru-language collection format, plus the boundary against OpenCollection YAML and the single-file JSON export.
Primary sources are pinned to the release tag **v4.2.1** (latest release at research time, 2026-10-15) of `usebruno/bruno`.
`main` was at commit `cdb682816fce39c8f5b96949ac1c99e618910f69` at the same time.
Base for all repo links: `https://github.com/usebruno/bruno/blob/v4.2.1/` (raw: `https://raw.githubusercontent.com/usebruno/bruno/v4.2.1/`).
Anything not confirmed from source is marked **UNCONFIRMED**. Nothing was executed; the sample files below are hand-derived from the grammar, not run through the parser.

Short names for sources used throughout:

- `BRU` = `packages/bruno-lang/v2/src/bruToJson.js` (request/folder-less `.bru` grammar + semantics)
- `COLL` = `packages/bruno-lang/v2/src/collectionBruToJson.js` (grammar for `collection.bru` and `folder.bru`)
- `ENV` = `packages/bruno-lang/v2/src/envToJson.js` (grammar for `environments/*.bru`)
- `J2B` = `packages/bruno-lang/v2/src/jsonToBru.js` (the writer; shows what Bruno itself emits)
- `UT` = `packages/bruno-lang/v2/src/utils.js`
- `FS` = `packages/bruno-electron/src/utils/filesystem.js`
- `WATCH` = `packages/bruno-electron/src/app/collection-watcher.js`
- `SCHEMA` = `packages/bruno-schema/src/collections/index.js`
- `FILESTORE` = `packages/bruno-filestore/src/formats/bru/index.ts`

---

## 0. Executive summary and boundaries

1. **Since v4 the default new-collection format is YAML**, not `.bru` (`packages/bruno-filestore/src/constants.ts`: `DEFAULT_COLLECTION_FORMAT = 'yml'`). Classic `.bru` is still fully read and written. Real-world repos will contain both generations.
2. **Detection on disk** (authoritative, `FS` `getCollectionFormat`, https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-electron/src/utils/filesystem.js):
   - `opencollection.yml` exists in the root -> format `yml` (OpenCollection). **Checked first, so it wins even if `bruno.json` is also present.**
   - else `bruno.json` exists -> format `bru` (classic).
   - else error "No collection configuration found".
   - A directory is a valid collection if either file exists (`isValidCollectionDirectory`, same file).
   - In classic format, request files are `*.bru` (case-insensitive extension test, `hasRequestExtension`); in yml format `*.yml`. Extensions are not mixed within one collection.
3. **Classic vs OpenCollection YAML at the file level**:

   | Marker | Classic `.bru` | OpenCollection YAML |
   |---|---|---|
   | root config | `bruno.json` (JSON) | `opencollection.yml` (carries both collection root and Bruno config) |
   | collection root | `collection.bru` | inside `opencollection.yml` |
   | folder root | `folder.bru` | `folder.yml` |
   | requests | `*.bru` | `*.yml` |
   | environments | `environments/*.bru` | `environments/*.yml` |
   | marker value | `bruno.json` has `"version": "1"` | `opencollection.yml` has a top-level `opencollection: <semver>` string and `info:` object |

   Sources: `WATCH` (`isFolderRootFile`, `isCollectionRootFile`), `collection-import.js` (writes `brunoConfig.opencollection = '1.0.0'` for yml), docs https://docs.usebruno.com/secrets-management/dotenv-file.md (shows `opencollection.yml` in the tree). The YAML importer predicate is `isOpenCollection(data)`: `typeof data.opencollection === 'string'` and `data.info` is an object (`packages/bruno-app/src/utils/importers/opencollection.js`).
4. **JSON export (`bruno-collection.json`) is a separate, third format** worth supporting (section 11). Detection predicate used by Bruno's own importer (`packages/bruno-app/src/utils/importers/bruno-collection.js`, `isBrunoCollection`): object with non-empty string `version`, non-empty string `name`, array `items`. Nothing on disk is a `.bru` file in this case.
5. The `.bru` grammar is a small ohm-js PEG; three separate grammars share most rules (`BRU`, `COLL`, `ENV`). They differ in subtle ways that matter for a parser (listed in 3.x).

---

## 1. Collection layout on disk

```
my-collection/
  bruno.json                 # JSON config (classic marker)
  collection.bru             # collection-level headers/auth/vars/scripts/tests/docs
  .env                       # optional, process env vars (secrets), gitignored
  .gitignore
  environments/
    Local.bru                # one file per environment; file name = environment name
    Prod.bru
  some-folder/
    folder.bru               # optional, folder-level settings + display name + seq
    get-user.bru             # one request per file
    sub-folder/...
  lib.js                     # free-form scripts (optional)
```

### 1.1 `bruno.json`

Real example (Bruno's own testbench): https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/bruno.json

Fields observed in sources (all JSON):

| Field | Meaning | Source |
|---|---|---|
| `version` | **Schema marker, always the string `"1"`** for classic. The user's own collection version is stored in `collectionVersion` on save and swapped back on read. | `packages/bruno-electron/src/utils/transformBrunoConfig.js` (`transformBrunoConfigBeforeSave/AfterRead`), `collection-import.js` |
| `collectionVersion` | optional user version string | same |
| `name` | collection display name | fixtures |
| `type` | `"collection"` | fixtures, `collection-import.js` default `{name, type:'collection', ignore:['node_modules','.git']}` |
| `ignore` | array of relative paths/dir names the watcher skips (match is `relative === p` or `relative.startsWith(p + '/')`; exact path prefixes, not globs) | `WATCH` lines ~825-865 |
| `scripts` | `{ moduleWhitelist: string[], additionalContextRoots: string[], flow?: 'sandwich'|'sequential' (default sandwich), filesystemAccess?: {...} }` | tests bruno.json; `packages/bruno-electron/src/ipc/network/prepare-request.js:394` (`scripts.flow ?? 'sandwich'`). `filesystemAccess` exact shape **UNCONFIRMED** (key exists in prepare-request.js, not read in detail). |
| `presets` | `{ requestType: 'http'|'graphql'..., requestUrl: string }` - defaults for new requests only; irrelevant for import | testbench bruno.json |
| `proxy` | **two shapes exist**. New: `{ inherit: bool, disabled?: bool, config: { protocol, hostname, port, auth: { username, password, disabled? }, bypassProxy } }`. Legacy: `{ enabled: true|false|'global', protocol, hostname, port, auth: { enabled, username, password }, bypassProxy }`. Bruno converts legacy->new with `transformProxyConfig`. | https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-requests/src/utils/proxy-util.ts ; legacy example in `packages/bruno-cli/tests/runner/fixtures/collection-json-from-pathname/collection/bruno.json` |
| `clientCertificates` | `{ enabled: bool, certs: [ { domain, type: 'cert'|'pfx', certFilePath, keyFilePath, pfxFilePath, passphrase } ] }`; domain may be a wildcard like `*.internal.example.com`; first match by domain wins | docs https://docs.usebruno.com/v3/bru-cli/proxyConfiguration.md , https://docs.usebruno.com/auth/add-and-manage-certs.md |
| `protobuf` | `{ importPaths: [{path, ...}], protoFiles: [{path, ...}] }` for gRPC (the `exists` flag is runtime-only, stripped on save) | `transformBrunoConfig.js` |
| `size`, `filesCount` | runtime stats, not persisted by design | `collection-import.js` |

Importer advice: tolerate unknown keys; read `name`; treat `version` as the format marker, not a user version; accept both proxy shapes.

### 1.2 `collection.bru`

Same grammar as `folder.bru` (`COLL`), see section 2.2. Allowed top-level blocks: `meta`, `query`, `headers`, `auth`, `auth:*`, `vars:pre-request`, `vars:post-response`, `script:pre-request`, `script:post-response`, `tests`, `docs`. No `docs`-less variants. Real example: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/collection.bru

Semantics for the collection file: `FILESTORE` `parseBruCollection` returns `{request:{headers,auth,script,vars,tests}, settings, docs, meta?}`. Missing `auth { mode }` defaults to `none` (`COLL` `auth()` semantic: `mode: auth?.mode || 'none'`).

### 1.3 `folder.bru`

Optional per folder. Same grammar as `collection.bru`. Used keys: `meta { name, seq }`, `headers`, `auth`+`auth:*`, `vars:*`, `script:*`, `tests`, `docs`.
- If absent, the folder's display name is the directory name and it has no folder-level settings (Bruno tolerates this; many folders in the testbench have only `meta { name }`).
- `meta.name` is the display name (may differ from the directory name). `meta.seq` is the folder's sort position among siblings (only emitted when present: `FILESTORE` `parseBruCollection`/`stringifyBruCollection`).
- Real minimal examples: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/auth/digest/folder.bru ; with inherit auth + seq: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/request-setting/folder.bru

  ```
  meta {
    name: request-setting
    seq: 14
  }

  auth {
    mode: inherit
  }
  ```
- Note: `COLL`'s `meta()` forces `meta.type = 'collection'` for both files; ignore it.

### 1.4 Ordering

- Requests: `meta { seq: N }` inside each request file. `BRU` `meta()` defaults a missing seq to `1` (`if (!meta.seq) meta.seq = 1`), so ties/missing are possible. Folders: `folder.bru` `meta.seq`. (App sorts siblings by seq; exact tie-break/mixed folder-vs-request ordering: **UNCONFIRMED**, not read in the sort code.)
- Directory listing order is not significant. Filename is not significant to display (display name = `meta.name`); on import into the JSON model Bruno also keeps `filename`.
- JSON import hydrates missing `seq` by index order within each level (`hydrateSeqInCollection` in `packages/bruno-app/src/utils/importers/common.js`).

### 1.5 Environments

`environments/<EnvName>.bru` - see section 5. The environment name is the file name without `.bru`. Only direct children of `environments/` are environments (`isEnvironmentsFolder`, `WATCH`).

### 1.6 `.env` and `{{process.env.X}}`

- A `.env` file at the collection root (dotenv syntax) feeds `process.env`. Docs: https://docs.usebruno.com/secrets-management/dotenv-file.md. Parser is the `dotenv` npm package (`packages/bruno-lang/v2/src/dotenvToJson.js`).
- Referenced as `{{process.env.NAME}}` in any field; may be used as an env var *value* (`bark: {{process.env.PROC_ENV_VAR}}` in `packages/bruno-tests/collection/environments/Local.bru`).
- The watcher excludes any file named `.env` or starting with `.env.` from collection scanning (`WATCH` ignored fn), so they are never mistaken for requests.
- `.env` is **not** part of the shareable collection; an importer should not expect it to exist.

### 1.7 `.gitignore` and ignored paths

- New collections get this `.gitignore` (`DEFAULT_GITIGNORE`, `FS` lines 11-21): `.env*`, `node_modules`, `.DS_Store`, `Thumbs.db`. So `.env*` files are by convention absent from repos.
- Always ignored by the watcher regardless of `bruno.json`: `node_modules`, `.git`; also a root-level `mocks/` directory (mock-server data) (`WATCH` ~lines 827-851). Plus user `ignore` array from `bruno.json`.
- Secret environment values are not in any file (section 5).

Importer advice: walk the tree, skipping `node_modules`, `.git`, root `mocks/`, `environments/` (handled separately), `bruno.json`, `collection.bru`, `folder.bru`, and any `.env*`. Treat every other `*.bru` as a request (this is what Bruno does). Non-`.bru` files (js libs, proto files, binaries for `@file()`) are assets.

---

## 2. The Bru language

Grammar sources (ohm-js, full text in the files):
- Request/folder-less files: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/bruToJson.js (grammar is the template literal at the top, lines ~46-215)
- Collection/folder: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/collectionBruToJson.js
- Environment: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/envToJson.js
- Writer (the only normative description of what is emitted): https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/jsonToBru.js

### 2.1 Block kinds

The file is a sequence of blocks `(blockname dictionary|text|list)*`, with no required order, whitespace/newlines between blocks tolerated by ohm's implicit space skipping on the syntactic `BruFile` rule. Three kinds of body:

1. **Dictionary block** - `name { key: value ... }` with `key: value` pairs, one per line. Used by `meta`, HTTP verbs, `params:*`, `headers`, `auth:*`, `body:form-urlencoded`, `body:multipart-form`, `body:file`, `vars:*`, `assert`, `settings`, `metadata`, `grpc`, `ws`, `body:grpc`, `body:ws`.
2. **Text block** - `name { <raw text lines> }` with the content indented 2 spaces. Used by `body`, `body:json|text|xml|sparql|graphql|graphql:vars`, `script:*`, `tests`, `docs`.
3. **List value** inside a dictionary: `tags: [ ... ]`, `omitHeaders: [ ... ]`. Environment secrets use a top-level array block (`vars:secret [ ... ]`).

Verbatim core request grammar (BRU, v4.2.1):

```
Bru {
  BruFile = (meta | http | grpc | ws | query | params | headers | metadata | auths | bodies | varsandassert | script | tests | app | settings | docs | example)*
  auths = authawsv4 | authbasic | authbearer | authdigest | authNTLM | authOAuth1 | authOAuth2 | authwsse | authapikey | authedgegrid | authOauth2Configs
  bodies = bodyjson | bodytext | bodyxml | bodysparql | bodygraphql | bodygraphqlvars | bodyforms | body | bodygrpc | bodyws
  bodyforms = bodyformurlencoded | bodymultipart | bodyfile
  params = paramspath | paramsquery

  nl = "\r"? "\n"
  st = " " | "\t"
  stnl = st | nl
  tagend = nl "}"
  optionalnl = ~tagend nl
  keychar = ~(tagend | st | nl | ":") any
  valuechar = ~(nl | tagend) any

  // Multiline text block surrounded by '''
  multilinetextblockdelimiter = "'''"
  multilinetextblock = multilinetextblockdelimiter (~multilinetextblockdelimiter any)* multilinetextblockdelimiter st* contenttypeannotation?
  contenttypeannotation = "@contentType(" (~")" any)* ")"

  // Dictionary Blocks
  dictionary = st* "{" st* pairlist? tagend
  pairlist = optionalnl* pair (~tagend stnl* pair)* (~tagend space)*
  pair = st* pairannotations st* (quoted_key | key) st* ":" st* value st*
  disable_char = "~"
  quote_char = "\""
  esc_char = "\\"
  esc_quote_char = esc_char quote_char
  quoted_key_char = ~(quote_char | esc_quote_char | nl) any
  quoted_key = disable_char? quote_char (esc_quote_char | quoted_key_char)* quote_char
  key = keychar*
  value = list | multilinetextblock | singlelinevalue
  singlelinevalue = valuechar*

  // Dictionary for Assert Block
  assertdictionary = st* "{" assertpairlist? tagend
  assertpairlist = optionalnl* assertpair (~tagend stnl* assertpair)* (~tagend space)*
  assertpair = st* pairannotations st* assertkey st* ":" st* value st*
  assertkey = ~tagend assertkeychar*
  assertkeychar = ~(tagend | nl | ":") any

  // Text Blocks
  textblock = textline (~tagend nl textline)*
  textline = textchar*
  textchar = ~nl any

  // List
  list = st* "[" nl+ listitems? st* nl+ st* "]"
  listitems = listitem (nl+ listitem)*
  listitem = st+ (alnum | "_" | "-")+ st*

  meta = "meta" dictionary
  app = "app" dictionary
  settings = "settings" dictionary
  http = get | post | put | delete | patch | options | head | connect | trace | httpcustom
  grpc = "grpc" dictionary
  ws = "ws" dictionary
  get = "get" dictionary   (likewise post put delete patch options head connect trace)
  httpcustom = "http" dictionary
  headers = "headers" dictionary
  metadata = "metadata" dictionary
  query = "query" dictionary
  paramspath = "params:path" dictionary
  paramsquery = "params:query" dictionary
  varsandassert = varsreq | varsres | assert
  varsreq = "vars:pre-request" dictionary
  varsres = "vars:post-response" dictionary
  assert = "assert" assertdictionary

  authawsv4 = "auth:awsv4" dictionary      authbasic = "auth:basic" dictionary
  authbearer = "auth:bearer" dictionary    authdigest = "auth:digest" dictionary
  authNTLM = "auth:ntlm" dictionary        authOAuth1 = "auth:oauth1" dictionary
  authOAuth2 = "auth:oauth2" dictionary    authwsse = "auth:wsse" dictionary
  authapikey = "auth:apikey" dictionary    authedgegrid = "auth:akamai-edgegrid" dictionary
  (+ eight "auth:oauth2:additional_params:{auth_req|access_token_req|refresh_token_req}:{headers|queryparams|body}" dictionary rules)

  body = "body" st* "{" nl* textblock tagend
  bodyjson = "body:json" st* "{" nl* textblock tagend       (same shape for body:text, body:xml, body:sparql,
  bodygraphql = "body:graphql" ...  bodygraphqlvars = "body:graphql:vars" ...   body:graphql / body:graphql:vars)
  bodygrpc = "body:grpc" dictionary      bodyws = "body:ws" dictionary
  bodyformurlencoded = "body:form-urlencoded" dictionary
  bodymultipart = "body:multipart-form" dictionary
  bodyfile = "body:file" dictionary

  example = "example" st* "{" nl* examplecontent tagend
  examplecontent = (~tagend any)*

  script = scriptreq | scriptres | scriptbeforecallstart | scriptbeforemessagesend | scriptaftermessagereceive | scriptaftercallend
  scriptreq = "script:pre-request" st* "{" nl* textblock tagend
  scriptres = "script:post-response" st* "{" nl* textblock tagend
  (grpc hooks: "script:grpc:before-call-start" | "script:grpc:before-message-send" | "script:grpc:after-message-receive" | "script:grpc:after-call-end")
  tests = "tests" st* "{" nl* textblock tagend
  docs = "docs" st* "{" nl* textblock tagend
}
```

(The annotation sub-grammar - `@name(args)` lines above a pair - is in section 2.5.) Lines marked "(likewise ...)" are condensed by me; the source repeats the rule per verb/body type with identical shape.

Confirmed block-name inventory (everything the question listed, plus extras):

| Block | Kind | Notes |
|---|---|---|
| `meta` | dict | `name`, `type`, `seq`, `tags: [..]` (list) |
| `get post put delete patch options head connect trace` | dict | keys `url`, `body`, `auth` |
| `http` | dict | **custom methods**: `http { method: PURGE ... url: ... }` (`httpcustom`) |
| `grpc`, `ws` | dict | non-HTTP request core (section 7) |
| `query` | dict | legacy alias, parsed identically to `params:query` |
| `params:query`, `params:path` | dict | |
| `headers`, `metadata` | dict | `metadata` is gRPC's "headers" |
| `auth:basic|bearer|digest|ntlm|awsv4|wsse|apikey|oauth1|oauth2|akamai-edgegrid` | dict | section 8 |
| `auth:oauth2:additional_params:...` | dict | 8 extra blocks for token-request extras |
| `body` (legacy), `body:json|text|xml|sparql|graphql|graphql:vars` | text | |
| `body:form-urlencoded`, `body:multipart-form`, `body:file` | dict | |
| `body:grpc`, `body:ws` | dict | one block per message; blocks repeat |
| `vars:pre-request`, `vars:post-response` | dict | |
| `assert` | special dict | |
| `script:pre-request`, `script:post-response` (+4 grpc hooks) | text | |
| `tests`, `docs` | text | |
| `settings` | dict | `encodeUrl`, `followRedirects`, `maxRedirects`, `timeout`, `forwardAuthorizationHeader`, `keepAliveInterval`, `omitHeaders: [..]` |
| `app` | dict | `enabled`, `code` (for `meta.type: app`; semantics **UNCONFIRMED**, ignore) |
| `example` | raw | response examples; separate sub-grammar (`packages/bruno-lang/v2/src/example/bruToJson.js`): root props `name:`, `description:`, `request {..}`, `response {..}`. Optional to import. |

Not in the grammar (do not expect): a `settings` block for OAuth, `body:binary`, `auth:inherit` block (inherit is a *mode value*, not a block), `vars:secret` in request files (env-only).

### 2.2 Differences between the three grammars (parser pitfalls)

- `BRU` `dictionary` allows `st*` after `{`; `ENV`'s does not (`"{" pairlist? tagend`).
- `BRU` `value = list | multilinetextblock | singlelinevalue`; `COLL` and `ENV` have no `list`; `COLL` multiline block has no trailing `@contentType`; `ENV`'s multiline block must be `''' nl ... nl st* '''`.
- Only `BRU` has `assert` dictionary (key may contain spaces and almost anything but `:`), `~"quoted key"` (BRU/COLL), `@contentType`. `ENV` pair key is plain `keychar*` (no quoted keys, no `~` special handling in the grammar - `~` is part of the key text, stripped later).
- `COLL` top-level rules: `meta | query | headers | auth | auths | vars | script | tests | docs`. Note `auth = "auth" dictionary` (mode holder) is distinct from `auths` (`auth:*`).
- Blocks that do not match any alternative make the whole parse fail (ohm `match.failed()` -> `throw new Error(match.message)`). There is no error recovery; unknown block names (e.g. a future block) fail the file. An importer should decide per file: report error and continue.

### 2.3 Dictionary pairs: key, value, disabled marker

- Pair: optional annotation lines, then `key : value`. Value runs to end of line (`valuechar = ~(nl | tagend) any`), semantic trims it (`value.ast.trim()`). **A value cannot contain a newline unless it uses `'''`**. A value also cannot contain `\n}` (tagend) - harmless in single-line.
- Plain `key` = `keychar*` = anything except whitespace, newline, `:`. So `Content-Type`, `x-api-key`, `res.status` fine; a key containing a space or `:` must be quoted `"my key"`. Writer quotes when key contains any of `: " { }` or space (`getKeyString`, `UT`), escaping `"` as `\"`. Reader unescapes `\"` only.
- **Disabled entries**: prefix `~` on the key: `~X-Debug: 1`, or `~"quoted key": v` (`~` before the opening quote - `quoted_key = disable_char? quote_char ...`). The prefix is stripped in `mapPairListToKeyValPairs` and sets `enabled:false`. Applies to `headers`, `params:*`, `body:*` dictionaries, `assert`, `vars:*`, env `vars`. For auth blocks (`parseEnabled=false`) there is no disabled concept.
- Writer ordering: enabled items first, then disabled items (`J2B`), so reading order does not preserve interleaving. Do not rely on position of disabled vs enabled entries.
- **Duplicate keys** are kept as separate list entries in list-style blocks (`headers`, `params`, `assert`, vars, forms) because `mapPairListToKeyValPairs` maps the pair list; but in *object-style* blocks (`meta`, verb block, `settings`, `grpc`, `ws`) `mapPairListToKeyValPair` does `_.merge` (last wins). Assertions in particular rely on repeated keys (`res.body: contains ...` twice in `echo multipart.bru`).

### 2.4 Multi-line values and text-block indentation

- **Text blocks**: body is raw text; `outdentString` removes up to 2 leading spaces from every line (`/^ {2}/`, `UT`); line endings normalized by split on `\r\n|\r|\n`, join `\n`. Block ends at the first line that starts with `}` at column 0 (`tagend = nl "}"`). Writer indents everything 2 spaces, so content lines that themselves start with `}` stay safe when indented. A hand-written text block with an unindented `}` line would terminate early - parser must mimic: **the terminator is newline immediately followed by `}`**, nothing else. No escaping mechanism exists.
- Trailing blank handling: the writer emits `body {\n  <indented text>\n}\n\n`; there is no trailing-newline marker, so original trailing newlines of a script are not preserved exactly.
- **`'''` multi-line values in dictionaries** (used for multiline header/var values, multipart text, gRPC/WS message content, annotations). Written as:
  ```
  key: '''
    line1
    line2
  '''
  ```
  `J2B`/`UT` `getValueString` wraps with `'''\n` + 2-space-indented value + `\n'''`; because the whole pair is then indented by 2 again by the dictionary writer, the **net indentation of content lines inside the file is 4 spaces** and the closing `'''` has 2. The reader (`BRU` `multilinetextblock` semantic) does `content.split('\n').map(line => line.slice(4)).join('\n')`, i.e. strips exactly 4 chars from every line (even if they are not spaces), then `pair` trims the final value. `ENV` strips 4 too (`indentLevel = 4`) then `.trim()`. Writer detail for multi-line `url`: 4-space content indent (`getValueUrl`).
- The `'''` content cannot contain `'''` (the rule is `(~''' any)*`); no escape. (Annotation `@description` values have a bespoke `\'\'\'` escape scheme, `escapeMultilineDescription` in `UT`.)
- **`@contentType(...)`** annotation (multipart and `body:file` only; BRU grammar `contenttypeannotation`): trailing token after a value: `foo: {"a":1} @contentType(application/json)`; after a multiline block: `''' ... ''' @contentType(text/plain)`. Semantics: the multiline reader appends ` @contentType(x)` to the string; then `multipartExtractContentType` splits with `/^(.*?)\s*@contentType\((.*?)\)\s*$/s` into `value` + `contentType` (empty string if none). So a literal text value ending with `@contentType(...)` is indistinguishable and will be eaten.
- **`@file(...)`**: multipart value starting with `@file(` and ending with `)` -> `type:'file'`, `value = inner.split('|').filter(Boolean)` (multiple files joined with `|`). In `body:file`, a single `@file(path)` per row; row name is auto-generated and discarded, key written as `file`, disabled with `~file:`. `selected = enabled`. (`mapPairListToKeyValPairsMultipart`, `mapPairListToKeyValPairsFile`). Paths are written as given (observed relative, e.g. `file: @file(bruno.png)` in `packages/bruno-tests/collection/echo/echo multipart.bru`); relative-to-collection-root vs relative-to-request-file: **UNCONFIRMED** (fixture file location not checked; Bruno's runtime resolves against the collection path as far as I know but I did not read that code).
- **Lists** (`tags`, `omitHeaders`): 
  ```
  tags: [
    smoke
    regression
  ]
  ```
  `list = st* "[" nl+ listitems? st* nl+ st* "]"`; items separated by newlines (**not commas**); item chars only `alnum | _ | -`. Writer (`J2B`) emits that shape. `body:ws`/`body:grpc` do not use lists.

### 2.5 Annotations (new in v4)

Lines above a pair of the form `@name` or `@name(arg)`, e.g.
```
vars:pre-request {
  @number
  timeout: 30
  @description('''
    some text
  ''')
  baseUrl: https://api.example.com
}
```
Grammar: `annotationentry = st* annotation ~":" st* nl` (a line whose `@x` is *not* followed by `:`), arg is single-quoted, double-quoted (escapes `\n \r \t \" \\`), unquoted-to-`)`, or a `'''` block. Meaning:
- `@string|@number|@boolean|@object` (`BRUNO_VARIABLE_DATATYPES`, `UT`): data type of var; value coerced (`parseValueByDataType`). Applies to `vars:pre-request` (and env `vars`); post-response vars keep raw annotations but no dataType.
- `@description(...)`: description for headers, params, form rows, vars, etc.
- Collections written with annotations do not parse in Bruno < 4.0.0 (docs: https://docs.usebruno.com/variables/overview.md). An importer that does not implement annotations will fail to match on those files (since a `@x` line is not a valid pair) - implement at least "skip annotation lines".
- The same grammar is present in `COLL` and `ENV`.

### 2.6 Comments

**There are no comments in the Bru grammar.** `//` or `#` inside a dictionary block would be parsed as a key (and fail for lack of `:` or become a bogus pair); inside text blocks (`script:*`, `tests`, `body:*`, `docs`) `//` is just JavaScript/JSON text. Do not implement `#`/`//` comment skipping outside text blocks. (Source: absence from all three grammars; confirmed by reading the grammar, not by an explicit doc statement.)

### 2.7 Escaping rules summary

- No general escape character. Only: `\"` inside quoted keys; annotation double-quoted args (`\n \r \t \" \\`); `@description` triple-quote escape; `extends` list quoted names.
- Reserved terminators: newline + `}` ends a dictionary/text block; `'''` ends a multiline value.
- Single-line values are trimmed; a value is the raw rest of the line (colons allowed in values: `url: http://host:8080/x` works because only the *first* `:` after the key splits - `key` stops at the first `:`).
- Dictionary values containing the sequence `\n}` cannot exist in single-line form.

### 2.8 Request files: `meta` and the verb block

```
meta {
  name: Create user
  type: http          # http | graphql | grpc | ws | app ; default http if missing
  seq: 2
  tags: [
    smoke
  ]
}

post {
  url: {{baseUrl}}/users/:id
  body: json          # none | json | text | xml | sparql | graphql | formUrlEncoded | multipartForm | file
  auth: inherit       # inherit | none | basic | bearer | digest | ntlm | oauth1 | oauth2 | wsse | apikey | awsv4 | akamai-edgegrid
}
```
- Mapping (`FILESTORE` `parseBruRequest`): `meta.type` `http`->http-request, `graphql`->graphql-request, `grpc`, `ws`, `app`, anything else -> http-request. `request.method` = verb block name upper-cased, or `http.method` for custom (case preserved by `String(...).toUpperCase()`; **note: custom method special chars preserved but letters upper-cased**). `body.mode` from `http.body` (default `none`); `auth.mode` from `http.auth` (default `none`).
- Body-mode enum source: `SCHEMA` line ~208: `none, json, text, xml, formUrlEncoded, multipartForm, graphql, sparql, file`. Auth-mode enum source: `SCHEMA` line ~450: `inherit, none, awsv4, basic, bearer, digest, ntlm, oauth1, oauth2, wsse, apikey, akamai-edgegrid`.
- A legacy bare `body { ... }` text block means JSON and forces `http.body = 'json'` (`BRU` `body()` semantic).
- The `body: <mode>` value in the verb block decides which body block is *active*; other body blocks may still be present in the file (user toggled mode but contents kept). An importer must only import the active mode's content or carry all and select by mode.
- URL contains the query string; `params:query` mirrors it (enabled params appear in the URL; disabled ones appear only in the block). Example from the repo: `url: {{host}}/ping?page=1&limit=10&sort=desc` + `params:query { page: 1 limit: 10 sort: desc }` (`packages/bruno-tests/collection/scripting/api/req/getQueryString.bru`). Path params: `:name` placeholders in the URL path with values in `params:path` (e.g. `tests/interpolation/collection/echo-request-url.bru`); name rule documented at https://docs.usebruno.com/send-requests/REST/parameters.md (letter/underscore start; `:00` is not a param).
- `settings { encodeUrl: true|false ... }`: `encodeUrl` is always materialised; `timeout` may be `inherit` or integer; `maxRedirects` non-negative integer; unknown settings keys are dropped by the semantic (`BRU` `settings()`).

---

## 3. Body blocks in detail

| Block | Content | Notes |
|---|---|---|
| `body:json` / `body:text` / `body:xml` / `body:sparql` | raw text, 2-space indent stripped | `body.json` etc. Not validated. JSON may contain `{{vars}}` and dynamic vars. |
| `body:graphql` | GraphQL query text | -> `body.graphql.query` |
| `body:graphql:vars` | JSON text | -> `body.graphql.variables`; sibling block |
| `body:form-urlencoded` | dict (disable via `~`) | |
| `body:multipart-form` | dict; value forms: plain, `'''` multiline, `@file(a\|b)`, each optionally `@contentType(x)` | |
| `body:file` | dict, repeated `file: @file(path) [@contentType(x)]`, `~file:` = not selected | binary-from-file body |
| `body:grpc` / `body:ws` | dict `name`, `content` (+ `type`, `selected` for ws), one block per message | |

---

## 4. Auth blocks (field names exactly as the parser reads them)

Sources: `BRU` auth semantics + `J2B` writer.

- Request level: `auth: <mode>` in the verb block (`http`/`grpc`/`ws`). Then, for modes with data, a dedicated block:
  - `auth:basic { username, password }`
  - `auth:bearer { token }`
  - `auth:digest { username, password }`
  - `auth:ntlm { username, password, domain }`
  - `auth:wsse { username, password }`
  - `auth:apikey { key, value, placement }` placement `header` or `queryparams` (`SCHEMA` ~274)
  - `auth:awsv4 { accessKeyId, secretAccessKey, sessionToken, service, region, profileName }`
  - `auth:oauth1 { consumer_key, consumer_secret, access_token, token_secret, callback_url, verifier, signature_method, private_key (text or '''block''' or @file(path)), timestamp, nonce, version, realm, placement, include_body_hash }`
  - `auth:oauth2 { grant_type: password|authorization_code|client_credentials|implicit, ... }` - key set depends on `grant_type`: `access_token_url, refresh_token_url, username, password, client_id, client_secret, scope, callback_url, authorization_url, state, pkce, credentials_placement, credentials_id, token_source, token_placement, token_header_prefix, token_query_key, auto_fetch_token, auto_refresh_token`. Reader returns `{}` when `grant_type` is not one of the four.
  - Extras: `auth:oauth2:additional_params:{auth_req|access_token_req|refresh_token_req}:{headers|queryparams|body}` blocks (key/value rows with `~` disable).
  - `auth:akamai-edgegrid { accessToken, clientToken, clientSecret, nonce, timestamp, baseURL, headersToSign, maxBodySize }`
- Collection/folder level (`COLL`): a separate `auth { mode: <mode> }` block selects the mode, then the same `auth:*` block holds data. Example in `collection.bru` above. Mode default `none`.
- **`auth: inherit`**: request (or folder) uses the closest ancestor's auth: request -> folder chain -> collection. In folder.bru it is `auth { mode: inherit }`. At collection root `inherit` has nothing to inherit from (writer/defaults produce `none`). `auth: none` means explicitly no auth, which also stops inheritance. Sources: mode enum in `SCHEMA`; fixture `packages/bruno-tests/collection/request-setting/folder.bru`; request fixtures `auth: inherit` in `tests/interpolation/collection/echo-request-url.bru`. The precise inheritance walk algorithm (nearest folder with mode != inherit) is **UNCONFIRMED** from code I read, but is the behaviour of the UI/runner as documented in docs (not fetched).
- Secrets such as `password`, `token`, `client_secret` are written **in clear text into the `.bru`** (usually as `{{variable}}` references). Treat as sensitive on import.

---

## 5. Environment `.bru` files

File: `environments/<Name>.bru`, grammar `ENV` (https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/envToJson.js). Writer: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-lang/v2/src/jsonToEnv.js. Real example: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/environments/Local.bru

```
BruEnvFile = (vars | secretvars | externalsecrets | extends | color)*
dictionary = st* "{" pairlist? tagend
pair = st* pairannotations st* key st* ":" st* value st*
value = multilinetextblock | singlelinevalue
array = st* "[" stnl* valuelist stnl* "]"
valuelist = stnl* arrayvalue stnl* ("," stnl* arrayvalue)*
arrayvalue = pairannotations st* arrayvaluechar*
arrayvaluechar = ~(nl | st | "[" | "]" | ",") any
secretvars = "vars:secret" array
externalsecrets = "vars:externalsecrets:" externalsecretsname dictionary
vars = "vars" dictionary
extends = "extends" (extendslist | extendsname)
extendsname = ":" singlelinechar*
color = "color:" singlelinechar*
```
- `vars { name: value }`: enabled variables. `~name: value` = disabled (`enabled:false`). `@number|@boolean|@object` annotations apply (typed vars). Multi-line values with `'''` (content indented 4, closing `'''` indented 2). Values are trimmed.
- `vars:secret [ a, b, c ]`: **names only, comma-separated** (note: commas, unlike `tags`), may be multiline with trailing commas not allowed after the last item; item may be `~name` to be disabled; item chars exclude whitespace, `[`, `]`, `,`. **The secret values are not in the file**: docs https://docs.usebruno.com/secrets-management/secret-variables.md ("Bruno will manage your secrets internally and will not write them into the environment file", encrypted in app storage). On parse, each secret gets `secret:true`, `value:''`.
- Additional top-level items: `extends: Name` or `extends [ A, B ]` (environment inheritance, new in v4), `color: <css-ish string>` (UI color), `vars:externalsecrets:<provider> { ... }` (secret-manager references; docs: https://docs.usebruno.com/secrets-management/secret-managers/overview.md). All can be ignored by a basic importer, but `extends` changes variable resolution (merge ancestor -> parent -> active, per variables overview doc).
- Variables are all strings unless annotated. A common idiom: `TOKEN: {{process.env.TOKEN}}` (indirection to `.env`).
- No environment-level `type` field is in the file (the app attaches `type:'text'` at load: `FILESTORE` `parseBruEnvironment`).
- Global environments (app-wide, not per collection) are not stored in the collection directory (variables overview: "Local storage").

---

## 6. Non-HTTP request types

`meta.type` values handled by the parser: `http` (default), `graphql`, `grpc`, `ws`, `app` (`FILESTORE` `parseBruRequest`, `SCHEMA` item types `http-request, graphql-request, grpc-request, ws-request, folder, js, app`). Bruno v4.2.1 supports all of gRPC and WebSocket (docs index: https://docs.usebruno.com/llms.txt lists gRPC and WebSocket sections).

- **GraphQL**: `meta { type: graphql }`, normal verb block (usually `post`) with `body: graphql`, plus `body:graphql { query }` and optional `body:graphql:vars { json }`. Real: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-tests/collection/graphql/variable-interpolation.bru . Variables JSON is parsed after interpolation.
- **gRPC**: `meta { type: grpc }`, then
  ```
  grpc {
    url: {{host}}
    method: /hello.HelloService/SayHello     # full method path
    body: grpc
    auth: inherit
    methodType: unary                         # unary | client-streaming | server-streaming | bidi-streaming
    protoPath: path/to/file.proto             # optional
  }
  body:grpc {                                 # one block per message, repeatable
    name: message 1
    content: '''
      { "greeting": "x" }
    '''
  }
  ```
  Real: `tests/grpc/make-request/fixtures/collection/HelloService/SayHello.bru`. Headers are written in a `metadata { }` block (not `headers`). gRPC hooks: `script:grpc:*` blocks. Proto import paths live in `bruno.json` (`protobuf`). Reflection vs proto-file mode: **UNCONFIRMED** how it is encoded.
- **WebSocket**: `meta { type: ws }`, `ws { url, body: ws, auth, methodType? }`, repeated `body:ws { name, type, selected, content }` message blocks. (`J2B`, `BRU` `bodyws`). Settings validated by a separate `wsSettingsSchema` (`SCHEMA`); keys incl. `keepAliveInterval`, others UNCONFIRMED.
- **`app`**: `meta { type: app }` + `app { enabled, code }` - Bruno "mini-app" item type; purpose **UNCONFIRMED**; skip with a warning.
- SSE and "mock server" data live under other mechanisms (`mocks/` directory is ignored by the watcher, `WATCH`).

---

## 7. Variables and interpolation

Sources: https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-common/src/interpolate/index.ts ; https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-js/src/bru.js ; docs https://docs.usebruno.com/variables/overview.md .

- Syntax: `{{name}}`. Regex `\{\{([^}]+)\}\}`; lookup is lodash `get(obj, path)` so dotted names are legal (`{{env.var1}}`, `{{process.env.TOKEN}}`, `{{user.name}}` into object vars). Names can contain `-` (`{{echo-host}}`). Unknown names are left verbatim. Interpolation is recursive (a value containing `{{x}}` is expanded again; cycles guarded).
- Object values are `JSON.stringify`'d when interpolated into strings.
- **Process env**: `{{process.env.NAME}}`; becomes `process: { env: {...} }` in the interpolation map (`bru.js` `interpolate`). Does not compete in precedence (docs).
- **Dynamic variables**: `{{$name}}` matched by `/\{\{\$(\w+)\}\}/g` and evaluated through `mockDataFunctions`; unknown `$name` is left as text. Names confirmed from `packages/bruno-common/src/utils/faker-functions.ts`: `guid timestamp isoTimestamp randomUUID randomNanoId randomAlphaNumeric randomBoolean randomInt randomColor randomHexColor randomAbbreviation randomIP randomIPV4 randomIPV6 randomMACAddress randomPassword randomLocale randomUserAgent randomProtocol randomSemver randomFirstName randomLastName randomFullName randomNamePrefix randomNameSuffix randomJobArea randomJobDescriptor randomJobTitle randomJobType randomPhoneNumber randomPhoneNumberExt randomCity randomStreetName randomStreetAddress randomCountry randomCountryCode randomLatitude randomLongitude randomAvatarImage randomImageUrl ... randomBankAccount randomBankAccountIban randomCurrencyCode randomCompanyName randomDateFuture randomDatePast randomDateRecent randomWeekday randomMonth randomDomainName randomEmail randomUserName randomUrl randomFileName randomMimeType randomPrice randomProduct randomWord randomWords randomPhrase randomLoremWord randomLoremWords randomLoremSentence randomLoremParagraph randomLoremText randomLoremSlug randomLoremLines` (list truncated for brevity in places marked `...`; the full list is in that file; there are roughly 120 entries). Docs: https://docs.usebruno.com/testing/script/dynamic-variables.md . In JSON bodies the generated value is JSON-string-escaped when `escapeJSONStrings` is set.
  - Mapping hazard: only `$timestamp`, `$guid`, `$randomUUID`, `$randomInt`, `$isoTimestamp` have obvious analogues elsewhere; others are faker.js dependent. `guid` is distinct from `randomUUID` (exact output semantic of `guid`, `timestamp` units **UNCONFIRMED**).
- **Prompt variables** `{{?Prompt text}}` ask the user at send time (docs); never stored.
- **Scopes and precedence** (docs, highest first): Runtime > Request > Folder > Environment > Collection > Global. Code merge order in `bru.js` `interpolate`: global, collection, env, folder, request, oauth2 credential vars, runtime, prompt (later wins). Process env separate.
- **Where each scope is stored in classic format**:
  - Collection vars: `collection.bru` `vars:pre-request` (pre-request) / `vars:post-response`
  - Folder vars: `folder.bru` same blocks
  - Request vars: request file `vars:pre-request` / `vars:post-response`
  - Environment vars: `environments/*.bru` `vars`
  - Runtime vars: memory only (set by `bru.setVar`)
- `vars:pre-request { name: value }` defines a request-scope variable evaluated before send. `vars:post-response { name: <expression> }` value is a **JSON-query/JS expression evaluated against `res`** (e.g. `token: res.body.access_token`), not a literal (comment in `BRU` `varsres`). Prefix `@name` marks a *local* var (`local:true`, `@` stripped; written as `@name`, disabled `~@name`).

---

## 8. Assertions

Block `assert { <lhs-expression>: <operator> <rhs> }`. Grammar special: key = any chars except `:` and newline (so keys may contain spaces, brackets, `res.body[0].id`), reader trims. **A key can't contain `:`** (e.g. a JSONPath with a colon needs a different expression). Duplicate keys allowed. `~` disables.

Operator parsing (`parseAssertionOperator`, https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-js/src/runtime/assert-runtime.js lines 234-309): split value on first space; if the first token is a known operator use it, else the whole string is `eq <whole value>`. Operators (identical to the schema enum `assertionOperators`, `SCHEMA` line ~92):

`eq neq gt gte lt lte in notIn contains notContains length matches notMatches startsWith endsWith between isEmpty isNotEmpty isNull isUndefined isDefined isTruthy isFalsy isJson isNumber isString isBoolean isArray`

- Unary (no operand): `isEmpty isNotEmpty isNull isUndefined isDefined isTruthy isFalsy isJson isNumber isString isBoolean isArray`.
- `in`/`notIn`: comma list, optional surrounding `[ ]`: `res.status: in 200,201`. `between`: `between 1, 10` (two comma-separated bounds). `matches`/`notMatches`: regex, optional enclosing `/ /`. `length`: `lengthOf`. Operands are interpolated (`{{var}}`) then JS-template-literal-evaluated, so `eq 200` is the number 200, `eq "abc"` string `abc`, `eq true` boolean (the exact literal-coercion rule goes through `evaluateJsTemplateLiteral`; precise behaviour for unquoted words **UNCONFIRMED**).
- LHS is a JS expression evaluated with `res`, `req`, `bru` and all variables in scope (`evaluateJsExpression`); typical: `res.status`, `res.body.name`, `res.headers['content-type']`, `res.responseTime`. The `res` here is a "response parser" (`createResponseParser`) that also supports query-style paths like `res.body..id` - **UNCONFIRMED in detail**.

---

## 9. Scripts, tests, sandbox

- Blocks: `script:pre-request`, `script:post-response`, `tests` (all raw JS text). Folder and collection files can have the same.
- Script globals (`packages/bruno-js/src/bru.js`, `bruno-request.js`, `bruno-response.js`; method lists extracted by me, behaviour not individually verified):
  - `bru`: `getEnvName getProcessEnv hasEnvVar getEnvVar setEnvVar deleteEnvVar getAllEnvVars deleteAllEnvVars hasGlobalEnvVar getGlobalEnvVar setGlobalEnvVar deleteGlobalEnvVar getAllGlobalEnvVars deleteAllGlobalEnvVars getOauth2CredentialVar resetOauth2Credential hasVar setVar getVar deleteVar deleteAllVars getAllVars getCollectionVar setCollectionVar hasCollectionVar deleteCollectionVar deleteAllCollectionVars getAllCollectionVars getFolderVar getRequestVar setNextRequest sleep getCollectionName isSafeMode cwd interpolate sendRequest runner.skipRequest runner.stopExecution utils.* runRequest(?)`. (`runRequest`/`cookies` existence **UNCONFIRMED**: not in the class method list I extracted; they are defined as constructor properties for some.)
  - `req`: `getUrl setUrl getHost getPath getQueryString getMethod setMethod getAuthMode getHeaders setHeaders deleteHeaders getHeader setHeader deleteHeader hasJSONContentType getBody setBody setMaxRedirects getTimeout setTimeout onFail disableParsingResponseJson getExecutionMode getName getPathParams getTags`
  - `res`: `status` (property), `headers`, `body`, `responseTime`, and methods `getStatus getStatusText getHeader getHeaders getBody getResponseTime getUrl setBody getSize getDataBuffer`
  - Tests: `test("name", function(){ expect(...).to.equal(...) })` with chai; extra chai matchers installed in assert-runtime: `.json`, `.jsonSchema(schema)` (Ajv, draft-07), `.match(regex)`, `jsonBody(...)`, chai-string.
  - `bru.setNextRequest`/`runner.skipRequest` control run flow.
- A converter to another tool's script API is out of scope; practical importer approach: carry the script text verbatim, flag that it uses the Bruno API, and (optionally) provide a `bru.*`/`req.*`/`res.*` shim or warn.
- Sandbox and flow: `bruno.json` `scripts.flow` (`sandwich` default = collection pre, folder pre, request pre ... request post, folder post, collection post; `sequential` = all pre-request scripts in order then all post-response in order) - the exact meaning of these two names **UNCONFIRMED** (key read in `prepare-request.js:394`; semantics not read). The same flag is exported by OpenCollection under `extensions.bruno.scripts.flow`.

---

## 10. Sample classic collection (hand-derived from the grammar; not parser-verified)

```
demo-collection/
  bruno.json
  collection.bru
  .env                      (not committed)
  environments/Local.bru
  users/
    folder.bru
    create-user.bru
    upload-avatar.bru
    graphql-user.bru
    get-user.bru
```

`bruno.json`
```json
{
  "version": "1",
  "name": "demo-collection",
  "type": "collection",
  "ignore": ["node_modules", ".git"]
}
```

`collection.bru`
```
headers {
  X-Client: wirebench-demo
}

auth {
  mode: bearer
}

auth:bearer {
  token: {{process.env.TOKEN}}
}
```

`environments/Local.bru`
```
vars {
  baseUrl: http://localhost:8080
  ~debugFlag: true
  apiToken: {{process.env.TOKEN}}
}
vars:secret [
  clientSecret
]
```

`users/folder.bru`
```
meta {
  name: Users
  seq: 2
}

auth {
  mode: inherit
}
```

`users/create-user.bru` (JSON POST, disabled header, path param)
```
meta {
  name: Create user
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/orgs/:orgId/users
  body: json
  auth: inherit
}

params:path {
  orgId: 42
}

headers {
  Content-Type: application/json
  ~X-Debug: 1
}

body:json {
  {
    "name": "Ada",
    "email": "ada@example.com"
  }
}

assert {
  res.status: eq 201
  res.body.name: eq Ada
}

script:post-response {
  bru.setVar("userId", res.body.id);
}

tests {
  test("returns the created user", function() {
    expect(res.getStatus()).to.equal(201);
    expect(res.getBody()).to.have.property("id");
  });
}

docs {
  Creates a user in the given org.
  Requires a bearer token from the collection auth.
}
```

`users/upload-avatar.bru` (multipart with a file part)
```
meta {
  name: Upload avatar
  type: http
  seq: 2
}

post {
  url: {{baseUrl}}/users/{{userId}}/avatar
  body: multipartForm
  auth: inherit
}

body:multipart-form {
  caption: Profile photo @contentType(text/plain)
  avatar: @file(assets/avatar.png) @contentType(image/png)
  ~backup: @file(assets/a.png|assets/b.png)
}
```

`users/graphql-user.bru` (GraphQL with variables)
```
meta {
  name: User via GraphQL
  type: graphql
  seq: 3
}

post {
  url: {{baseUrl}}/graphql
  body: graphql
  auth: inherit
}

body:graphql {
  query User($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
}

body:graphql:vars {
  {
    "id": "{{userId}}"
  }
}
```

`users/get-user.bru` (query param, process.env reference in a header)
```
meta {
  name: Get user
  type: http
  seq: 4
}

get {
  url: {{baseUrl}}/users/:id?verbose=true
  body: none
  auth: none
}

params:query {
  verbose: true
}

params:path {
  id: {{userId}}
}

headers {
  Authorization: Bearer {{process.env.TOKEN}}
}
```

`.env` (not in the collection; shown for completeness)
```
TOKEN=dev-token-123
```

Hand-checks against the grammar: every dictionary body line is `key: value`; disabled entries use leading `~`; text blocks are 2-space indented; every block ends with `\n}` at column 0; `body:graphql:vars` is a separate block; multipart `@file(..)` list uses `|`.

---

## 11. Bruno JSON export (`bruno-collection.json`)

Produced by the UI "Share/Export -> Bruno Collection" (docs: https://docs.usebruno.com/get-started/import-export-data/export-collections.md; code: `exportCollection` in https://github.com/usebruno/bruno/blob/v4.2.1/packages/bruno-app/src/utils/collections/export.js writes `<collection name>.json`; the generic filename `bruno-collection.json` in the task is the common form in fixtures such as `tests/environments/create-environment/fixtures/bruno-collection.json`). It is **not** a directory and contains no `.bru` text; it is the in-app model serialized.

Detection markers (any one file, JSON):
- `version`: `"1"` (non-empty string; `SCHEMA` `collectionSchema` allows only `'1'`), `name` string, `items` array (this is exactly Bruno's `isBrunoCollection`).
- Recent exports add `exportedAt` (ISO date) and `exportedUsing` (`"Bruno/<version>"`), which the importer strips (`stripExportMetadata`). Older exports lack them (fixture `tests/import/bruno/fixtures/bruno-testbench.json` has keys `name, version, items, activeEnvironmentUid, environments, root, brunoConfig`).
- Not OpenCollection: no top-level `opencollection`/`info`. Not Postman: no `info._postman_id`/`schema`. Not Insomnia: no `_type`.

Structure (top level): `{ version, name, items[], environments[], activeEnvironmentUid, root, brunoConfig, exportedAt?, exportedUsing? }`.
- `items[]`: `type` is `http | graphql | grpc | ws | folder | js | app` on export (the UI model's `*-request` names are converted by `transformItem`; the importer converts back via `transformItemsInCollection`). Requests: `{type, name, seq, tags?, request:{url, method, headers[{name,value,enabled,description?}], params[{name,value,type:'query'|'path',enabled}], body:{mode, json, text, xml, sparql, formUrlEncoded[], multipartForm[{name,type:'text'|'file',value,contentType,enabled}], graphql:{query,variables}, file[]}, auth:{mode, <mode>:{...}}, script:{req,res}, vars:{req[],res[]}, assertions[{name,value,enabled}], tests, docs}, settings, examples[] }`. Folders: `{type:'folder', name, root:{meta:{name,seq}, request:{headers,auth,script,vars,tests}, docs}, items[]}`. Assertions here are `{name:"res.status", value:"eq 200"}` (operator embedded in value, same as `.bru`).
- Note the JSON model uses **camelCase body modes** (`formUrlEncoded`, `multipartForm`), arrays of objects instead of dictionaries, and the same field names as the parsed `.bru` (the filestore `parseBruRequest` output is the same shape with `type: http-request` etc.). Older exports may have `request.query` instead of `params` (importer migrates it).
- `environments[]`: `{name, variables:[{name, value, enabled, secret, type:'text'}]}`. **Secret variables are exported with `value: ""`** (`deleteSecretsInEnvs`), so secrets are never in the export (consistent with docs: "When you export your collection as a file, Bruno will not export the secret variables").
- `brunoConfig` embeds the whole `bruno.json` (proxy, client certificates, scripts, presets) - may contain proxy credentials in clear text.
- `root` is the collection-level equivalent of `collection.bru` (`request.headers/auth/vars/script/tests`, `docs`).
- uids and runtime state are stripped on export (`deleteUidsInItems`); older files may still carry `uid` fields.
- Two further things the same dialog can export: Postman collection and OpenAPI (different formats, out of scope).

Worth covering? Yes, briefly: it is the format people email around, it has a stable schema (`SCHEMA` Yup definitions), and mapping it shares ~90% of logic with the `.bru` import (same request model). It can be parsed with plain JSON; no grammar needed.

---

## 12. Riskiest parsing and mapping questions for an importer

1. **Format detection order**: `opencollection.yml` beats `bruno.json`; do not infer format from `*.bru` presence alone. A v4 user may have a migrated tree with `.yml` files left next to `.bru` files.
2. **No error recovery in the grammar**: any unknown block name, a `@annotation` line your parser ignores, a `//` comment line in a dictionary, or a stray `}` fails the whole file in Bruno itself - decide whether you fail or best-effort per file.
3. **Terminator rule**: text blocks end at newline + `}` at column 0 only; indentation (2 spaces, outdent strips up to 2) and `'''` multiline values (4-space net indent, strip exactly 4 chars then trim) are the two indentation systems and differ.
4. **Disabled entries use `~` on the key** and the writer reorders them after enabled ones; interleaved ordering is not recoverable. Quoted keys put `~` before the quote.
5. **Query/path params**: URL carries enabled query params AND `params:query` repeats them; disabled params exist only in the block. Path params are `:name` in the URL with values in `params:path`. Double-counting is the classic bug.
6. **Active body only**: `body: <mode>` in the verb block selects the body, but other `body:*` blocks can remain with stale content; `body:file` rows are selected via `~`; multipart `@file(a|b)` multi-file and `@contentType(...)` suffix (also on multiline values) need regex-level handling.
7. **Variables**: `{{process.env.X}}` needs a separate env-source concept (`.env` isn't in the repo); `{{$dynamic}}` names are faker-based with no exact equivalents elsewhere; `vars:post-response` values are expressions, not literals; `@name` local-var prefix and `@number/@boolean/@object` annotations (v4) change value types; `{{?Prompt}}` exists.
8. **Environment secrets**: `vars:secret [names]` carry no values anywhere (neither `.bru` nor JSON export); `extends` / `color` / `externalsecrets` blocks in env files change resolution semantics.
9. **Auth model**: request-level (`auth:` in verb block + `auth:*` block) vs collection/folder (`auth { mode }` + `auth:*`), `inherit` walks folder chain; credentials are plaintext in files; `oauth2` content depends on `grant_type` and has eight extra additional-params blocks.
10. **Scripts and assertions are Bruno-API specific** (`bru`, `req`, `res`, chai `test/expect`, assertion operators embedded as `"<op> <rhs>"` strings where a bare value means `eq`); ordering semantics of collection/folder/request scripts (`scripts.flow`) and `seq`-based ordering with defaulted `seq = 1` ties are underspecified.

UNCONFIRMED list (consolidated): exact `filesystemAccess` shape in `bruno.json`; `@file()` path base; sort/tie-break rule for mixed folder/request `seq`; semantics of `scripts.flow` values; gRPC proto-vs-reflection encoding; `app` item purpose; precise literal coercion of unquoted assertion operands; `res` query-path syntax in assertions; existence of `bru.runRequest`/cookie helpers; `guid`/`timestamp` output formats; exact inherit walk algorithm.
