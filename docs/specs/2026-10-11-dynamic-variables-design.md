# Spec: Dynamic variables

**Date:** 2026-10-11
**Status:** accepted
**Scope:** [#333](https://github.com/wirebench/wirebench/issues/333).

## 1. Problem

A request often needs a fresh ID, timestamp or random value on every send. Today an imported
`{{$guid}}`, `{{$timestamp}}` or `{{$randomInt}}` is kept as text with a warning, so the request sends a
literal placeholder, and there is no way to write such a value by hand either.

## 2. Syntax

A new property scope, `Dynamic`, whose names are **generators**:

| Form     | Example                                                   |
| -------- | --------------------------------------------------------- |
| Explicit | `${#Dynamic#guid}`, `${#Dynamic#randomInt(1,100)}`        |
| Short    | `${$guid}`, `${$isoTimestamp(+1d)}`, `${$lorem(words=5)}` |

- The short form is a `$` straight after `${`. It always means the Dynamic scope: a property whose name
  starts with `$` is no longer reachable by the `${name}` shorthand (it still is by its explicit scope).
- Arguments go in parentheses after the name, comma-separated, each either positional (`1`) or named
  (`words=5`). Whitespace around them is ignored.
- A reference inside the argument list is expanded first, so `${$randomInt(1,${max})}` works.
- An unknown generator is reported as `missing`; arguments a generator refuses as the new code
  `bad-arguments`. Either way the reference stays unexpanded and a send refuses it, as for any other
  unresolved reference.

## 3. Once per send

Each distinct reference resolves once per send: the same `${$guid}` used in the URL and a header of one
request gives the same value. The memo is keyed by the generator's canonical name and its arguments, so
`${$guid}` and `${#Dynamic#uuid}` share a value, and `randomInt(1,10)` and `randomInt(1,100)` do not.

The memo lives on the `PropertyScopes` object (`dynamic`), created fresh wherever a send's scopes are
built: the engine's `scopesFor` (desktop, CLI and MCP sends all go through it) and the desktop
`ProjectHost.scopesFor` (WebSocket pushes, sequence callback checks). Spreading the scopes keeps the same
memo. When `expand` is given scopes with no memo, it makes one for that call.

The values are generated in the main process (or the CLI) before the request goes out, so the HTTP Log
and History show what was actually sent. A desktop preview expands with its own scopes, so its values
differ from the next send's.

Generated values are literal: never expanded again.

## 4. Generators

Canonical names, with aliases in brackets. The `random…` aliases are the spellings imported files use.
An alias may carry default arguments (`randomLoremWords` is `lorem(words=3)`).

| Generator                                                         | Value                                      | Arguments                                  |
| ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `guid` [`uuid`, `randomUUID`]                                     | UUID v4                                    | —                                          |
| `timestamp`                                                       | Unix seconds                               | offset, e.g. `-1h`, `+2d`                  |
| `isoTimestamp`                                                    | ISO 8601 UTC                               | offset                                     |
| `randomInt`                                                       | integer, default 0–1000                    | `min,max`                                  |
| `randomBoolean`                                                   | `true`/`false`                             | —                                          |
| `randomAlphaNumeric`                                              | `[a-z0-9]`, default 1 char                 | `length`                                   |
| `firstName`, `lastName`, `fullName`, `userName`, `email`, `phone` | fake person data                           | —                                          |
| `streetAddress`, `city`, `country`, `countryCode`                 | fake address data                          | —                                          |
| `company`                                                         | company name                               | —                                          |
| `lorem`                                                           | one sentence by default                    | `words=N`, `sentences=N` or `paragraphs=N` |
| `datePast`, `dateFuture`                                          | ISO date within N days, default 365        | `days`                                     |
| `dateRecent`                                                      | ISO date within the last N days, default 1 | `days`                                     |
| `ip`, `ipv6`, `mac`                                               | addresses                                  | —                                          |
| `url`, `domain`                                                   | `https://…` URL, domain name               | —                                          |
| `color`, `hexColor`                                               | colour name, `#rrggbb`                     | —                                          |
| `currencyCode`, `price`                                           | ISO 4217 code, `123.45`                    | —                                          |
| `fileName`, `mimeType`                                            | file name with extension, MIME type        | —                                          |

Offsets are `[+-]N` followed by `s`, `m`, `h`, `d` or `w`. Randomness comes from Web Crypto
(`crypto.getRandomValues`, `crypto.randomUUID`), available in Node and the renderer alike. The word lists
are small and built in; no new dependency.

## 5. Importers

`rewriteMustache` (Postman collections and variables, OpenCollection, `.http`) rewrites a `{{$name}}`
whose name is a known generator or alias to `${$name}`. Anything else keeps today's behaviour: kept as
written and named in the "Dynamic variables are kept as written" warning.

The `.http` importer also maps its argument forms: `{{$randomInt min max}}` → `${$randomInt(min,max)}`
and `{{$datetime iso8601}}` → `${$isoTimestamp}`. Other `.http` forms (`$localDatetime`, custom date
formats) stay unmapped and warned.

## 6. Desktop completion

- The Form view's **Get Data…** picker gains a Dynamic section listing every generator with a one-line
  description; choosing one inserts `${$name}`.
- The body editors (XML, JSON, plain text) gain a completion triggered by typing `${$` that lists the
  generators.
- The renderer reads the catalogue through the browser-safe `@wirebench/engine/rest` entry, which
  re-exports it (the generators module holds no zod and no Node import).

## 7. Out of scope

- Exporters keep writing `${$name}` as `{{$name}}` (the shorthand rule); arguments are not translated.
- Seeded or reproducible values.
- Locale-specific fake data.
