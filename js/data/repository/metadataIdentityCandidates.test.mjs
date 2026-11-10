import assert from "node:assert/strict";
import test from "node:test";
import { metadataIdentityCandidatesForItem } from "./metadataIdentityCandidates.js";

test("metadata identity lookup prefers metadata IDs over a selected Simkl TVDB identity", () => {
  assert.deepEqual(
    metadataIdentityCandidatesForItem({
      contentId: "tvdb:12345",
      imdbId: "tt1234567",
      tmdbId: 9876,
      ids: { imdb: "tt1234567", tmdb: 9876, tvdb: 12345, mal: 54321 }
    }),
    ["tt1234567", "tmdb:9876", "9876", "tvdb:12345", "12345", "mal:54321", "54321"]
  );
});

test("metadata identity lookup retains alternate and canonical ID fallbacks", () => {
  assert.deepEqual(
    metadataIdentityCandidatesForItem({ contentId: "mal:123", ids: { mal: 123, kitsu: 456 } }, [
      "tt9876543"
    ]),
    ["mal:123", "123", "kitsu:456", "456", "tt9876543"]
  );
});
