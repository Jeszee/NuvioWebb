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

function item(type, id, status, title = `${status} ${type} ${id}`) {
  const mediaKey = type === "shows" ? "show" : type === "movies" ? "movie" : "anime";
  return {
    status,
    [mediaKey]: { title, ids: { simkl: id } }
  };
}

test("initial Simkl import snapshots activities before fetching each media type once", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const statuses = ["watching", "plantowatch", "hold", "completed", "dropped"];
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(String(url));
    calls.push(`${parsedUrl.pathname}${parsedUrl.search}`);
    if (parsedUrl.pathname === "/sync/activities") {
      return json({ all: "2026-10-26T00:00:00Z", tv_shows: {} });
    }
    if (parsedUrl.pathname === "/sync/all-items/shows") {
      return json({ shows: statuses.map((status, index) => item("shows", index + 1, status)) });
    }
    if (parsedUrl.pathname === "/sync/all-items/movies") {
      return json({
        movies: ["plantowatch", "completed", "dropped"].map((status, index) =>
          item("movies", index + 10, status)
        )
      });
    }
    if (parsedUrl.pathname === "/sync/all-items/anime") {
      return json({ anime: statuses.map((status, index) => item("anime", index + 20, status)) });
    }
    if (parsedUrl.pathname === "/sync/playback") return json([]);
    assert.fail(`Unexpected Simkl request: ${parsedUrl.pathname}`);
  };

  try {
    const entries = await SimklSyncService.getLibraryEntries();
    assert.deepEqual(
      calls.map((call) => call.split("?")[0]),
      [
        "/sync/activities",
        "/sync/all-items/shows",
        "/sync/all-items/movies",
        "/sync/all-items/anime",
        "/sync/playback"
      ]
    );
    assert.match(calls[1], /extended=full/);
    assert.match(calls[1], /include_all_episodes=original/);
    assert.doesNotMatch(calls[1], /full_anime_seasons|include_all_episodes=yes/);
    assert.match(calls[2], /language=en/);
    assert.equal(entries.length, 13);
    statuses.forEach((status) => {
      assert.equal(
        entries.filter((entry) => entry.listKeys.includes(`simkl:status:${status}`)).length,
        status === "watching" || status === "hold" ? 2 : 3
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("initial Simkl import falls back to item-level results when episode payload exceeds API limits", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(String(url));
    calls.push(parsedUrl);
    if (parsedUrl.pathname === "/sync/activities") {
      return json({ all: "2026-10-26T00:00:00Z" });
    }
    if (parsedUrl.pathname === "/sync/all-items/shows" && parsedUrl.searchParams.has("extended")) {
      return new Response(JSON.stringify({ error: "max_items", code: 400 }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (parsedUrl.pathname === "/sync/all-items/shows") {
      return json({ shows: [item("shows", 1, "watching", "Imported show")] });
    }
    if (parsedUrl.pathname === "/sync/all-items/movies") return json({});
    if (parsedUrl.pathname === "/sync/all-items/anime") return json({});
    if (parsedUrl.pathname === "/sync/playback") return json([]);
    assert.fail(`Unexpected Simkl request: ${parsedUrl.pathname}${parsedUrl.search}`);
  };

  try {
    const entries = await SimklSyncService.getLibraryEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "Imported show");
    assert.deepEqual(
      calls
        .filter((call) => call.pathname === "/sync/all-items/shows")
        .map((call) => call.searchParams.get("extended")),
      ["full", null]
    );
    assert.equal(SimklSyncService.getSnapshot().initialized, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incremental Simkl sync fetches one delta and reconciles removed items", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const watermark = "2026-10-26T00:00:00Z";
  const activities = {
    all: watermark,
    tv_shows: { watching: "before", removed_from_list: "before" },
    movies: {},
    anime: {}
  };
  LocalStore.set("simklSyncState", {
    version: 1,
    profiles: {
      1: {
        schemaVersion: 3,
        initialized: true,
        watermark,
        activities,
        entries: [
          item("shows", 1, "watching", "Existing show"),
          item("shows", 2, "plantowatch", "Removed show")
        ],
        playback: [],
        lastSyncedAt: 0,
        lastCheckedAt: 0
      }
    }
  });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(String(url));
    calls.push(parsedUrl);
    if (parsedUrl.pathname === "/sync/activities") {
      return json({
        all: "2026-10-26T01:00:00Z",
        tv_shows: { watching: "after", removed_from_list: "after" },
        movies: {},
        anime: {}
      });
    }
    if (parsedUrl.pathname === "/sync/all-items") {
      if (parsedUrl.searchParams.has("date_from")) {
        return json({ shows: [item("shows", 1, "completed", "Updated show")] });
      }
      if (parsedUrl.searchParams.get("extended") === "simkl_ids_only") {
        return json({ shows: [{ show: { ids: { simkl: 1 } } }] });
      }
    }
    assert.fail(`Unexpected Simkl request: ${parsedUrl.pathname}${parsedUrl.search}`);
  };

  try {
    const entries = await SimklSyncService.getLibraryEntries();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].pathname, "/sync/activities");
    assert.equal(calls[1].pathname, "/sync/all-items");
    assert.equal(calls[1].searchParams.get("date_from"), watermark);
    assert.equal(calls[1].searchParams.get("extended"), "full");
    assert.equal(calls[1].searchParams.get("include_all_episodes"), "original");
    assert.equal(calls[2].pathname, "/sync/all-items");
    assert.equal(calls[2].searchParams.get("extended"), "simkl_ids_only");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "Updated show");
    assert.deepEqual(entries[0].listKeys, ["simkl:status:completed"]);
    assert.equal(SimklSyncService.getSnapshot().watermark, "2026-10-26T01:00:00Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unchanged Simkl activity timestamps stop after the activities request", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const watermark = "2026-10-26T00:00:00Z";
  LocalStore.set("simklSyncState", {
    version: 1,
    profiles: {
      1: {
        schemaVersion: 3,
        initialized: true,
        watermark,
        activities: { all: watermark },
        entries: [],
        playback: [],
        lastSyncedAt: 0,
        lastCheckedAt: 0
      }
    }
  });

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(String(url));
    calls.push(parsedUrl.pathname);
    assert.equal(parsedUrl.pathname, "/sync/activities");
    return json({ all: watermark });
  };

  try {
    await SimklSyncService.getLibraryEntries();
    assert.deepEqual(calls, ["/sync/activities"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forced Simkl refreshes are throttled across repeated user-triggered calls", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  const watermark = "2026-10-26T00:00:00Z";
  LocalStore.set("simklSyncState", {
    version: 1,
    profiles: {
      1: {
        schemaVersion: 3,
        initialized: true,
        watermark,
        activities: { all: watermark },
        entries: [],
        playback: [],
        lastSyncedAt: 0,
        lastCheckedAt: 0
      }
    }
  });

  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return json({ all: watermark });
  };

  try {
    assert.equal(await SimklSyncService.refresh({ force: true }), true);
    assert.equal(await SimklSyncService.refresh({ force: true }), false);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
