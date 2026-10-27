import { getEffectiveTmdbApiKey, TmdbSettingsStore } from "../../data/local/tmdbSettingsStore.js";
import {
  getEffectiveTvdbCredentials,
  TvdbSettingsStore
} from "../../data/local/tvdbSettingsStore.js";
import { TmdbMetadataService } from "../tmdb/tmdbMetadataService.js";
import { TvdbMetadataService } from "./tvdbMetadataService.js";

function isSeries(contentType) {
  return ["series", "tv", "show", "anime"].includes(String(contentType || "").toLowerCase());
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "") ?? null;
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  return value != null;
}

export function needsTvdbFallback(existing = {}, tmdb = null) {
  const fields = [
    [["name", "title"], "localizedTitle"],
    [["description", "overview"], "description"],
    [["poster", "thumbnail"], "poster"],
    [["genres"], "genres"],
    [["releaseInfo", "release_info"], "releaseInfo"],
    [["released", "releaseDate", "release_date"], "released"],
    [["runtime"], "runtime"],
    [["status"], "status"],
    [["country"], "country"]
  ];
  return fields.some(([existingKeys, enrichmentKey]) => {
    const existingValue = existingKeys.map((key) => existing?.[key]).find(hasValue);
    return !hasValue(existingValue) && !hasValue(tmdb?.[enrichmentKey]);
  });
}

function informativeEpisodeTitle(value) {
  const title = String(value || "").trim();
  return Boolean(
    title && !/^(?:episode|ep)\s*#?\s*\d+$/i.test(title) && !/^s\d+e\d+$/i.test(title)
  );
}

export function needsTvdbEpisodeFallback(video = {}, tmdbEpisode = null) {
  const existingTitle = video.title || video.name;
  const existingOverview = video.overview || video.description;
  const titleCovered =
    informativeEpisodeTitle(existingTitle) || informativeEpisodeTitle(tmdbEpisode?.title);
  const overviewCovered = hasValue(existingOverview) || hasValue(tmdbEpisode?.overview);
  return !titleCovered || !overviewCovered;
}

function metadataEntryKey(entry = {}, collection = "") {
  const id = String(entry.id || entry.tmdbId || entry.tvdbId || "").trim();
  const name = String(entry.name || "")
    .trim()
    .toLowerCase();
  const role =
    collection === "crew"
      ? String(entry.job || entry.department || "")
          .trim()
          .toLowerCase()
      : String(entry.character || entry.role || "")
          .trim()
          .toLowerCase();
  return id ? `${id}:${role}` : name ? `${name}:${role}` : "";
}

export function mergeMetadataLists(primary = [], supplemental = [], collection = "") {
  const merged = [];
  const indexes = new Map();
  for (const entry of [
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(supplemental) ? supplemental : [])
  ]) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const key = metadataEntryKey(entry, collection);
    if (!key || !indexes.has(key)) {
      if (key) indexes.set(key, merged.length);
      merged.push(entry);
      continue;
    }
    const index = indexes.get(key);
    const existing = merged[index];
    merged[index] = Object.fromEntries(
      Array.from(new Set([...Object.keys(entry), ...Object.keys(existing)]), (field) => [
        field,
        existing[field] || entry[field]
      ])
    );
  }
  return merged;
}

export function mergeMetadataCredits(primary = null, supplemental = null) {
  if (!primary || typeof primary !== "object") {
    return supplemental || null;
  }
  if (!supplemental || typeof supplemental !== "object") {
    return primary;
  }
  return {
    ...supplemental,
    ...primary,
    cast: mergeMetadataLists(primary.cast, supplemental.cast, "cast"),
    crew: mergeMetadataLists(primary.crew, supplemental.crew, "crew")
  };
}

export function mergeEpisodeEnrichment(
  video = {},
  { tvdbEpisode = null, tmdbEpisode = null, useReleaseDates = true } = {}
) {
  const originalTitle = video.title || video.name || "";
  const existingTitle = informativeEpisodeTitle(originalTitle) ? originalTitle : "";
  const title = existingTitle || tmdbEpisode?.title || tvdbEpisode?.title || originalTitle;
  const originalOverview = video.overview || video.description || "";
  const overview = originalOverview || tmdbEpisode?.overview || tvdbEpisode?.overview || "";
  const releaseDate = tmdbEpisode?.airDate || tvdbEpisode?.airDate;
  return {
    ...video,
    title,
    overview,
    ...(useReleaseDates && !video.released && releaseDate ? { released: releaseDate } : {}),
    thumbnail: video.thumbnail || tmdbEpisode?.thumbnail || tvdbEpisode?.thumbnail,
    runtime: video.runtime || tmdbEpisode?.runtime || tvdbEpisode?.runtime
  };
}

