import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};
globalThis.__NUVIO_PLATFORM__ = "browser";
globalThis.__NUVIO_ENV__ = { SIMKL_CLIENT_ID: "browser-public-client" };

const { Platform } = await import("../../platform/index.js");
Platform.current = null;
const { LocalStore } = await import("../../core/storage/localStore.js");
const { SimklAuthStore } = await import("../local/simklAuthStore.js");
const { SimklSyncService } = await import("./simklSyncService.js");

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("Simkl library sync refreshes stale snapshots from each tracking list", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const statuses = ["watching", "plantowatch", "hold", "completed", "dropped"];
  LocalStore.set("simklSyncState", {
    version: 1,
    profiles: {
      1: {
        schemaVersion: 1,
        initialized: true,
        watermark: "2026-10-26T00:00:00Z",
        entries: [],
        playback: [],
        activities: { all: "2026-10-26T00:00:00Z" }
      }
    }
  });
  const requestedStatuses = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(String(url));
    const status = parsedUrl.pathname.match(/^\/sync\/all-items\/all\/([^/]+)$/)?.[1];
    if (status) {
      requestedStatuses.push(status);
      const index = statuses.indexOf(status);
      return json({
        shows: [{ show: { title: `${status} show`, ids: { simkl: index + 1 } } }],
        movies: [{ movie: { title: `${status} movie`, ids: { simkl: index + 1 } } }],
        anime: [{ anime: { title: `${status} anime`, ids: { simkl: index + 1 } } }]
      });
    }
    if (parsedUrl.pathname === "/sync/playback") return json([]);
    if (parsedUrl.pathname === "/sync/activities") {
      return json({ all: "2026-10-26T00:00:00Z", tv_shows: {} });
    }
    assert.fail(`Unexpected Simkl request: ${parsedUrl.pathname}`);
  };

  try {
    const entries = await SimklSyncService.getLibraryEntries();
    assert.deepEqual(requestedStatuses, statuses);
    assert.equal(entries.length, statuses.length * 3);
    statuses.forEach((status) => {
      assert.equal(
        entries.filter((entry) => entry.listKeys.includes(`simkl:status:${status}`)).length,
        3
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
