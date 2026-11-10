// Identifies the metadata provider settings a cached Continue Watching entry
// was built under, so different provider results do not share stale entries.
//
// Entries live for two weeks and nothing invalidated them when the settings
// changed, so turning "Enrich Continue Watching" on appeared to do nothing:
// every item was already cached, and the staleness test only asked whether
// anything was *missing* -- an item that already carried artwork from its addon
// counted as finished, so TMDB was never consulted for it.
//
// Only the settings that actually reach Continue Watching enrichment belong
// here. Including the rest (credits, productions, trailers, collections...)
// would re-enrich every item whenever an unrelated toggle moved.
export function continueWatchingEnrichmentSignatureFor(
  settings = {},
  hasApiKey = false,
  preferredMetadataAddon = "",
  tvdbSettings = {},
  hasTvdbApiKey = false
) {
  const addonKey = String(preferredMetadataAddon || "").trim();
  const tmdbActive = Boolean(settings.enabled && settings.enrichContinueWatching && hasApiKey);
  const tvdbActive = Boolean(tvdbSettings.enabled && hasTvdbApiKey);
  if (!tmdbActive && !tvdbActive) {
    return addonKey ? `tmdb:off:addon:${addonKey}` : "tmdb:off";
  }
  if (tvdbActive && !tmdbActive) {
    return ["tvdb:v1:on", `addon:${addonKey}`].join(":");
  }
  const signature = [
    "tmdb:v2:on",
    `addon:${addonKey}`,
    settings.language || "",
    settings.useArtwork !== false ? "art" : "-",
    settings.useBasicInfo !== false ? "basic" : "-",
    settings.useDetails !== false ? "details" : "-",
    settings.useReleaseDates !== false ? "dates" : "-",
    settings.useEpisodes !== false ? "eps" : "-"
  ].join(":");
  return tvdbActive ? `${signature}:tvdb:v1:on` : signature;
}
