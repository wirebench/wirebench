# Variables in the editor — plan

Spec: `docs/specs/2026-10-11-variables-in-the-editor-design.md` · issue #340.

Each task is test-first and gets its own commit once
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Reference scanner (engine).** Add `project/references.ts` with `propertyReferences(text)`.
   Re-export it from `rest/browser.ts` and the engine index. Tests cover the forms, the escape,
   nesting, malformed input, and parity with `expand()` spans.
2. **`variables.list` (main).** Add the schemas to `wire-base.ts` and the channel to `ipc.ts`. Add a
   handler that builds entries from `runContextFor` + `scopesFor`, covering masking, shadowing, edit
   targets and secret names. Update the ipc-names fixture and the renderer API mock. Tests: the
   entries, and that no secret plaintext appears.
3. **Renderer model.** Add `state/request-variables.ts` (fetch + refresh hook) and
   `editor/variable-assist.ts` (pure): completion context and items, classification, the insert
   form, hover content. Unit tests.
4. **Monaco.** Add `editor/variable-assist-monaco.ts`: the providers, the model registry, markers,
   the Edit command and the Set-as-variable action hook. Extend the fake Monaco for `addAction` and
   `executeEdits`. Tests through the fake.
5. **Plain fields.** Add `VariableAssistContext`, the mirror with the unresolved underline, the
   completion popup and the hover card. Wire them into `PropertyHighlightInput`, `KvTable` cells and
   the auth inputs. jsdom tests.
6. **Set as variable.** Add `SetVariableDialog` and its scope writers. Hook it into the Monaco
   action, the SOAP Radix menu and the field selection menu. Tests.
7. **Wire the kinds.** Add providers in the REST, SOAP, gRPC and WebSocket editors, and attach the
   request and response Monaco editors. Then add an e2e spec, the docs-site property-syntax section
   and a CHANGELOG entry.

After #384 (#333) merges: re-sync, then add the generators to classification and the hover.
