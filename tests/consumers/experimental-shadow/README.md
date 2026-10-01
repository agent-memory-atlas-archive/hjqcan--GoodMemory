# Experimental shadow package consumer

Copy this directory into a clean workspace. Install or extract only the locally
built candidate tarballs for `goodmemory` and `@cognitive-hub/core` there. Use
`consumer-types.ts` + `tsconfig.json` for strict Bundler-mode declarations. The
cross-package type fixture is intentionally excluded from GoodMemory's source
typecheck: it must resolve the actual packaged Hub rather than a repo alias.

- Node20: `node --import ./offline-guard.mjs single.mjs`
- Node22 composite: copy `examples/cognitivehub-shadow/replay.mjs` here and run
  `node --import ./offline-guard.mjs replay.mjs package:goodmemory package:@cognitive-hub/core/goodmemory-shadow ./reports package:goodmemory/experimental/shadow`
- Bun actual host: also provide the packaged `@hjqcan/tachikoma-core` and its
  declared runtime dependencies, then run
  `bun --preload ./offline-guard.mjs host.mjs ./host-reports`

Use an empty test HOME and XDG_CONFIG_HOME for the host fixture. It creates only
synthetic temporary sessions and removes them. No real credentials/model calls
are permitted. There are no relative imports into any sibling source checkout.
The host registry dependency and package versions are not changed by this test.
