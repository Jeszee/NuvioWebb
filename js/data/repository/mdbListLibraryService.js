import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";
import { MdbListAccount } from "./mdbListAccount.js";

const STORE_KEY = "mdbListLibraries";
const CACHE_TTL_MS = 15 * 60 * 1000;
const WATCHLIST = {
  key: "mdblist:watchlist",
  title: "Watchlist",
  type: "watchlist",
  trackingProviderId: "mdblist",
  supportedContentTypes: ["movie", "series"]
};
let refreshInFlight = null;

function profileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function requireCurrentProfile(id) {
  if (profileId() !== String(id)) {
    throw Object.assign(new Error("mdblist_profile_changed"), { code: "mdblist_profile_changed" });
  }
}

function storedSnapshot(id = profileId()) {
  const cached = LocalStore.get(STORE_KEY, {})?.[id];
  return cached && Array.isArray(cached.tabs) && cached.items
    ? cached
    : { tabs: [WATCHLIST], items: {}, hidden: [], checkedAt: 0 };
}

function saveSnapshot(snapshot, id = profileId()) {
  const all = LocalStore.get(STORE_KEY, {});
  all[id] = snapshot;
  LocalStore.set(STORE_KEY, all);
  return snapshot;
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function mediaType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "movie") return "movie";
  if (["show", "series", "tv", "anime"].includes(type)) return "series";
  return null;
}

function listTab(row, category, userId) {
  if (
    !row ||
    (category === "liked" && Number(row.user_id) === Number(userId)) ||
    (["list", "dynamic"].includes(category) &&
      row.user_id != null &&
      Number(row.user_id) !== Number(userId))
  ) {
    return null;
  }
  const id =
    positiveId(row.id) ||
    (Array.isArray(row.ids) && row.ids.length === 1 ? positiveId(row.ids[0]) : null);
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!id || !name || (category === "list" && typeof row.private !== "boolean")) {
    throw new Error("MDBList returned an invalid list");
  }
  const isDynamic = row.dynamic === true || row.type === "dynamic";
  if (category === "list" && (row.type !== "static" || isDynamic)) return null;
  if (category === "dynamic" && !isDynamic) return null;
  const type = row.mediatype == null ? null : mediaType(row.mediatype);
  if (row.mediatype != null && !type) return null;
  return {
    key: `mdblist:${category}:${id}`,
    title: name,
    type: category === "list" ? "personal" : "external",
    isMembershipDestination: category === "list",
    supportedContentTypes: type ? [type] : ["movie", "series"],
    trackingProviderId: "mdblist",
    privacy: row.private ? "private" : "public",
    description: String(row.description || row.source || ""),
    updatedAt: row.last_updated_at || row.updated_at || row.updated || null
  };
}

function itemsPath(key) {
  if (key === WATCHLIST.key) return "/watchlist/items";
  const match = /^mdblist:(list|dynamic|external|liked):([1-9]\d*)$/.exec(key);
  if (!match) throw new Error("Invalid MDBList library key");
  return `/${match[1] === "external" ? "external/lists" : "lists"}/${match[2]}/items`;
}

function itemIds(row) {
  const ids = row?.ids || {};
  const imdb = String(ids.imdb || row?.imdb_id || "");
  const result = {};
  if (/^tt\d+$/.test(imdb)) result.imdb = imdb;
  for (const key of ["tmdb", "tvdb", "trakt"]) {
    const id = positiveId(ids[key] ?? row?.[`${key}_id`] ?? (key === "tmdb" ? row?.id : null));
    if (id) result[key] = id;
  }
  if (ids.mdblist != null && String(ids.mdblist).trim()) result.mdblist = String(ids.mdblist);
  return result;
}

