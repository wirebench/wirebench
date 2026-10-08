# ADR-0021: Mock stubs are files under `mocks/`, one per response, with their own version

- Status: accepted
- Date: 2026-10-08
- Context: issue #59; `docs/specs/2026-10-08-mock-services-design.md` (§Storage, §The protocol facet,
  §Security). Extends ADR-0003 (project format) and follows its 2026-09-28 sequences update. Scripts run under
  ADR-0016, and the facet follows ADR-0017.

## Context

A mock service is a new kind of thing in a project. It has settings, one entry per contract operation, and
any number of canned responses (stubs) per operation, each with a status, headers, a body, and the rules that
decide when it is sent. The recording proxy (#60) will write stubs from live traffic, and the headless
`wirebench mock` (#61) will run them in CI from a checked-out repository. Whatever goes on disk now is what
reviewers read, what merges have to merge, and what an older build has to survive. That makes it a one-way door.

## Decision

**Layout.**
- Each mock is a folder `mocks/<slug>/` holding `mock.yaml`.
- Each operation is a folder `operations/<slug>/` holding `operation.yaml`.
- **Each response is its own `<slug>.response.yaml`**, with its body beside it as
  `<slug>.body.xml|json|txt`.
- A script that dispatches the operation is the fixed name `dispatch.ts` in the operation's folder.

**References are ids.**
- A mock names its interface or API by id.
- An operation names its default response by id.
- An operation names its contract operation by the protocol's own key: the operation name within the mock's
  binding for SOAP, and `<method> <path template>` for REST.

Renames never break a mock, and nothing in a mock file names a path on disk.

**Versioning.** `mock.yaml` carries `kind: mock` and `version: 1`. The operation and response files belong
to that version. The project's `formatVersion` does not move. An older build walks only the top-level
folders it knows, never counts a file under `mocks/` as managed, and therefore leaves the folder byte for
byte. This build counts as managed only the mock files it loaded, so a file it refused (too new, malformed,
a duplicate) survives every save. A later change to any mock file's shape bumps `version`, and a build
refuses only the mocks that are too new for it.

**Stubs are literal data.**
- A body is sent byte for byte. No `${…}` is expanded, and no property or secret is read.
- A header is refused at load if it holds CR, LF or NUL, or if it is one of the hop-by-hop fields the
  server computes.

**The host is not in the file.** `mock.yaml` holds the port and path. The listening host is a start option
that defaults to loopback, so a shared file cannot make a machine listen on every interface.

**The contract comes from the definition cache.** A mock validates against the interface's or API's cached
definition, read offline. It never fetches one, so it behaves the same on a laptop and in CI.

**Protocols plug in through a facet.** The mock core (`mock/`) holds the files, dispatch, scenarios and the
HTTP server. Each protocol's routing, validation, faults and generation sit behind an optional
`ProtocolModule.mock` facet. SOAP and REST implement it, and gRPC and WebSocket do not yet.

## Consequences

- An operation with many stubs is many small files. That is what lets two people, or a person and the
  recorder, add stubs to one operation without a conflict. It is also what keeps a recorded body readable in
  a diff. The loader bounds the counts and sizes, so a big recording cannot make a project slow to open
  without saying so.
- 5.0 is not forced to be a major by this file kind, as 3.0 was not by sequences. The roadmap says so.
- Dynamic responses (echoing request values) need a later decision. Turning a stub into a template is a new
  input path from the network into text a user reads, and ADR-0015's rules would have to be turned around to
  cover it. A future `version: 2` response field is the place for it.
- Lifecycle scripts, when they come, run under ADR-0016 like the dispatch script.

## Alternatives considered

- **One YAML file per mock, with stubs inline.** It is easy to read when small. But every new stub is a
  conflict with every other, the recorder would rewrite a shared file on every capture, and a body would
  have to be an escaped YAML string.
- **One file per operation, listing its responses.** It is the same conflict problem one level down.
- **A `formatVersion` bump.** It would make older builds refuse every project this build saves, even ones
  with no mocks. That protects nothing an older build could lose, because it never reads `mocks/`.
- **The host in `mock.yaml`.** It would be convenient for container use, but it hands a teammate's file
  the choice of exposing your machine. #61 takes the host as a flag instead.
