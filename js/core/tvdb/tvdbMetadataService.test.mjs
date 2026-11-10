import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const { TvdbSettingsStore } = await import("../../data/local/tvdbSettingsStore.js");
const { resolveTvdbEpisodeId, resolveTvdbSeriesId, TvdbMetadataService } =
  await import("./tvdbMetadataService.js");

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] || null },
    json: async () => data
  };
}

function authPayload(token = "test-token") {
  return { data: { token }, status: "success" };
}

function setup() {
  TvdbMetadataService.clearCache();
  TvdbSettingsStore.set({ enabled: true, apiKey: "test-api-key", pin: "" });
}

test("TVDB ids are only resolved from explicit namespaces or tvdb identity fields", () => {
  assert.equal(resolveTvdbSeriesId({ id: "tvdb:series:81189" }), "81189");
  assert.equal(resolveTvdbSeriesId({ ids: { tvdb: "81189" } }), "81189");
  assert.equal(resolveTvdbSeriesId({ external_ids: { tvdb_id: 81189 } }), "81189");
  assert.equal(resolveTvdbSeriesId({ id: "81189" }), "");
  assert.equal(resolveTvdbSeriesId({ id: "tvdb:episode:81189" }), "");
  assert.equal(resolveTvdbEpisodeId({ id: "tvdb:episode:12345" }), "12345");
  assert.equal(resolveTvdbEpisodeId({ id: "tvdb:series:12345" }), "");
  assert.equal(resolveTvdbEpisodeId({ id: "12345" }), "");
});

test("TVDB metadata selects requested-language text before English and original", async () => {
  setup();
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requested.push({ url, options });
    if (url.pathname.endsWith("/login")) {
      return response(authPayload());
    }
    if (url.pathname === "/v4/series/42/extended") {
      return response({
        data: {
          id: 42,
          name: "Original title",
          overview: "Original overview",
          image: "https://artworks.thetvdb.com/banners/poster.jpg",
          originalLanguage: "jpn",
          firstAired: "2020-03-01",
          averageRuntime: 24,
          score: 7.7,
          status: { name: "Ended" },
          genres: [{ name: "Animation" }]
        }
      });
    }
    if (url.pathname === "/v4/languages") {
      return response({
        data: [
          { id: "nld", shortCode: "nld", name: "Dutch", nativeName: "Nederlands" },
          { id: "eng", shortCode: "eng", name: "English", nativeName: "English" },
          { id: "jpn", shortCode: "jpn", name: "Japanese", nativeName: "日本語" }
        ]
      });
    }
    if (url.pathname.endsWith("/translations/nld")) {
      return response({ data: { name: "Nederlandse titel", overview: "" } });
    }
    if (url.pathname.endsWith("/translations/eng")) {
      return response({ data: { name: "English title", overview: "English overview" } });
    }
    if (url.pathname.endsWith("/translations/jpn")) {
      return response({ data: { name: "日本語タイトル", overview: "日本語の説明" } });
    }
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    const result = await TvdbMetadataService.fetchEnrichment({ tvdbId: "42", language: "nl-NL" });
    assert.equal(result.localizedTitle, "Nederlandse titel");
    assert.equal(result.description, "English overview");
    assert.equal(result.tvdbScore, 7.7);
    assert.equal(result.rating, undefined);
    assert.equal(result.originalLanguage, "jpn");
    assert.equal(result.poster, "https://artworks.thetvdb.com/banners/poster.jpg");
    assert.equal(result.runtime, "24 min");
    assert.equal(result.attributionUrl, "https://thetvdb.com");
    assert.ok(requested.every(({ url }) => !url.searchParams.has("apikey")));
    assert.deepEqual(JSON.parse(requested[0].options.body), { apikey: "test-api-key" });
    const calls = requested.length;
    await TvdbMetadataService.fetchEnrichment({ tvdbId: "42", language: "nl-NL" });
    assert.equal(requested.length, calls);
  } finally {
    globalThis.fetch = originalFetch;
    TvdbMetadataService.clearCache();
  }
});

test("TVDB metadata falls back to extended text when a language translation is missing", async () => {
  setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/login")) return response(authPayload());
    if (url.pathname === "/v4/series/42/extended") {
      return response({
        data: {
          id: 42,
          name: "TVDB series title",
          overview: "TVDB series overview",
          originalLanguage: "eng"
        }
      });
    }
    if (url.pathname === "/v4/languages") {
      return response({
        data: [
          { id: "nld", shortCode: "nld", name: "Dutch", nativeName: "Nederlands" },
          { id: "eng", shortCode: "eng", name: "English", nativeName: "English" }
        ]
      });
    }
    if (url.pathname.includes("/translations/")) return response({}, 404);
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    const result = await TvdbMetadataService.fetchEnrichment({ tvdbId: "42", language: "nl" });
    assert.equal(result.localizedTitle, "TVDB series title");
    assert.equal(result.description, "TVDB series overview");
  } finally {
    globalThis.fetch = originalFetch;
    TvdbMetadataService.clearCache();
  }
});

test("TVDB episode lookup requires an explicit episode ID and retains its own namespace", async () => {
  setup();
  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname.endsWith("/login")) return response(authPayload());
    if (url.pathname === "/v4/episodes/9001/extended") {
      return response({
        data: {
          id: 9001,
          name: "Episode",
          overview: "Episode overview",
          aired: "2021-01-02",
          image: "/banners/episode.jpg",
          runtime: 24,
          originalLanguage: "eng"
        }
      });
    }
    if (url.pathname === "/v4/languages") {
      return response({ data: [{ id: "eng", shortCode: "eng", name: "English" }] });
    }
    if (url.pathname.endsWith("/translations/eng")) {
      return response({ data: { name: "English episode", overview: "English summary" } });
    }
    throw new Error(`Unexpected TVDB request: ${url.pathname}`);
  };

  try {
    const result = await TvdbMetadataService.fetchEpisodeEnrichment({
      episodeIds: ["9001", "invalid"],
      language: "en"
    });
    assert.deepEqual(result.get("tvdb:9001"), {
      tvdbId: "9001",
      title: "English episode",
      overview: "English summary",
      airDate: "2021-01-02",
      thumbnail: "https://artworks.thetvdb.com/banners/episode.jpg",
      runtime: 24
    });
    assert.ok(requestedPaths.includes("/v4/episodes/9001/extended"));
    assert.ok(!requestedPaths.some((path) => path.includes("/episodes/invalid/")));
  } finally {
    globalThis.fetch = originalFetch;
    TvdbMetadataService.clearCache();
  }
});

test("TVDB validation includes the optional subscriber PIN only when supplied", async () => {
  const originalFetch = globalThis.fetch;
  let loginBody = null;
  globalThis.fetch = async (_input, options = {}) => {
    loginBody = JSON.parse(options.body);
    return response(authPayload());
  };
  try {
    assert.equal(await TvdbMetadataService.validateCredentials("key-only"), true);
    assert.deepEqual(loginBody, { apikey: "key-only" });
    assert.equal(await TvdbMetadataService.validateCredentials("subscriber-key", "1234"), true);
    assert.deepEqual(loginBody, { apikey: "subscriber-key", pin: "1234" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
