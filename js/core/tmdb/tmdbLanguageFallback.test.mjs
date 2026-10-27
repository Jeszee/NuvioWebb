import assert from "node:assert/strict";
import test from "node:test";

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => (values.has(key) ? values.get(key) : null),
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
  clear: () => values.clear()
};

const { TmdbSettingsStore } = await import("../../data/local/tmdbSettingsStore.js");
const { TmdbMetadataService } = await import("./tmdbMetadataService.js");

function response(data, ok = true) {
  return { ok, json: async () => data };
}

function translation(language, region, name, overview) {
  return {
    iso_639_1: language,
    iso_3166_1: region,
    data: { name, overview }
  };
}

function seriesResponse(translations, posters = []) {
  return {
    original_language: "ja",
    name: "日本語タイトル",
    overview: "日本語の説明",
    images: {
      posters,
      logos: [],
      backdrops: []
    },
    translations: { translations }
  };
}

test("TMDB text uses configured language, then English, then original language", async () => {
  TmdbSettingsStore.set({ enabled: true, apiKey: "test-key", language: "nl" });
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    if (url.pathname.endsWith("/images")) {
      return response({
        posters: [{ file_path: "/japanese.jpg", iso_639_1: "ja", vote_average: 8 }],
        logos: [],
        backdrops: []
      });
    }
    return response(
      seriesResponse(
        [
          translation("nl", "NL", "Nederlandse titel", "Nederlandse omschrijving"),
          translation("en", "US", "English title", "English overview"),
          translation("ja", "JP", "日本語タイトル", "日本語の説明")
        ],
        [
          { file_path: "/english.jpg", iso_639_1: "en", vote_average: 5 },
          { file_path: "/japanese.jpg", iso_639_1: "ja", vote_average: 9 }
        ]
      )
    );
  };
  try {
    const dutch = await TmdbMetadataService.fetchEnrichment({
      tmdbId: 42,
      contentType: "series"
    });
    assert.equal(dutch.localizedTitle, "Nederlandse titel");
    assert.equal(dutch.description, "Nederlandse omschrijving");
    assert.equal(dutch.poster, "https://image.tmdb.org/t/p/w342/english.jpg");

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      requestedUrls.push(url);
      if (url.pathname.endsWith("/images")) {
        return response({
          posters: [{ file_path: "/japanese.jpg", iso_639_1: "ja", vote_average: 8 }],
          logos: [],
          backdrops: []
        });
      }
      return response(
        seriesResponse([
          translation("en", "US", "English title", "English overview"),
          translation("ja", "JP", "日本語タイトル", "日本語の説明")
        ])
      );
    };
    const englishFallback = await TmdbMetadataService.fetchEnrichment({
      tmdbId: 42,
      contentType: "series"
    });
    assert.equal(englishFallback.localizedTitle, "English title");
    assert.equal(englishFallback.description, "English overview");
    assert.equal(englishFallback.poster, "https://image.tmdb.org/t/p/w342/japanese.jpg");
    assert.ok(
      requestedUrls.some(
        (url) => url.pathname.endsWith("/images") && url.searchParams.has("include_image_language")
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("episode metadata falls through untranslated preferred results to English", async () => {
  TmdbSettingsStore.set({ enabled: true, apiKey: "test-key", language: "nl" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const language = new URL(String(input)).searchParams.get("language");
    const episodeName =
      language === "en-US"
        ? "English episode title"
        : language === "ja"
          ? "日本語エピソード"
          : "日本語エピソード";
    return response({
      episodes: [
        {
          episode_number: 1,
          name: episodeName,
          overview: episodeName
        }
      ]
    });
  };
  try {
    const episodes = await TmdbMetadataService.fetchEpisodeEnrichment({
      tmdbId: 42,
      seasonNumbers: [1],
      language: "nl",
      originalLanguage: "ja"
    });
    assert.equal(episodes.get("1:1").title, "English episode title");
    assert.equal(episodes.get("1:1").overview, "English episode title");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("episode ratings are fetched directly from TMDB and grouped by season", async () => {
  TmdbSettingsStore.set({ enabled: true, apiKey: "test-key", language: "nl" });
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    return response({
      episodes: [
        { episode_number: 1, vote_average: 8.246 },
        { episode_number: 2, vote_average: 0 },
        { episode_number: 0, vote_average: 9 }
      ]
    });
  };
  try {
    const ratings = await TmdbMetadataService.fetchEpisodeRatings({
      tmdbId: 42,
      seasonNumbers: [1, 1, 0, -1]
    });
    assert.deepEqual(ratings, {
      1: [{ episode: 1, rating: 8.2, source: "tmdb" }]
    });
    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0].searchParams.get("language"), "en-US");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
