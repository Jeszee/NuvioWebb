import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => (values.has(key) ? values.get(key) : null),
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
  clear: () => values.clear()
};

const { TmdbService } = await import("./tmdbService.js");
const { TmdbSettingsStore } = await import("../../data/local/tmdbSettingsStore.js");

test("TMDB IDs and supported external IDs resolve without mixing namespaces", async () => {
  TmdbSettingsStore.set({ enabled: true, apiKey: "test-key" });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    requestedUrls.push(new URL(String(input)));
    return {
      ok: true,
      json: async () => ({
        movie_results: [{ id: 901 }],
        tv_results: [{ id: 902 }]
      })
    };
  };
  try {
    assert.equal(await TmdbService.ensureTmdbId("tvdb:123"), null);
    assert.equal(await TmdbService.ensureTmdbId("tvdb:123", "series"), "902");
    assert.equal(await TmdbService.ensureTmdbId("mal:456"), null);
    assert.equal(await TmdbService.ensureTmdbId("simkl:789"), null);
    assert.equal(fetchCount, 1);
    assert.equal(requestedUrls[0].searchParams.get("external_source"), "tvdb_id");

    assert.equal(await TmdbService.ensureTmdbId("tmdb:123"), "123");
    assert.equal(await TmdbService.ensureTmdbId("movie:456"), "456");
    assert.equal(await TmdbService.ensureTmdbId("series:789", "series"), "789");
    assert.equal(await TmdbService.ensureTmdbId("123"), "123");
    assert.equal(await TmdbService.ensureTmdbId("tt1234567"), "901");
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
