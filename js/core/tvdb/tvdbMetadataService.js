import { ProfileManager } from "../profile/profileManager.js";
import {
  getEffectiveTvdbCredentials,
  TvdbSettingsStore
} from "../../data/local/tvdbSettingsStore.js";

const API_BASE_URL = "https://api4.thetvdb.com/v4";
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;
const STATIC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 29 * 24 * 60 * 60 * 1000;
const cache = new Map();
const inFlight = new Map();
const tokens = new Map();
let cooldownUntil = 0;

function tvdbError(code, status = 0, retryAfterMs = 0) {
  return Object.assign(new Error(code), { code, status, retryAfterMs });
}

function profileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function positiveId(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) && Number(normalized) > 0 ? normalized : "";
}

function namespacedId(value, entityType) {
  const match = String(value || "")
    .trim()
    .match(/^tvdb:(?:(series|episode):)?(\d+)$/i);
  if (!match || (match[1] && match[1].toLowerCase() !== entityType)) {
    return "";
  }
  return positiveId(match[2]);
}

export function resolveTvdbSeriesId(item = {}) {
  const ids = item?.ids && typeof item.ids === "object" ? item.ids : {};
  const externalIds =
    item?.externalIds && typeof item.externalIds === "object"
      ? item.externalIds
      : item?.external_ids && typeof item.external_ids === "object"
        ? item.external_ids
        : {};
  return (
    positiveId(
      ids.tvdb ?? item.tvdbId ?? item.tvdb_id ?? externalIds.tvdb ?? externalIds.tvdb_id
    ) ||
    namespacedId(item.id, "series") ||
    namespacedId(item.contentId, "series")
  );
}

export function resolveTvdbEpisodeId(episode = {}) {
  const ids = episode?.ids && typeof episode.ids === "object" ? episode.ids : {};
  const externalIds =
    episode?.externalIds && typeof episode.externalIds === "object"
      ? episode.externalIds
      : episode?.external_ids && typeof episode.external_ids === "object"
        ? episode.external_ids
        : {};
  return (
    positiveId(
      ids.tvdb ?? episode.tvdbId ?? episode.tvdb_id ?? externalIds.tvdb ?? externalIds.tvdb_id
    ) ||
    namespacedId(episode.id, "episode") ||
    namespacedId(episode.contentId, "episode")
  );
}

function cached(cacheKey) {
  const entry = cache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt > Date.now()) {
    return entry.value;
  }
  cache.delete(cacheKey);
  return undefined;
}

