# Changelog

This changelog records the NuvioWeb fork work completed in this repository.
It focuses on user-visible behavior and the provider integrations that differ
from the initial upstream snapshot.

## 2026-10-27

### MDBList library integration

- Added MDBList account connection and disconnection support through the PIN
  and OAuth token flow.
- Added account validation using MDBList's `user_id` response field.
- Added a same-origin MDBList proxy for browser requests, avoiding the
  provider's browser CORS limitations.
- Added request serialization, a one-second request gap, timeout handling,
  explicit connection errors, and provider rate-limit handling.
- Added cached MDBList library data instead of downloading every list on every
  normal refresh.
- Added initial import of the watchlist and personal lists.
- Added activity-aware refresh behavior so external changes can be imported
  from MDBList without reconnecting the account.
- Added manual synchronization from the account settings screen.
- Added add/remove support for movies and shows using MDBList provider IDs.
- Added support for MDBList list membership in the shared library repository.

### Library actions and provider IDs

- Added MDBList, Simkl, Trakt, and local library behavior to the shared poster
  action system.
- Added add-to-library and remove-from-library actions to right-click,
  long-press, and keyboard poster menus.
- Added provider ID propagation from catalog cards and library cards through
  to provider mutations. This prevents a title from being displayed correctly
  while the provider receives an unusable identifier.
- Added Simkl's destructive-removal confirmation when removing a title would
  also clear watched history or a rating.
- Kept provider-specific list/status management available where a provider
  supports multiple destinations.
- Added the same library actions to the library screen, not only the Home
  screen or detail screen.

### Simkl synchronization

- Added two-phase synchronization behavior:
  - initial import downloads the required media types and stores activity
    timestamps;
  - later refreshes check `/sync/activities` and stop when nothing changed;
  - changed items are fetched through the consolidated delta endpoint where
    supported.
- Added local caching and refresh throttling to reduce API requests and avoid
  unnecessary rate-limit responses.
- Improved Simkl PIN/token connection, credential persistence, disconnect, and
  reconnect handling.
- Added status-aware Simkl library presentation and safe handling of anime,
  series, movies, and watched-history relationships.

### Trakt and runtime deployment

- Kept Trakt list and watchlist operations behind the shared library
  abstraction.
- Added browser-safe runtime configuration and server-side handling for
  provider credentials.
- Added Nginx and local development proxy routes for provider APIs.
- Rebuilt and verified the Docker deployment after the provider changes.

### Validation

- Added regression coverage for MDBList account, import, refresh, mutation,
  and provider-ID behavior.
- Added regression coverage for Simkl synchronization and status changes.
- Added regression coverage for shared poster actions across Home, Library,
  Search, Discover, Collection, pointer, touch, and keyboard invocation.
- Verified targeted tests, ESLint, Prettier, the production build, and the
  local Docker health check.

## Initial fork baseline

The initial repository snapshot already provided the NuvioWeb browser/PWA
client, Stremio addon discovery and playback, responsive layouts, offline-capable
PWA behavior, local saved-library support, and the original Trakt/Simkl
integration surfaces. The entries above describe the work added on top of
that baseline in this fork.