function decodeItems(payload) {
  let rows;
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload?.items)) rows = payload.items;
  else if (payload && (Array.isArray(payload.movies) || Array.isArray(payload.shows))) {
    rows = [
      ...(payload.movies || []).map((item) => ({ ...item, mediatype: "movie" })),
      ...(payload.shows || []).map((item) => ({ ...item, mediatype: "series" }))
    ];
  } else {
    throw new Error("MDBList returned an invalid list response");
  }
  return rows.flatMap((row) => {
    if (["season", "episode"].includes(String(row?.mediatype || row?.type || "").toLowerCase())) {
      return [];
    }
    const type = mediaType(row?.mediatype || row?.type);
    const ids = itemIds(row);
    if (!type || Object.keys(ids).length === 0) return [];
    const id =
      ids.imdb ||
      (ids.tmdb
        ? `tmdb:${ids.tmdb}`
        : ids.tvdb
          ? `tvdb:${ids.tvdb}`
          : ids.trakt
            ? `trakt:${ids.trakt}`
            : ids.mdblist
              ? `mdblist:${ids.mdblist}`
              : null);
    if (!id) return [];
    const image = (value, size) => {
      if (!value) return null;
      if (String(value).startsWith("/")) return `https://image.tmdb.org/t/p/${size}${value}`;
      return /^https?:\/\//i.test(String(value)) ? String(value) : null;
    };
    return [
      {
        id,
        type,
        ids,
        name: String(row.title || row.name || id),
        poster: image(row.poster, "w500"),
        background: image(row.backdrop || row.background, "w1280"),
        description: String(row.description || row.overview || ""),
        genres: Array.isArray(row.genres)
          ? row.genres.map((genre) => String(genre?.name || genre?.slug || genre)).filter(Boolean)
          : [],
        year: row.release_year || row.year || null,
        imdbId: ids.imdb || null,
        tmdbId: ids.tmdb || null,
        traktId: ids.trakt || null,
        listedAt: Date.parse(row.listed_at || row.added_at || row.watchlist_at || "") || 0
      }
    ];
  });
}

async function fetchAllPages(id, key) {
  const all = new Map();
  const visited = new Set();
  let offset = 0;
  let cursor = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const query = {
      limit: 1000,
      unified: true,
      append_to_response: "poster,description,genres",
      ...(cursor ? { cursor } : { offset })
    };
    const requestKey = JSON.stringify(query);
    if (visited.has(requestKey)) throw new Error("MDBList returned repeated pagination data");
    visited.add(requestKey);
    const { payload, headers } = await MdbListAccount.api(itemsPath(key), {
      profileId: id,
      query
    });
    const rows = decodeItems(payload);
    rows.forEach((row) => {
      const key = `${row.type}:${row.id}`;
      if (!all.has(key)) all.set(key, row);
    });
    const pagination = payload?.pagination || payload || {};
    const total = Number(pagination.total);
    const pageOffset = Number(pagination.offset ?? offset);
    const rawLimit = pagination.limit;
    const limit = rawLimit == null ? 1000 : Number(rawLimit);
    const nextOffset = pageOffset + limit;
    const hasMore =
      pagination.has_more != null
        ? pagination.has_more === true
        : (Number.isFinite(total) && total > 0 && nextOffset < total) ||
          String(headers?.get("X-Has-More")).toLowerCase() === "true";
    const nextCursor = pagination.next_cursor || headers?.get("X-Next-Cursor");
    if (nextCursor) cursor = String(nextCursor);
    else cursor = null;
    if (!hasMore) return [...all.values()];
    if (
      !cursor &&
      (!Number.isSafeInteger(pageOffset) ||
        pageOffset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        nextOffset <= offset)
    ) {
      throw new Error("MDBList returned invalid pagination data");
    }
    if (!cursor) offset = nextOffset;
  }
  throw new Error("MDBList list exceeded the supported number of pages");
}

async function fetchTabs(id, userId) {
  const { payload } = await MdbListAccount.api("/lists/user", {
    profileId: id,
    query: { unified: false, sort: "ranked" }
  });
  if (!Array.isArray(payload)) throw new Error("MDBList returned invalid user lists");
  const tabs = payload
    .map((row) =>
      listTab(row, row?.dynamic === true || row?.type === "dynamic" ? "dynamic" : "list", userId)
    )
    .filter(Boolean);
  const external = await MdbListAccount.api("/external/lists/user", { profileId: id });
  if (!Array.isArray(external.payload)) throw new Error("MDBList returned invalid external lists");
  tabs.push(...external.payload.map((row) => listTab(row, "external", userId)).filter(Boolean));
  const likedTabs = new Map();
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const { payload, headers } = await MdbListAccount.api("/lists/liked", {
      profileId: id,
      query: { limit: 100, offset }
    });
    if (!Array.isArray(payload?.lists)) throw new Error("MDBList returned invalid liked lists");
    payload.lists
      .map((row) => listTab(row, "liked", userId))
      .filter(Boolean)
      .forEach((tab) => likedTabs.set(tab.key, tab));
    const pagination = payload.pagination || payload;
    const total = Number(pagination.total);
    const pageOffset = Number(pagination.offset ?? offset);
    const rawLimit = pagination.limit;
    const limit = rawLimit == null ? 100 : Number(rawLimit);
    const nextOffset = pageOffset + limit;
    const hasMore =
      pagination.has_more != null
        ? pagination.has_more === true
        : (Number.isFinite(total) && total > 0 && nextOffset < total) ||
          String(headers?.get("X-Has-More")).toLowerCase() === "true";
    if (!hasMore) break;
    if (
      !Number.isSafeInteger(pageOffset) ||
      pageOffset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      nextOffset <= offset
    ) {
      throw new Error("MDBList returned invalid liked-list pagination data");
    }
    offset = nextOffset;
    if (page === 99) throw new Error("MDBList liked lists exceeded the supported number of pages");
  }
  tabs.push(...likedTabs.values());
  const unique = new Map();
  tabs.forEach((tab) => unique.set(tab.key, tab));
  return [WATCHLIST, ...unique.values()];
}