function cacheValue(cacheKey, value, ttlMs = METADATA_CACHE_TTL_MS) {
  cache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function fetchJson(path, { method = "GET", body = null, token = "", retryAuth = true } = {}) {
  if (!/^\/(?!\/)[^#]*$/.test(path)) {
    throw tvdbError("tvdb_invalid_request");
  }
  if (Date.now() < cooldownUntil) {
    throw tvdbError("tvdb_rate_limited", 429, cooldownUntil - Date.now());
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      redirect: "error",
      ...(controller ? { signal: controller.signal } : {}),
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (cause) {
    if (cause?.name === "AbortError") {
      throw tvdbError("tvdb_timeout");
    }
    throw Object.assign(tvdbError("tvdb_connection_failed"), { cause });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }

  if (response.status === 401 && retryAuth) {
    tokens.delete(profileId());
    const refreshedToken = await getAccessToken(true);
    return fetchJson(path, { method, body, token: refreshedToken, retryAuth: false });
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers?.get?.("Retry-After") || 0);
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60000;
    cooldownUntil = Date.now() + retryAfterMs;
    throw tvdbError("tvdb_rate_limited", 429, retryAfterMs);
  }
  if (!response.ok) {
    throw tvdbError(
      response.status === 401 ? "tvdb_unauthorized" : "tvdb_request_failed",
      response.status
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw Object.assign(tvdbError("tvdb_invalid_response", response.status), { cause });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw tvdbError("tvdb_invalid_response", response.status);
  }
  return payload;
}

async function getAccessToken(force = false) {
  const credentials = getEffectiveTvdbCredentials();
  if (!credentials.apiKey) {
    throw tvdbError("tvdb_credentials_missing");
  }
  const key = profileId();
  const prior = tokens.get(key);
  if (
    !force &&
    prior?.apiKey === credentials.apiKey &&
    prior?.pin === credentials.pin &&
    prior.expiresAt > Date.now()
  ) {
    return prior.token;
  }

  const payload = await fetchJson("/login", {
    method: "POST",
    body: {
      apikey: credentials.apiKey,
      ...(credentials.pin ? { pin: credentials.pin } : {})
    },
    retryAuth: false
  });
  const token = String(payload?.data?.token || "").trim();
  if (!token) {
    throw tvdbError("tvdb_invalid_response");
  }
  tokens.set(key, {
    apiKey: credentials.apiKey,
    pin: credentials.pin,
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  return token;
}

async function request(path, { ttlMs = METADATA_CACHE_TTL_MS } = {}) {
  const cacheKey = `${profileId()}:${path}`;
  const value = cached(cacheKey);
  if (value !== undefined) {
    return value;
  }
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const pending = (async () => {
    const token = await getAccessToken();
    const payload = await fetchJson(path, { token });
    if (!Object.prototype.hasOwnProperty.call(payload, "data")) {
      throw tvdbError("tvdb_invalid_response");
    }
    return cacheValue(cacheKey, payload.data, ttlMs);
  })();
  inFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function languages() {
  const records = await request("/languages", { ttlMs: STATIC_CACHE_TTL_MS });
  if (!Array.isArray(records)) {
    throw tvdbError("tvdb_invalid_response");
  }
  return records;
}

function tvdbLanguageId(languagesList, language) {
  const base = String(language || "")
    .trim()
    .replace(/_/g, "-")
    .split("-")[0]
    .toLowerCase();
  if (!base) {
    return "";
  }
  const directMatch = languagesList.find(
    (entry) =>
      String(entry?.shortCode || "")
        .toLowerCase()
        .split("-")[0] === base ||
      String(entry?.id || "")
        .toLowerCase()
        .split("-")[0] === base
  );
  if (directMatch?.id) {
    return String(directMatch.id).trim();
  }
  if (typeof Intl.DisplayNames === "function") {
    const displayName = new Intl.DisplayNames(["en"], { type: "language" })
      .of(base)
      .toLocaleLowerCase();
    const namedMatch = languagesList.find((entry) =>
      [entry?.name, entry?.nativeName]
        .map((value) =>
          String(value || "")
            .trim()
            .toLocaleLowerCase()
        )
        .includes(displayName)
    );
    if (namedMatch?.id) {
      return String(namedMatch.id).trim();
    }
  }
  return "";
}

async function translationsFor(entity, id, languagesList, languageCodes) {
  const ids = [
    ...new Set(languageCodes.map((code) => tvdbLanguageId(languagesList, code)).filter(Boolean))
  ];
  const results = await Promise.all(
    ids.map(async (languageId) => {
      try {
        const data = await request(
          `/${entity}/${encodeURIComponent(id)}/translations/${encodeURIComponent(languageId)}`
        );
        return [languageId, data];
      } catch (error) {
        if (error?.status === 404) {
          return [languageId, {}];
        }
        throw error;
      }
    })
  );
  return new Map(results);
}

function firstText(...values) {
  return values.map((value) => String(value || "").trim()).find(Boolean) || "";
}

function normalizeImage(value) {
  const image = String(value || "").trim();
  if (/^https?:\/\//i.test(image)) {
    return image;
  }
  return image.startsWith("/") ? `https://artworks.thetvdb.com${image}` : null;
}

function translationForLanguage(translations, languagesList, language) {
  const id = tvdbLanguageId(languagesList, language);
  return (id && translations.get(id)) || {};
}

async function localizedRecord(entity, id, record, language) {
  const languageList = await languages();
  const preferred = String(language || "en").trim();
  const original = String(record?.originalLanguage || "").trim();
  const translationMap = await translationsFor(entity, id, languageList, [
    preferred,
    "en",
    original
  ]);
  const preferredTranslation = translationForLanguage(translationMap, languageList, preferred);
  const englishTranslation = translationForLanguage(translationMap, languageList, "en");
  const originalTranslation = translationForLanguage(translationMap, languageList, original);
  return {
    localizedTitle:
      firstText(
        preferredTranslation.name,
        englishTranslation.name,
        originalTranslation.name,
        record?.name
      ) || null,
    description:
      firstText(
        preferredTranslation.overview,
        englishTranslation.overview,
        originalTranslation.overview,
        record?.overview
      ) || null
  };
}

function normalizedSeries(record, localized, id) {
  const runtime = Number(record?.averageRuntime || 0);
  const rating = Number(record?.score);
  return {
    tvdbId: id,
    localizedTitle: localized.localizedTitle,
    description: localized.description,
    poster: normalizeImage(record?.image),
    backdrop: null,
    logo: null,
    genres: Array.isArray(record?.genres)
      ? record.genres.map((genre) => String(genre?.name || "").trim()).filter(Boolean)
      : [],
    releaseInfo: firstText(record?.year, String(record?.firstAired || "").slice(0, 4)) || null,
    released: String(record?.firstAired || "").trim() || null,
    runtime: Number.isFinite(runtime) && runtime > 0 ? `${runtime} min` : null,
    status: String(record?.status?.name || "").trim() || null,
    country: String(record?.country || "").trim() || null,
    originalLanguage: String(record?.originalLanguage || "").trim() || null,
    tvdbScore: Number.isFinite(rating) ? rating : null,
    attributionUrl: "https://thetvdb.com"
  };
}

function normalizedEpisode(record, localized, id) {
  const runtime = Number(record?.runtime || 0);
  return {
    tvdbId: id,
    title: localized.localizedTitle,
    overview: localized.description,
    airDate: String(record?.aired || "").trim(),
    thumbnail: normalizeImage(record?.image),
    runtime: Number.isFinite(runtime) && runtime > 0 ? runtime : null
  };
}

export const TvdbMetadataService = {
  async validateCredentials(apiKey, pin = "") {
    const normalizedKey = String(apiKey || "").trim();
    const normalizedPin = String(pin || "").trim();
    if (!normalizedKey) {
      return false;
    }
    const payload = await fetchJson("/login", {
      method: "POST",
      body: {
        apikey: normalizedKey,
        ...(normalizedPin ? { pin: normalizedPin } : {})
      },
      retryAuth: false
    });
    return Boolean(String(payload?.data?.token || "").trim());
  },

  async fetchEnrichment({ tvdbId, language = "en" } = {}) {
    const settings = TvdbSettingsStore.get();
    const id = positiveId(tvdbId);
    if (!settings.enabled || !getEffectiveTvdbCredentials().apiKey || !id) {
      return null;
    }
    const record = await request(`/series/${encodeURIComponent(id)}/extended?meta=translations`);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw tvdbError("tvdb_invalid_response");
    }
    const localized = await localizedRecord("series", id, record, language);
    return normalizedSeries(record, localized, id);
  },

  async fetchEpisodeEnrichment({ episodeIds = [], language = "en" } = {}) {
    const settings = TvdbSettingsStore.get();
    if (!settings.enabled || !getEffectiveTvdbCredentials().apiKey) {
      return new Map();
    }
    const ids = [
      ...new Set((Array.isArray(episodeIds) ? episodeIds : []).map(positiveId).filter(Boolean))
    ].slice(0, 10);
    if (!ids.length) {
      return new Map();
    }
    const entries = await Promise.all(
      ids.map(async (id) => {
        const record = await request(
          `/episodes/${encodeURIComponent(id)}/extended?meta=translations`
        );
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          throw tvdbError("tvdb_invalid_response");
        }
        const localized = await localizedRecord("episodes", id, record, language);
        return [`tvdb:${id}`, normalizedEpisode(record, localized, id)];
      })
    );
    return new Map(entries);
  },

  clearCache() {
    cache.clear();
    inFlight.clear();
    tokens.clear();
    cooldownUntil = 0;
  },

  clearMetadataCache() {
    cache.clear();
  }
};
