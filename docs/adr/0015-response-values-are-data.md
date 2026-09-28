# ADR-0015: A value taken from a response is data, never a template

- Status: accepted
- Date: 2026-09-28
- Context: issue #62; `docs/specs/2026-09-28-sequences-design.md` (§Security). Applies to every later feature that
  moves response data into a request, scripting (#63) included.

## Context

Property expansion is recursive: `expand()` in `packages/engine/src/project/properties.ts` substitutes a value and then
expands the `${…}` references inside that value, up to depth 8. That is right for values a user typed, because
chaining one property through another is the point.

Sequences are the first feature that puts text a *server* chose into a property. Recursive expansion would let a
server answer `${secret:prod-db-password}` (or `${#System#HOME}`, or any environment value's name) and have the next
request send the resolved value back. Every secret in the keychain would then be one response away from any server a
sequence talks to.

The expansion defaults were also chosen for typed values in two other places. Escaping into a body is opt-in, so an
unescaped response value can add fields to a JSON or XML body. And nothing limits where in a URL a property can
appear, so a response value could pick the host that receives the next request's credentials.

## Decision

A value that comes from a response is carried in a scope of its own (for Sequences, `${#Sequence#name}`), and that
scope follows these rules. Any future scope with the same origin, a script's context included, follows them too.

- **Literal.** It is substituted as-is and never tokenised: no recursion, no `$${` escape, no reference inside it.
- **Never a name.** A reference whose own name was built from such a value (`${${#Sequence#n}}`,
  `${secret:${#Sequence#n}}`) is refused as `name-from-response`, since otherwise the server would choose which
  property or secret is read.
- **Explicit.** The shorthand `${name}` never reads it, so it can never shadow a value a request already uses.
- **Escaped where it lands.** It is always escaped for the body's language (JSON, XML, form), whatever the request's
  own `escape`/`entitize` setting.
- **Never the origin.** It may not change the scheme, host or port of a URL, SOAP endpoint or gRPC target, and it
  may not bring CR, LF or NUL into a URL, header or metadata.
- **Masked when secret.** A value that is marked secret, or that contains a credential the run already knows, is
  registered with the masker and never leaves the engine unmasked.

## Consequences

- Following a cross-host redirect by transfer is not possible. Anything that needs it must be designed as its own
  feature, with its own consent.
- A request that uses a response value has to say `${#Sequence#x}` in its own text, which makes it unresolved when it
  is sent on its own. That is the visible price of the explicit rule.
- Each per-protocol expander (`project/properties.ts`, `rest/expand.ts`, `grpc/expand.ts`, `ws/expand.ts`) has to
  apply the scope's escaping and guards. A new expander must too, and its tests have to include the hostile-value cases
  the Sequences tests use.
