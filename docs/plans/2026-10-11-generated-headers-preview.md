# Preview of generated headers — plan

Spec: `docs/specs/2026-10-11-generated-headers-preview-design.md` · issue #346

Each task is test-first and ends with one commit after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

1. **Engine: `omitHeaders` and shared header rows.** Add the setting (model, file schema, desktop wire
   schema, `toRestSendInput`). Add `rest/request-headers.ts` (`restHeaderRows`) and make `sendRest`
   build its headers from it; omitting `Cookie` skips the jar. Tests: rows, states, wire behaviour.
2. **Engine: `previewRestHeaders`.** Rows plus `Host`, `Content-Length` and a handshake
   `Authorization`. Code generation and the cURL export skip omitted headers. Export from the index.
3. **Desktop main: `request.restHeaders` channel.** Wire schema, channel, handler in the REST kind,
   masking per *Show secrets*, cached OAuth2 token only. ipc-names fixture and the API mock.
4. **Renderer: Generated section in the Headers tab.** Rows with source, switch and Override,
   read-only notes; debounced fetch with the draft. The WebSocket editor keeps its current tab.
5. **Docs and CHANGELOG.** User docs for the Headers tab and the request file's `omitHeaders`.