async function synchronize(id, force = false) {
  const { payload: user } = await MdbListAccount.api("/user", { profileId: id });
  const userId = positiveId(user?.id);
  if (!userId) throw new Error("MDBList returned an invalid account");
  const previous = storedSnapshot(id);
  const tabs = await fetchTabs(id, userId);
  const items = { [WATCHLIST.key]: await fetchAllPages(id, WATCHLIST.key) };
  for (const tab of tabs) {
    if (tab.key === WATCHLIST.key) continue;
    const cachedTab = previous.tabs.find((entry) => entry.key === tab.key);
    if (
      !force &&
      tab.updatedAt &&
      cachedTab?.updatedAt === tab.updatedAt &&
      Array.isArray(previous.items[tab.key])
    ) {
      items[tab.key] = previous.items[tab.key];
    } else {
      items[tab.key] = await fetchAllPages(id, tab.key);
    }
  }
  const snapshot = { tabs, items, hidden: [], checkedAt: Date.now() };
  return saveSnapshot(snapshot, id);
}

function toLibraryEntries(snapshot) {
  const aliases = new Map();
  for (const [listKey, items] of Object.entries(snapshot.items || {})) {
    if (snapshot.hidden?.includes(listKey)) continue;
    for (const item of items) {
      const keys = Object.entries(item.ids || {}).map(([key, id]) => `${item.type}:${key}:${id}`);
      const matches = [...new Set(keys.map((key) => aliases.get(key)).filter(Boolean))];
      const group = matches[0] || { ids: {}, items: [] };
      for (const other of matches.slice(1)) {
        group.items.push(...other.items);
        Object.assign(group.ids, other.ids);
        for (const key of Object.entries(other.ids).map(
          ([name, id]) => `${item.type}:${name}:${id}`
        )) {
          aliases.set(key, group);
        }
      }
      group.items.push(item);
      Object.assign(group.ids, item.ids || {});
      keys.forEach((key) => aliases.set(key, group));
    }
  }

  const entries = new Map();
  for (const [listKey, items] of Object.entries(snapshot.items || {})) {
    if (snapshot.hidden?.includes(listKey)) continue;
    items.forEach((item, rank) => {
      const firstId = Object.entries(item.ids || {})[0];
      if (!firstId) return;
      const group = aliases.get(`${item.type}:${firstId[0]}:${firstId[1]}`);
      if (!group) return;
      const ids = group.ids;
      const id =
        ids.imdb ||
        (ids.tmdb
          ? `tmdb:${ids.tmdb}`
          : ids.tvdb
            ? `tvdb:${ids.tvdb}`
            : ids.trakt
              ? `trakt:${ids.trakt}`
              : `mdblist:${ids.mdblist}`);
      const key = `${item.type}:${id}`;
      const current = entries.get(key);
      entries.set(key, {
        ...item,
        id,
        ids,
        imdbId: ids.imdb || null,
        tmdbId: ids.tmdb || null,
        traktId: ids.trakt || null,
        name: group.items.find((row) => row.name && row.name !== row.id)?.name || item.name,
        poster: group.items.find((row) => row.poster)?.poster || null,
        background: group.items.find((row) => row.background)?.background || null,
        description: current?.description || item.description || "",
        genres: [...new Set([...(current?.genres || []), ...(item.genres || [])])],
        type: item.type,
        trackingProviderId: "mdblist",
        releaseInfo: String(item.year || ""),
        listKeys: [...new Set([...(current?.listKeys || []), listKey])],
        listedAt: Math.max(current?.listedAt || 0, item.listedAt || 0),
        listMeta: {
          ...current?.listMeta,
          [listKey]: { listedAt: item.listedAt || 0, traktRank: rank }
        },
        traktRank: rank
      });
    });
  }
  return [...entries.values()];
}

