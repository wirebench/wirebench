# Environment colour and a production guard — design

Issue #345 (milestone 5.1, P2, S). Sending to production by mistake is the most expensive slip in a
day of API work. Two new optional environment fields address it: a colour you can see, and a
`protected` flag that makes every send stop and ask.

## 1. File format

Both environment files gain two optional keys: the project's `environments/<slug>.yaml` and the
workspace's `environments/<slug>.yaml`.

```yaml
id: 0f6c…
name: Production
order: 2
color: red          # a palette name, or #rrggbb
protected: true     # absent means false
endpoints: {}
properties: {}
```

- `color` is a string. The palette has `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`
  and `grey`, and each name is drawn in a theme-aware shade. A `#rrggbb` value is used as written.
  Any other value loads fine and shows no colour, so a palette name added later does not make an
  older build drop the file.
- `protected` is a boolean. It is written only when it is true.
- Both keys are optional, so `FORMAT_VERSION` does not change. Older builds read these files
  already: both schemas are `looseObject`. They drop the keys on save, as they do with any key they
  do not know.
- The published `environment.schema.json` gains both keys.

## 2. Desktop

**Colour.** The title-bar environment switcher shows a dot in the environment's colour on its
trigger and on each menu item. When the active environment has a colour, the editor tab strip has a
3 px top border in that colour.

**Editing.** The environment page header has the palette as a row of swatches, plus "None" and a
custom `#rrggbb` field. It also has a "Protected" checkbox. Both work for workspace and project
environments. Duplicating an environment copies both fields.

**Guard.** A protected environment shows a lock in the switcher. A send that resolves under a
protected environment asks first, in a native warning box: "Send to Production?" with **Send** and
**Cancel** buttons, where Cancel is the default. Cancel refuses the send with `send-declined`, and
nothing reaches the wire or History.

The guard sits at the one choke point every saved-request send passes through
(`sendReserved` → `savedContext`). That covers the editor send for every protocol, History re-send
and HTTP Log resend. A caller that has already asked passes `protectedConfirmed: true`:

- **A sequence run** asks once before its first step, then runs every step confirmed. If declined,
  it refuses with `send-declined`.
- **Send to environments…** asks once for every protected environment in the batch, naming them
  all. If declined, those environments come back as `send-declined` results and the others still
  send.
- **A data-driven run** (#336), once it lands, asks once per run, as a sequence does.

An ad-hoc send has no environment, so it is never guarded. A send with no `confirmProtected` dep
(tests, or a headless caller) refuses rather than sending, so the guard fails safe.

## 3. CLI and MCP

- **`wirebench run`** under a protected environment prints
  `warning: "Production" is a protected environment` to stderr before anything is sent.
  `--refuse-protected` turns that into a usage error with code `environment-protected`, and nothing
  is sent.
- **`wirebench mcp`** refuses a protected environment with `environment-protected` unless the call
  passes `allowProtected: true`, so an agent cannot hit production silently. This applies to `send`
  and to every contract tool. Contract tools get `allowProtected` as a schema property, or
  `wirebench_allowProtected` when the operation already has an argument of that name, as
  `environment` does.
- **`wirebench call`** runs with open gates, as its terminal `send` does, so it is not refused: the
  person typing it chose the environment.
- A workspace environment also counts as protected when the project environment linked to it, the
  one with the same slug, is protected.

## 4. Out of scope

- Remembering a confirmation for a while.
- Colour in the History or Log rows.
- Protecting edits to the environment itself.
