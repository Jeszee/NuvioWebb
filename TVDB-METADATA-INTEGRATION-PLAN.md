# TVDB metadata integration plan

## Implementation status

The built-in TVDB provider has been implemented and deployed to the local `nuvioweb` Docker service. TVDB is optional, uses profile-scoped API-key/PIN settings, and remains independent of playback-progress providers. The user selected direct browser-to-TVDB requests, consistent with the existing MDBList integration pattern.

The repository tests and Docker checks are complete except for one unrelated locale-dependent full-suite test. The usage rights of the user's specific free TVDB keys for this deployment have not been independently verified; enable TVDB only when those keys are permitted for this use.

## Goal

Add TVDB as an optional, built-in API-backed fallback for series and episodes, following the existing MDBList integration pattern (a dedicated API service and profile-scoped settings/credentials), while keeping external metadata add-ons, TMDB enrichment, Simkl tracking, Nuvio Sync, and detail/home-screen behavior working. This is a direct TVDB integration, not a requirement to install or replace an external add-on. Simkl remains a watch-progress provider; selecting TVDB anime IDs must not make TVDB the tracking source.

The desired fallback is field-aware: preserve existing catalog/add-on values, use TMDB for missing fields when available, and consult TVDB only for supported fields still missing from both. TVDB must not replace useful titles, artwork, episode names, cast, production, or network data. Do not issue unnecessary TVDB requests when the available metadata already covers its supported fields.

## Current state and known constraints

