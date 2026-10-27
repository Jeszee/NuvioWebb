import assert from "node:assert/strict";
import test from "node:test";

const {
  mergeEpisodeEnrichment,
  mergeMetadataCredits,
  mergeMetadataLists,
  mergeTvdbAndTmdbEnrichment,
  needsTvdbEpisodeFallback,
  needsTvdbFallback
} = await import("./metadataEnrichmentService.js");

test("TMDB metadata wins over TVDB enrichment when both provide values", () => {
  const merged = mergeTvdbAndTmdbEnrichment(
    {
      localizedTitle: "TVDB title",
      description: "",
      poster: "https://tvdb/poster.jpg",
      genres: ["Animation"],
      tvdbScore: 7.8,
      attributionUrl: "https://thetvdb.com"
    },
    {
      localizedTitle: "TMDB title",
      description: "TMDB overview",
      poster: "https://tmdb/poster.jpg",
      backdrop: "https://tmdb/backdrop.jpg",
      genres: ["Drama"],
      rating: 8.1,
      originalLanguage: "ja",
      imdbId: "tt1234567"
    }
  );

  assert.equal(merged.localizedTitle, "TMDB title");
  assert.equal(merged.description, "TMDB overview");
  assert.equal(merged.poster, "https://tmdb/poster.jpg");
  assert.equal(merged.backdrop, "https://tmdb/backdrop.jpg");
  assert.deepEqual(merged.genres, ["Drama"]);
  assert.equal(merged.rating, 8.1);
  assert.equal(merged.tvdbScore, 7.8);
  assert.equal(merged.originalLanguage, "ja");
  assert.equal(merged.imdbId, "tt1234567");
});

test("TVDB only fills fields not supplied by existing metadata or TMDB", () => {
  const merged = mergeTvdbAndTmdbEnrichment(
    {
      localizedTitle: "TVDB title",
      description: "TVDB overview",
      poster: "https://tvdb/poster.jpg",
      genres: ["Animation"],
      status: "Ended"
    },
    {
      localizedTitle: "TMDB title",
      description: "",
      poster: null,
      genres: [],
      status: ""
    }
  );
  assert.equal(merged.localizedTitle, "TMDB title");
  assert.equal(merged.description, "TVDB overview");
  assert.equal(merged.poster, "https://tvdb/poster.jpg");
  assert.deepEqual(merged.genres, ["Animation"]);
  assert.equal(merged.status, "Ended");
});

test("TVDB requests are unnecessary when existing metadata and TMDB cover its fields", () => {
  assert.equal(
    needsTvdbFallback(
      {
        name: "Series",
        description: "Overview",
        poster: "poster.jpg",
        genres: ["Drama"],
        releaseInfo: "2020",
        released: "2020-01-01",
        runtime: "42 min",
        status: "Ended",
        country: "US"
      },
      null
    ),
    false
  );
  assert.equal(needsTvdbFallback({ name: "Series" }, { localizedTitle: "TMDB title" }), true);
});

test("TMDB production and network data survive TVDB enrichment when TVDB has none", () => {
  const merged = mergeTvdbAndTmdbEnrichment(
    { localizedTitle: "TVDB title" },
    {
      companies: [{ id: 1, name: "Studio" }],
      productionCompanies: [{ id: 1, name: "Studio" }],
      networks: [{ id: 2, name: "Network" }]
    }
  );

  assert.deepEqual(merged.companies, [{ id: 1, name: "Studio" }]);
  assert.deepEqual(merged.productionCompanies, [{ id: 1, name: "Studio" }]);
  assert.deepEqual(merged.networks, [{ id: 2, name: "Network" }]);
});

test("episode titles fall through from TVDB to TMDB when TVDB has no localized title", () => {
  const merged = mergeEpisodeEnrichment(
    { id: "series:1:2", title: "Episode 2", overview: "" },
    {
      tvdbEpisode: { title: "", overview: "", airDate: "", thumbnail: null },
      tmdbEpisode: { title: "Localized episode", overview: "TMDB overview" },
      tvdbEnabled: true
    }
  );

  assert.equal(merged.title, "Localized episode");
  assert.equal(merged.overview, "TMDB overview");
});

test("existing episode titles and descriptions are not overwritten by TVDB", () => {
  const merged = mergeEpisodeEnrichment(
    { id: "series:1:2", title: "Addon episode", overview: "Addon overview" },
    {
      tvdbEpisode: { title: "TVDB episode", overview: "TVDB overview" },
      tmdbEpisode: { title: "TMDB episode", overview: "TMDB overview" }
    }
  );

  assert.equal(merged.title, "Addon episode");
  assert.equal(merged.overview, "Addon overview");
});

test("complete existing or TMDB episode metadata skips TVDB fallback requests", () => {
  assert.equal(
    needsTvdbEpisodeFallback({ title: "Addon title", overview: "Addon overview" }),
    false
  );
  assert.equal(
    needsTvdbEpisodeFallback(
      { title: "Episode 2", overview: "" },
      { title: "TMDB title", overview: "TMDB overview" }
    ),
    false
  );
  assert.equal(needsTvdbEpisodeFallback({ title: "Episode 2", overview: "" }), true);
});

test("credit arrays merge instead of replacing existing metadata with partial enrichment", () => {
  const merged = mergeMetadataCredits(
    { cast: [{ id: 1, name: "Existing actor" }], crew: [{ id: 4, name: "Existing writer" }] },
    { cast: [{ id: 2, name: "Enriched actor" }], crew: [] }
  );

  assert.deepEqual(
    merged.cast.map((entry) => entry.name),
    ["Existing actor", "Enriched actor"]
  );
  assert.deepEqual(
    merged.crew.map((entry) => entry.name),
    ["Existing writer"]
  );
});

test("existing companies and networks remain when enrichment only returns partial data", () => {
  const merged = mergeMetadataLists(
    [{ id: 1, name: "Existing studio" }],
    [{ id: 2, name: "Enriched studio" }]
  );

  assert.deepEqual(
    merged.map((entry) => entry.name),
    ["Existing studio", "Enriched studio"]
  );
});
