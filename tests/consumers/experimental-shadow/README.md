# Experimental shadow package consumer

Copy this directory into a clean workspace. Install or extract only the locally
built candidate tarballs for `goodmemory` and `@cognitive-hub/core` there. Use
`consumer-types.ts` + `tsconfig.json` for strict Bundler-mode declarations. The
cross-package type fixture is intentionally excluded from GoodMemory's source
typecheck: it must resolve the actual packaged Hub rather than a repo alias.
For `host.mjs` or `configured.mjs`, copy the explicit
`examples/cognitivehub-shadow/configured-host.mjs` loader beside the consumer and
use the local Hub candidate that exports `createConfiguredGoodMemoryShadowAdvisor`.

- Node20: `node --import ./offline-guard.mjs single.mjs`
- Node22 composite: copy `examples/cognitivehub-shadow/replay.mjs` here and run
  `node --import ./offline-guard.mjs replay.mjs package:goodmemory package:@cognitive-hub/core/goodmemory-shadow ./reports package:goodmemory/experimental/shadow`
- Bun actual host: also provide the packaged `@hjqcan/tachikoma-core` and its
  declared runtime dependencies, then run
  `bun --preload ./offline-guard.mjs host.mjs ./host-reports`
  This creates a synthetic JSON configuration and fake HTTP transport, then calls
  the configured advisor after actual ChatSession writeback. It does not install
  automatic shadow hooks into the production ChatEngine.
- Configured Node22 consumer: copy `examples/cognitivehub-shadow/configured-host.mjs`
  beside `configured.mjs`, provide the local Hub candidate containing
  `createConfiguredGoodMemoryShadowAdvisor`, then run
  `node --import ./offline-guard.mjs configured.mjs`. All API keys and HTTP responses
  in this consumer are synthetic. It checks disabled/missing-key/failure/stale
  behavior without reading real credentials or sending a network request.

Use an empty test HOME and XDG_CONFIG_HOME for the host fixture. It creates only
synthetic temporary sessions and removes them. No real credentials/model calls
are permitted. There are no relative imports into any sibling source checkout.
The host registry dependency and package versions are not changed by this test.