- Simkl's anime ID preference affects identity, not metadata sourcing. It can select `tvdb:<id>` as the canonical tracking ID.
- Metadata ID candidates already carry IMDb, TMDB, TVDB, MAL, AniDB, AniList, Kitsu, and Simkl IDs where available.
- The TMDB resolver supports mapping a TVDB series ID through TMDB `/find` with `external_source=tvdb_id`. This is ID translation to TMDB, not direct TVDB enrichment.
- TMDB enrichment and language fallback already serve Home, Continue Watching/Up Next, and details. Avoid creating a parallel metadata path with different title/episode semantics.
- MDBList is existing prior art for a built-in API integration: it has a dedicated repository/service, profile-scoped settings, and provider-credential sync. Its current ratings API key is used by a browser-side request, so this pattern does not by itself make a credential secret from the browser or prove that TVDB permits the same deployment model.
- External metadata add-ons are a separate existing source and must remain usable with TVDB enabled. TVDB should not be implemented as an add-on-only option or require AIOmetadata or another third-party add-on.
- A global preferred metadata add-on setting exists and must continue to be honored. TVDB is fallback-only: existing catalog/add-on metadata and TMDB values have precedence.
- TVDB v4 API authentication, relevant series/episode endpoints, response fields, CORS, rate-limit behavior, caching, and attribution requirements were checked during implementation. The user's specific key/license rights for direct use in NuvioWeb remain unverified.
- NuvioTV issue [#3098](https://github.com/NuvioMedia/NuvioTV/issues/3098) requests TVDB as an alternate/primary series provider, including ID mapping and alternate season orders. Treat it as useful context, not as confirmation of this repository's requirements.

## Guardrails

1. Keep watch-progress ownership separate from metadata resolution. Simkl, Trakt, and Nuvio Sync continue to decide progress according to the existing setting.
2. Keep TMDB behavior intact for films and as a fallback for series/episodes. TVDB should not be required for existing TMDB-only setups.
3. Keep the configured external metadata add-on functional and preferred for fields it supplies.
4. Do not infer a provider from a bare numeric ID. Use explicit ID namespaces and verified mappings only.
5. TVDB credentials are profile-scoped and are not added to source code, build-time runtime configuration, or logs. The selected direct-browser model sends credentials to TVDB from the user's browser and syncs them through the existing provider-credential flow. This is an explicit product choice, not a claim that the user's key/license permits this deployment.
6. Preserve existing season/episode numbering unless a verified mapping is available. Never assume TVDB season ordering matches TMDB, Simkl, an add-on, or the user's playback source.
7. Respect TVDB API terms, attribution, caching, and rate limits. If requirements cannot be met safely, stop at a documented feasibility result rather than shipping a partial integration.
8. Preserve unrelated worktree changes. Do not reset, clean, or overwrite pre-existing changes.

## Implementation sequence

### Phase 1 — Establish a baseline

- Inspect the current worktree and retain all existing modifications.
- Run the targeted tests for TMDB resolution/enrichment, metadata add-on precedence, identity candidates, Simkl progress, Home Continue Watching/Up Next, and details.
- Record current behavior for:
  - TMDB enabled/disabled and Continue Watching enrichment enabled/disabled.
  - Preferred metadata add-on configured/unconfigured.
  - Simkl anime ID choices (TVDB, MAL/Kitsu, and default).
  - Nuvio Sync versus Simkl watch-progress source.
- Do not deploy or alter user settings during baseline work.

**Exit:** current failures are distinguished from regressions, and the actual metadata/progress inputs for a representative anime can be traced through Home and details.

### Phase 2 — Verify TVDB feasibility before coding

- Read the official TVDB v4 API documentation and current OpenAPI/Swagger schema.
- Verify the exact endpoints and fields needed for:
  - Series lookup by TVDB ID and external IDs.
  - Localized and original series names/overviews.
  - Seasons, episodes, episode descriptions, artwork, ratings, cast/people, networks, and production.
  - Alternate season orders and how their episode IDs/numbers map.
- Verify authentication (including whether an API key, PIN, or short-lived bearer token is needed), user credential obligations, API limits, caching rules, attribution, and permitted redistribution/use.
- Compare TVDB coverage and ordering to the existing TMDB and add-on data for representative anime. Avoid assuming TVDB is always more complete.
- Verify whether TVDB requests can be made from the browser (including CORS and credential exposure) or require a server-side proxy. Decide whether the existing profile-scoped provider-credential flow is appropriate; account for API-key/PIN handling and token refresh/expiry. If a browser-side credential is not acceptable, report the blocker and propose a compliant proxy or another alternative; do not introduce an unsafe key.

**Exit:** the implementation decision and known gaps are documented below. Direct browser requests were selected by the user; key/license permissions remain an open verification item.

### Phase 3 — Design a shared, field-aware enrichment contract

- Add TVDB as a first-party API provider, following the relevant MDBList service/settings/credential patterns, while reusing the existing metadata identity candidates and a shared enrichment contract rather than building separate Home and details implementations. Keep external metadata add-ons as an independent provider path.
- Define a normalized metadata shape and merge rules for title, overview, artwork, ratings, credits, production/networks, seasons, and episodes.
- Keep provenance for fields where source distinction matters (especially ratings and episode numbering); never label a TVDB rating as IMDb/TMDB.
- Define precedence explicitly:
  1. Existing catalog/add-on values remain authoritative when useful.
  2. TMDB fills missing supported fields when available.
  3. TVDB fills supported fields still missing from both the catalog/add-on and TMDB.
- Resolve titles using requested language, English, then original language where available; do not use a Japanese original title to overwrite a valid English/localized title.
- Make TVDB opt-in and independently disableable. Existing settings and behavior remain the default unless the user chooses otherwise.
- Define timeout, failure, cache key/TTL, invalidation, retry, and concurrent-request behavior. A TVDB failure must leave existing add-on/TMDB metadata usable.

**Exit:** merge behavior, settings, and precedence are implemented and covered by tests.

### Phase 4 — Implementation completed

1. Added a TVDB v4 client with explicit ID namespaces, bounded request timeouts, token and metadata caching, 429 cooldown handling, and response mapping. TVDB is now fallback-only and unnecessary TVDB calls are skipped when the existing/TMDB metadata already covers its supported fields.
2. Added opt-in profile-scoped settings, credential sync, masked settings fields, and a user-triggered connection test. New profiles do not inherit another profile's TVDB credentials.
3. Added a shared field-aware enrichment flow: existing catalog/add-on values remain authoritative, TMDB fills missing fields where available, and TVDB supplies only supported fields still missing. Films remain TMDB-only.
4. Wired Home, Continue Watching, and details through the shared enrichment path; TVDB enablement participates in the Continue Watching cache signature.
5. Resolve TVDB only from explicit TVDB identity fields/namespaces. TMDB remains available to translate supported external IDs.
6. Episode lookup requires an explicit TVDB episode ID. Alternate season ordering is not remapped or guessed.
7. Added TVDB attribution and API-use disclosure in settings and attribution UI.

**Exit:** covered by the metadata precedence, ID-resolution, profile-settings, and credential-sync tests.

### Phase 5 — Regression and release validation

Add/update tests for:

- Provider precedence and per-field fallback, including existing metadata → TMDB → TVDB and each provider missing/failing.
- Localized title selection: requested language → English → original language.
- Correct TVDB ID resolution, and rejection of namespace confusion (TVDB/MAL/Simkl IDs never treated as raw TMDB IDs).
- Episode titles/descriptions and season-order mapping, including missing IDs and specials.
- Identical metadata behavior in Home poster, hover preview, Continue Watching, Up Next, and details.
- Simkl/Trakt/Nuvio Sync progress-source switching without changing progress ownership or duplicating cards.
- TVDB disabled, missing credentials, expired auth, timeout, rate limit, malformed response, and offline behavior.
- Credential masking, profile separation, sync behavior, and no secret leakage in logs or bundles.
- Movies and non-TVDB content retaining existing behavior.

Validation results:

- Targeted TVDB, metadata, credential, cache-signature, and progress regressions: 53 passed, 0 failed.
- Full suite: 1,145 passed, 1 failed. The remaining failure is the existing subtitle-picker test expecting `"English"` while Windows `Intl.DisplayNames` resolves `eng` as `"Engels"` under the current `nl-NL` locale.
- ESLint on changed JavaScript implementation and integration files: passed.
- Prettier check on the new TVDB service/store/test files and environment documentation: passed.
- `npm run build` using local environment configuration: passed.
- `git diff --check`: passed; Git emitted only existing LF-to-CRLF working-copy warnings.
- Docker image rebuild: passed. The `nuvioweb` service alone was recreated; it became healthy and returned HTTP 200. The three bridge services were left running and healthy.

## Completion criteria

- TVDB metadata can be opted into without making TVDB responsible for playback progress.
- A configured external metadata add-on continues to win for fields it supplies.
- TMDB remains a complete fallback, and TMDB-only users see no regression.
- Catalog title, hover/details title, episode names, and episode metadata are consistent across Home, Continue Watching, Up Next, and details.
- TVDB season/episode order is either mapped reliably or explicitly left unchanged; no guessed remapping.
- Targeted tests, lint, formatting, build, and Docker health checks pass; the unrelated locale-sensitive full-suite failure remains.
- The user's TVDB-key/license permissions for this direct browser integration remain unverified.
- Episode enrichment requires explicit TVDB episode IDs; alternate season-order mapping is not implemented.

## Remaining follow-up

Verify that the user's particular TVDB API key and account terms permit this direct browser-based use in NuvioWeb. If not, disable the provider and decide whether a compliant server-side integration is available.
