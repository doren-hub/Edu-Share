# Zod / OpenAI SDK migration (#168)

## Versions and API compatibility

- Zod 3.25.76 → **4.6.7** (at least the 4.6.6 security fix).
- OpenAI SDK 4.104.0 → **7.45.1**. Its optional Zod peer accepts `^3.25 || ^4.0`.
- Both direct dependencies are pinned explicitly, with a regenerated lockfile;
  no forced audit update or peer override is used. OpenAI 7.45.1 requires Node
  **22 or later**, matching the CI Node 22 runtime.
- All Zod API input schemas live in `src/lib/api-input-schemas.ts`, without
  service-client imports, and are used by the route handlers and offline tests.
- Removed `ZodError.errors` uses in favor of `issues`. Quiz answers now use
  `z.record(z.string(), valueSchema)`. Existing `flatten()` response shapes,
  custom picklist messages, trimming, unknown-key stripping, optional and
  nullable fields remain in use. Default Zod error wording can change in v4.
- UUID validation follows Zod 4's stricter RFC variant/version rules. Actual
  Supabase UUIDs remain valid; malformed UUID-like strings can now be rejected.

See the [Zod migration guide](https://zod.dev/v4/changelog) and the installed
OpenAI SDK's `resources/embeddings` and `internal/embeddings` implementations.
The app uses embeddings only, with no OpenAI Zod helpers.

## Security regression coverage

The Zod 4.6.7 array parser checks the leading `.max()` constraint before
validating elements. Tests exercise the **actual route schemas** for history
(max 6), industries (max 10), and paper_authors (max 24). At max + 1 and at
10 million entries, a getter that throws on the first element proves no element
is visited; rejection produces exactly one `too_big` issue. At the boundary,
valid items succeed and malformed items fail. This avoids flaky timing limits
and allocating millions of validation issues.

This bounds array **schema validation**. HTTP body buffering and JSON parsing
still scale with request size; transport-level body limits are a separate
concern. No request-body streaming or proxy configuration is changed here.
Quiz answer records retain their existing semantics and have no new size cap.

Offline schema tests cover each input schema's success and failure paths,
field limits, enums, record values, custom errors, UUIDs and normalization.
The embeddings test replaces `fetch` entirely: it checks endpoint, method,
authorization with a fake key, model, dimensions and input, exercises automatic
base64 decoding and float-array responses, verifies sorting by index and the
single-query wrapper, and checks that disabled keys send no requests.

## Verification

Run `npm ci`, `npm ls`, `npm audit`, `npm test`, and `npm run lint`.
The final head SHA, command, execution timestamp, elapsed time and exit code
are recorded in PR #174 before Claude review. Draft review uses that local
evidence; Ready CI must pass on the same head before merging.

Additional `tsc --noEmit --incremental false` inspection found existing errors
in the ask route's nullable map/filter type predicate and the graph route's
Supabase RPC promise type. The same errors occur in the unchanged main source
with the installed dependencies. These unrelated errors are outside this
migration; no new TypeScript errors from the migrated schemas or SDK are
accepted. CI currently runs lint and tests, not a full app typecheck.

No production Supabase, R2, AI API, environment files, or paper-pipeline CLI
are used by this migration's local verification.
