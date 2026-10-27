import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  }
};

const { MdbListAccount } = await import("./mdbListAccount.js");
const { MdbListLibraryService } = await import("./mdbListLibraryService.js");

test("MDBList imports the watchlist and personal lists, then serves them from cache", async () => {
  storage.clear();
  const originalApi = MdbListAccount.api;
  const originalIsAuthenticated = MdbListAccount.isAuthenticated;
  const requests = [];
  const row = {
    mediatype: "movie",
    ids: { imdb: "tt1234567", tmdb: 42 },
    title: "Test movie",
    release_year: 2024
  };
  MdbListAccount.isAuthenticated = () => true;
  MdbListAccount.api = async (path, options = {}) => {
    requests.push(path);
    if (path === "/user") return { payload: { id: 123 } };
    if (path === "/lists/user") {
      return {
        payload: [
          {
            id: 20,
            user_id: 123,
            name: "Favorites",
            type: "static",
            private: true,
            mediatype: "movie"
          }
        ]
      };
    }
    if (path === "/external/lists/user") {
      return { payload: [{ id: 30, user_id: 456, name: "Shared list" }] };
    }
    if (path === "/lists/liked") {
      return options.query?.offset === 100
        ? {
            payload: {
              lists: [{ id: 40, user_id: 456, name: "Liked list" }],
              pagination: { has_more: false }
            }
          }
        : {
            payload: {
              lists: [],
              pagination: { offset: 0, limit: 100, total: 101, has_more: true }
            }
          };
    }
    if (
      path === "/watchlist/items" ||
      path === "/lists/20/items" ||
      path === "/external/lists/30/items" ||
      path === "/lists/40/items"
    ) {
      if (path === "/lists/20/items") {
        return {
          payload: [{ ...row, ids: { tmdb: 42 }, title: "Alternate title" }],
          headers: new Headers()
        };
      }
      return { payload: [row], headers: new Headers() };
    }
    assert.fail(`Unexpected MDBList API request: ${path}`);
  };

  try {
    const entries = await MdbListLibraryService.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "tt1234567");
    assert.deepEqual(
      new Set(entries[0].listKeys),
      new Set(["mdblist:watchlist", "mdblist:list:20", "mdblist:external:30", "mdblist:liked:40"])
    );
    assert.deepEqual(requests, [
      "/user",
      "/lists/user",
      "/external/lists/user",
      "/lists/liked",
      "/lists/liked",
      "/watchlist/items",
      "/lists/20/items",
      "/external/lists/30/items",
      "/lists/40/items"
    ]);

    await MdbListLibraryService.getEntries();
    assert.equal(requests.length, 9);
  } finally {
    MdbListAccount.api = originalApi;
    MdbListAccount.isAuthenticated = originalIsAuthenticated;
    storage.clear();
  }
});

test("MDBList item identity normalization does not mutate caller IDs", async () => {
  storage.clear();
  const originalApi = MdbListAccount.api;
  const originalIsAuthenticated = MdbListAccount.isAuthenticated;
  const item = { itemType: "movie", itemId: "tmdb:42", ids: { imdb: "tt1234567" } };
  MdbListAccount.isAuthenticated = () => true;
  MdbListAccount.api = async (path, options) => {
    if (path === "/user") return { payload: { id: 123 } };
    if (path === "/lists/user") return { payload: [] };
    if (path === "/external/lists/user") return { payload: [] };
    if (path === "/lists/liked") return { payload: { lists: [] } };
    if (path === "/watchlist/items") {
      return { payload: [], headers: new Headers() };
    }
    if (path === "/watchlist/items/add") {
      assert.deepEqual(options.body, {
        movies: [{ ids: { imdb: "tt1234567", tmdb: 42 } }]
      });
      return {
        payload: {
          added: { movies: 1 },
          existing: { movies: 0 },
          removed: { movies: 0 },
          not_found: { movies: 0 }
        }
      };
    }
    assert.fail(`Unexpected MDBList API request: ${path}`);
  };

  try {
    await MdbListLibraryService.applyMembershipChanges(item, {
      desiredMembership: { "mdblist:watchlist": true }
    });
    assert.deepEqual(item.ids, { imdb: "tt1234567" });
  } finally {
    MdbListAccount.api = originalApi;
    MdbListAccount.isAuthenticated = originalIsAuthenticated;
    storage.clear();
  }
});
