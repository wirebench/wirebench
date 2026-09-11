# Roadmap follow-ups

Not gaps in v1 — things noticed while building it that are deliberately out of scope for now,
recorded here so they are not lost.

- **Same-host `http://` → `https://` 301 on a POST.** `packages/engine/test/interop/public-services.test.ts`
  posts straight to the redirect target for `tempconvert` (see the comment on that fixture)
  because Wirebench does not follow redirects on `send` by default: `fetch`/undici semantics
  downgrade a redirected POST to a GET, which would silently turn a SOAP call into a page fetch
  and lose the envelope. That is the right default, but a same-host, same-path `http→https`
  upgrade is common enough (`tempconvert` is a live example) that it is worth a purpose-built
  case: either preserve the method and body across exactly that redirect shape, or — if that is
  judged too surprising to do silently — detect it and surface a Problem telling the user their
  request was declined rather than silently sent nowhere. Left as a follow-up because it is a
  design decision (which of the two, and how narrow "same-host, upgrade-only" needs to be) that
  a bug-fix pass should not make in passing.