function requestIds(item) {
  const ids = { ...(item?.ids || {}) };
  const candidate = item?.itemId || item?.id || item?.contentId || "";
  const prefixed = String(candidate).match(/^(imdb|tmdb|tvdb|trakt|mdblist):(.+)$/);
  if (prefixed && !ids[prefixed[1]]) {
    ids[prefixed[1]] =
      prefixed[1] === "imdb" || prefixed[1] === "mdblist" ? prefixed[2] : Number(prefixed[2]);
  }
  const clean = Object.fromEntries(
    Object.entries(ids).filter(([, value]) => value != null && value !== "")
  );
  return clean;
}

function matchItem(row, input) {
  const ids = requestIds(input);
  return (
    row.type === (mediaType(input.itemType || input.type) || row.type) &&
    Object.entries(ids).some(([key, value]) => String(row.ids[key] || "") === String(value))
  );
}

async function refresh({ force = false, profileId: id = profileId() } = {}) {
  requireCurrentProfile(id);
  if (!MdbListAccount.isAuthenticated(id)) return false;
  const current = storedSnapshot(id);
  if (!force && current.checkedAt && Date.now() - current.checkedAt < CACHE_TTL_MS) return false;
  if (refreshInFlight?.profileId === id) return refreshInFlight.promise;
  const promise = synchronize(id, force)
    .then(() => true)
    .finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    });
  refreshInFlight = { profileId: id, promise };
  return promise;
}