export function mergeTvdbAndTmdbEnrichment(tvdb = null, tmdb = null) {
  if (!tvdb) {
    return tmdb;
  }
  if (!tmdb) {
    return tvdb;
  }

  return {
    ...tvdb,
    ...tmdb,
    localizedTitle: firstValue(tmdb.localizedTitle, tvdb.localizedTitle),
    description: firstValue(tmdb.description, tvdb.description),
    poster: firstValue(tmdb.poster, tvdb.poster),
    backdrop: firstValue(tmdb.backdrop, tvdb.backdrop),
    logo: firstValue(tmdb.logo, tvdb.logo),
    genres: tmdb.genres?.length ? tmdb.genres : tvdb.genres,
    releaseInfo: firstValue(tmdb.releaseInfo, tvdb.releaseInfo),
    released: firstValue(tmdb.released, tvdb.released),
    runtime: firstValue(tmdb.runtime, tvdb.runtime),
    status: firstValue(tmdb.status, tvdb.status),
    country: firstValue(tmdb.country, tvdb.country),
    originalLanguage: firstValue(tmdb.originalLanguage, tvdb.originalLanguage),
    tvdbScore: tvdb.tvdbScore ?? null,
    rating: tmdb.rating ?? null,
    imdbId: firstValue(tmdb.imdbId),
    credits: tmdb.credits || null,
    companies: mergeMetadataLists(tmdb.companies, tvdb.companies),
    productionCompanies: mergeMetadataLists(tmdb.productionCompanies, tvdb.productionCompanies),
    networks: mergeMetadataLists(tmdb.networks, tvdb.networks),
    trailers: tmdb.trailers || [],
    trailerYtIds: tmdb.trailerYtIds || [],
    tvdbId: tvdb.tvdbId || tmdb.tvdbId || null,
    attributionUrl: tvdb.attributionUrl
  };
}

export const MetadataEnrichmentService = {
  async fetchEnrichment({
    tmdbId = null,
    tvdbId = null,
    contentType = "movie",
    language = null,
    existingMetadata = {}
  } = {}) {
    const typeIsSeries = isSeries(contentType);
    const tmdbSettings = TmdbSettingsStore.get();
    const tmdbEnabled = Boolean(tmdbSettings.enabled && getEffectiveTmdbApiKey() && tmdbId);
    const tvdbSettings = TvdbSettingsStore.get();
    const tvdbEnabled = Boolean(
      typeIsSeries && tvdbSettings.enabled && getEffectiveTvdbCredentials().apiKey
    );

    if (!tmdbEnabled && !tvdbEnabled) {
      return null;
    }

    let tmdb = null;
    if (tmdbEnabled) {
      try {
        tmdb = await TmdbMetadataService.fetchEnrichment({
          tmdbId,
          contentType,
          language: language || tmdbSettings.language
        });
      } catch (error) {
        console.warn("TMDB metadata enrichment failed", error?.code || error?.name || "unknown");
      }
    }

    let tvdb = null;
    const resolvedTvdbId = tvdbId || tmdb?.tvdbId;
    if (tvdbEnabled && resolvedTvdbId && needsTvdbFallback(existingMetadata, tmdb)) {
      try {
        tvdb = await TvdbMetadataService.fetchEnrichment({
          tvdbId: resolvedTvdbId,
          language: language || tmdbSettings.language
        });
      } catch (error) {
        console.warn("TVDB metadata enrichment failed", error?.code || error?.name || "unknown");
      }
    }

    return mergeTvdbAndTmdbEnrichment(tvdb, tmdb);
  },

  async fetchEpisodeEnrichment({
    tmdbId = null,
    seasonNumbers = [],
    tvdbEpisodeIds = [],
    episodeMetadata = [],
    language = null,
    originalLanguage = ""
  } = {}) {
    const tmdbSettings = TmdbSettingsStore.get();
    const tmdbRequest =
      tmdbSettings.enabled &&
      tmdbSettings.useEpisodes !== false &&
      getEffectiveTmdbApiKey() &&
      tmdbId
        ? TmdbMetadataService.fetchEpisodeEnrichment({
            tmdbId,
            seasonNumbers,
            language: language || tmdbSettings.language,
            originalLanguage
          }).catch((error) => {
            console.warn("TMDB episode enrichment failed", error?.code || error?.name || "unknown");
            return new Map();
          })
        : Promise.resolve(new Map());
    const tvdbSettings = TvdbSettingsStore.get();
    const candidates =
      Array.isArray(episodeMetadata) && episodeMetadata.length
        ? episodeMetadata
        : (Array.isArray(tvdbEpisodeIds) ? tvdbEpisodeIds : []).map((tvdbId) => ({ tvdbId }));
    const missingTvdbIds = candidates
      .filter((video) => needsTvdbEpisodeFallback(video))
      .map((video) => video.tvdbId)
      .filter(Boolean);
    const tvdbRequest =
      tvdbSettings.enabled && getEffectiveTvdbCredentials().apiKey && missingTvdbIds.length
        ? TvdbMetadataService.fetchEpisodeEnrichment({
            episodeIds: missingTvdbIds,
            language: language || tmdbSettings.language
          }).catch((error) => {
            console.warn("TVDB episode enrichment failed", error?.code || error?.name || "unknown");
            return new Map();
          })
        : Promise.resolve(new Map());
    const [tmdbEpisodes, tvdbEpisodes] = await Promise.all([tmdbRequest, tvdbRequest]);
    return { tmdbEpisodes, tvdbEpisodes };
  }
};
