import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const { LocalStore } = await import("../../core/storage/localStore.js");
const { ProfileManager } = await import("../../core/profile/profileManager.js");
const { SimklAnimeIdPreference, TraktSettingsStore } =
  await import("../local/traktSettingsStore.js");
const { SimklSyncService } = await import("./simklSyncService.js");

function saveAnimeEntry(ids) {
  const profileId = String(ProfileManager.getActiveProfileId() || "1");
  LocalStore.set("simklSyncState", {
    version: 1,
    profiles: {
      [profileId]: {
        schemaVersion: 3,
        entries: [
          {
            mediaType: "anime",
            status: "watching",
            anime: { title: "Anime", ids }
          }
        ]
      }
    }
  });
}

test("TVDB anime identity is preferred, with the existing IMDb fallback", async () => {
  storage.clear();
  TraktSettingsStore.setSimklAnimeIdPreference(SimklAnimeIdPreference.TVDB);

  saveAnimeEntry({ tvdb: 12345, imdb: "tt1234567" });
  assert.equal((await SimklSyncService.getLibraryEntries())[0].id, "tvdb:12345");

  saveAnimeEntry({ imdb: "tt1234567" });
  assert.equal((await SimklSyncService.getLibraryEntries())[0].id, "tt1234567");
});