export const MdbListLibraryService = {
  async snapshot(options) {
    const id = profileId();
    await refresh({ ...options, profileId: id });
    requireCurrentProfile(id);
    return storedSnapshot(id);
  },

  async getTabs(options) {
    return (await this.snapshot(options)).tabs;
  },

  async getEntries(options) {
    return toLibraryEntries(await this.snapshot(options));
  },

  async getMembershipSnapshot(item) {
    const snapshot = await this.snapshot();
    return {
      listMembership: Object.fromEntries(
        snapshot.tabs.map((tab) => [
          tab.key,
          (snapshot.items[tab.key] || []).some((row) => matchItem(row, item))
        ])
      )
    };
  },

  async applyMembershipChanges(item, changes) {
    const id = profileId();
    const snapshot = await this.snapshot();
    requireCurrentProfile(id);
    const ids = requestIds(item);
    const type = mediaType(item.itemType || item.type);
    if (!type || !Object.keys(ids).length) throw new Error("MDBList item identifiers are required");
    const bucket = type === "movie" ? "movies" : "shows";
    for (const [key, desired] of Object.entries(changes?.desiredMembership || {})) {
      const tab = snapshot.tabs.find((entry) => entry.key === key);
      if (!tab || tab.isMembershipDestination !== true) continue;
      const rows = snapshot.items[key] || [];
      const exists = rows.some((row) => matchItem(row, item));
      if (exists === Boolean(desired)) continue;
      const path = `${itemsPath(key)}/${desired ? "add" : "remove"}`;
      const { payload } = await MdbListAccount.api(path, {
        profileId: id,
        method: "POST",
        body: { [bucket]: [key === WATCHLIST.key ? { ids } : ids] }
      });
      requireCurrentProfile(id);
      const rawCount = (name) =>
        typeof payload?.[name] === "object" ? payload[name]?.[bucket] : payload?.[name];
      const count = (name) => Number(rawCount(name) ?? 0);
      const changedKey = desired ? "added" : "removed";
      if (
        rawCount(changedKey) == null ||
        ![changedKey, desired ? "existing" : "not_found", "not_found"].every(
          (name) => Number.isSafeInteger(count(name)) && count(name) >= 0
        ) ||
        count(changedKey) + count(desired ? "existing" : "not_found") !== 1 ||
        (desired && count("not_found") !== 0)
      ) {
        throw new Error("MDBList did not apply the requested list change");
      }
      if (desired) rows.push({ ...item, ids, type, listedAt: Date.now() });
      else snapshot.items[key] = rows.filter((row) => !matchItem(row, item));
    }
    saveSnapshot({ ...snapshot, checkedAt: Date.now() }, id);
  },

  async createPersonalList(name, description, privacy) {
    const profile = profileId();
    const listName = String(name || "").trim();
    const isPrivate = normalizePrivacy(privacy) === "private";
    if (!listName || String(description || "").trim()) {
      throw new Error("MDBList lists require a name and do not support descriptions");
    }
    const { payload } = await MdbListAccount.api("/lists/user/add", {
      profileId: profile,
      method: "POST",
      body: { name: listName, private: isPrivate }
    });
    requireCurrentProfile(profile);
    const id = positiveId(payload?.id);
    if (!id) throw new Error("MDBList returned an invalid list");
    const key = `mdblist:list:${id}`;
    const snapshot = storedSnapshot(profile);
    snapshot.tabs.push({
      key,
      title: String(payload.name || listName).trim(),
      type: "personal",
      privacy: isPrivate ? "private" : "public",
      description: "",
      isMembershipDestination: true,
      supportedContentTypes: ["movie", "series"],
      trackingProviderId: "mdblist"
    });
    snapshot.items[key] = [];
    saveSnapshot(snapshot, profile);
    return key;
  },

  async updatePersonalList(listId, name, description, privacy) {
    const profile = profileId();
    const snapshot = storedSnapshot(profile);
    requireCurrentProfile(profile);
    const listName = String(name || "").trim();
    const isPrivate = normalizePrivacy(privacy) === "private";
    if (!listName || String(description || "").trim()) {
      throw new Error("MDBList lists require a name and do not support descriptions");
    }
    const key = personalListKey(listId, snapshot);
    const id = key.slice("mdblist:list:".length);
    const { payload } = await MdbListAccount.api(`/lists/${encodeURIComponent(id)}`, {
      profileId: profile,
      method: "PUT",
      body: { name: listName, private: isPrivate }
    });
    requireCurrentProfile(profile);
    if (payload?.success !== true && !payload?.name) {
      throw new Error("MDBList did not update the list");
    }
    snapshot.tabs = snapshot.tabs.map((tab) =>
      tab.key === key
        ? {
            ...tab,
            title: String(payload.name || listName).trim(),
            description: "",
            privacy: isPrivate ? "private" : "public"
          }
        : tab
    );
    saveSnapshot(snapshot, profile);
  },

  async deletePersonalList(listId) {
    const profile = profileId();
    const snapshot = storedSnapshot(profile);
    requireCurrentProfile(profile);
    const key = personalListKey(listId, snapshot);
    const id = key.slice("mdblist:list:".length);
    const { payload, status } = await MdbListAccount.api(`/lists/${encodeURIComponent(id)}`, {
      profileId: profile,
      method: "DELETE"
    });
    requireCurrentProfile(profile);
    if (status !== 204 && payload?.success !== true)
      throw new Error("MDBList did not delete the list");
    snapshot.tabs = snapshot.tabs.filter((tab) => tab.key !== key);
    delete snapshot.items[key];
    saveSnapshot(snapshot, profile);
  },

  async reorderPersonalLists(orderedKeys) {
    const snapshot = storedSnapshot();
    const rank = new Map(orderedKeys.map((key, index) => [String(key), index]));
    const personalLists = snapshot.tabs
      .filter((tab) => tab.isMembershipDestination)
      .sort((left, right) => (rank.get(left.key) ?? Infinity) - (rank.get(right.key) ?? Infinity));
    let index = 0;
    snapshot.tabs = snapshot.tabs.map((tab) =>
      tab.isMembershipDestination ? personalLists[index++] : tab
    );
    saveSnapshot(snapshot);
  },

  async refreshNow() {
    return refresh({ force: true });
  },

  clearCurrentProfile() {
    const all = LocalStore.get(STORE_KEY, {});
    delete all[profileId()];
    LocalStore.set(STORE_KEY, all);
  }
};

function personalListKey(listId, snapshot) {
  const value = String(listId);
  const key = value.startsWith("mdblist:list:") ? value : `mdblist:list:${value}`;
  if (
    !/^mdblist:list:[1-9]\d*$/.test(key) ||
    !snapshot.tabs.some((tab) => tab.key === key && tab.type === "personal")
  ) {
    throw new Error("MDBList personal list was not found");
  }
  return key;
}

function normalizePrivacy(privacy) {
  const value = String(privacy || "private").toLowerCase();
  if (value !== "private" && value !== "public") {
    throw new Error("MDBList lists support only private or public visibility");
  }
  return value;
}
