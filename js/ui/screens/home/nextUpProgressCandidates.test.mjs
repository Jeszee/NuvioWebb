import assert from "node:assert/strict";
import test from "node:test";

const { deduplicateNextUpProgressCandidates } = await import("./nextUpProgressCandidates.js");

function furthestEpisode(existing, incoming) {
  return Number(incoming.episode || 0) > Number(existing.episode || 0);
}

test("Next Up aliases collapse to one candidate and retain the furthest episode", () => {
  const candidates = [
    { contentType: "series", contentId: "tvdb:81189", season: 1, episode: 4, updatedAt: 20 },
    {
      contentType: "series",
      contentId: "mal:1234",
      ids: { tvdb: "81189", imdb: "tt0903747" },
      season: 1,
      episode: 7,
      updatedAt: 10
    }
  ];

  const result = deduplicateNextUpProgressCandidates(candidates, [], furthestEpisode);
  assert.equal(result.length, 1);
  assert.equal(result[0].contentId, "mal:1234");
  assert.equal(result[0].episode, 7);
  assert.equal(result[0].ids.tvdb, "81189");
});

test("a current progress item suppresses a Next Up seed through shared aliases", () => {
  const result = deduplicateNextUpProgressCandidates(
    [{ contentType: "series", contentId: "tvdb:81189", season: 1, episode: 7 }],
    [{ contentType: "series", contentId: "mal:1234", ids: { tvdb: "81189" } }],
    furthestEpisode
  );
  assert.deepEqual(result, []);
});
