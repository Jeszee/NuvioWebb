// Every stable catalog identity carried by a watched/progress item.
//
// A tracking provider and the catalog are allowed to pick different primary
// IDs for the same title: SIMKL may call a show `mal:1234` while the addon that
// played it calls the same show `tt0903747`. Comparing only `contentId` treats
// those as two different titles, which is how one show ended up with two
// Continue Watching cards. Callers must compare these sets instead.
const ID_NAMESPACES = ["tmdb", "trakt", "tvdb", "mal", "anidb", "anilist", "kitsu", "simkl"];

function itemIds(item = {}) {
  return {
    ...(item.externalIds && typeof item.externalIds === "object" ? item.externalIds : {}),
    ...(item.external_ids && typeof item.external_ids === "object" ? item.external_ids : {}),
    ...(item.ids && typeof item.ids === "object" ? item.ids : {})
  };
}

// A missing id is often carried as 0 or "0" rather than absent. Left in, every
// such item would share the identity `tmdb:0` and collapse into a single card.
function isDegenerateIdentity(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /^0+$/.test(normalized)) {
    return true;
  }
  return ["null", "undefined", "nan"].includes(normalized.toLowerCase());
}

function addIdentityValue(set, value) {
  if (isDegenerateIdentity(value)) {
    return;
  }
  const normalized = String(value).trim();
  set.add(normalized);
  set.add(normalized.toLowerCase());
}

export function mergeWatchedItemIdentities(preferred = {}, supplemental = {}) {
  const preferredIds = itemIds(preferred);
  const supplementalIds = itemIds(supplemental);
  const ids = { ...supplementalIds, ...preferredIds };

  ID_NAMESPACES.forEach((namespace) => {
    const preferredValue =
      preferred[`${namespace}Id`] ?? preferred[`${namespace}_id`] ?? preferredIds[namespace];
    const supplementalValue =
      supplemental[`${namespace}Id`] ??
      supplemental[`${namespace}_id`] ??
      supplementalIds[namespace];
    if (!isDegenerateIdentity(preferredValue) && preferredValue != null) {
      ids[namespace] = preferredValue;
    } else if (!isDegenerateIdentity(supplementalValue) && supplementalValue != null) {
      ids[namespace] = supplementalValue;
    } else {
      delete ids[namespace];
    }
  });

  const preferredImdbId = preferred.imdbId ?? preferred.imdb_id ?? preferredIds.imdb;
  const supplementalImdbId = supplemental.imdbId ?? supplemental.imdb_id ?? supplementalIds.imdb;
  const imdbId =
    !isDegenerateIdentity(preferredImdbId) && preferredImdbId != null
      ? preferredImdbId
      : supplementalImdbId;
  if (imdbId != null && !isDegenerateIdentity(imdbId)) {
    ids.imdb = imdbId;
  } else {
    delete ids.imdb;
  }

  return {
    ...preferred,
    imdbId: imdbId != null && !isDegenerateIdentity(imdbId) ? imdbId : null,
    ids
  };
}

function addPrefixedIdentityValue(set, prefix, value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(new RegExp(`^${prefix}:`, "i"), "");
  if (isDegenerateIdentity(normalized)) {
    return;
  }
  addIdentityValue(set, `${prefix}:${normalized}`);
}

export function watchedItemIdentityValues(item = {}) {
  const values = new Set();
  const ids = itemIds(item);

  addIdentityValue(values, item.contentId);
  addIdentityValue(values, item.id);

  // IMDb ids are stored bare (`tt0903747`) across the catalog, trackers and
  // local playback rows, so they are the most common bridge between sources.
  const imdbId = String(item.imdbId ?? "")
    .trim()
    .replace(/^imdb:/i, "");
  addIdentityValue(values, imdbId || item.imdb_id || ids.imdb);

  ID_NAMESPACES.forEach((namespace) => {
    addPrefixedIdentityValue(
      values,
      namespace,
      item[`${namespace}Id`] ?? item[`${namespace}_id`] ?? ids[namespace]
    );
  });

  addIdentityValue(values, item.slug || ids.slug);
  return values;
}

export function watchedItemsShareIdentity(left = {}, right = {}) {
  const rightIdentities = watchedItemIdentityValues(right);
  return Array.from(watchedItemIdentityValues(left)).some((identity) =>
    rightIdentities.has(identity)
  );
}
