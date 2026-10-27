const METADATA_ID_KEYS = ["tmdb", "tvdb", "mal", "anidb", "anilist", "kitsu", "simkl"];

function addCandidate(candidates, seen, value) {
  const normalized = String(value || "").trim();
  if (!normalized || seen.has(normalized.toLowerCase())) {
    return;
  }
  seen.add(normalized.toLowerCase());
  candidates.push(normalized);
}

export function metadataIdentityCandidatesForItem(item = {}, fallbacks = []) {
  const candidates = [];
  const seen = new Set();
  const ids = item.ids && typeof item.ids === "object" ? item.ids : {};

  addCandidate(candidates, seen, item.imdbId || ids.imdb);
  addCandidate(candidates, seen, ids.imdb);

  const tmdbId = item.tmdbId ?? ids.tmdb;
  if (tmdbId != null && tmdbId !== "") {
    addCandidate(candidates, seen, `tmdb:${tmdbId}`);
    addCandidate(candidates, seen, tmdbId);
  }

  METADATA_ID_KEYS.slice(1).forEach((key) => {
    const value = ids[key] ?? item[`${key}Id`];
    if (value == null || value === "") {
      return;
    }
    addCandidate(candidates, seen, `${key}:${value}`);
    addCandidate(candidates, seen, value);
  });

  (Array.isArray(fallbacks) ? fallbacks : [fallbacks]).forEach((value) => {
    addCandidate(candidates, seen, value);
  });
  addCandidate(candidates, seen, item.contentId || item.id);

  return candidates;
}
