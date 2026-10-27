import {
  hasWatchProgressStarted,
  isWatchProgressCompleted,
  isWatchProgressInProgress
} from "../../domain/model/watchProgress.js";
import { mergeWatchedItemIdentities, watchedItemIdentityValues } from "./watchedIdentity.js";

export function isSeriesType(type) {
  const normalized = String(type || "").toLowerCase();
  return normalized === "series" || normalized === "tv";
}

export function shouldTreatAsInProgressForContinueWatching(item = {}) {
  if (isWatchProgressInProgress(item)) {
    return true;
  }
  if (isWatchProgressCompleted(item)) {
    return false;
  }
  return hasWatchProgressStarted(item);
}

/**
 * Collapses a merged progress list down to one card per title.
 *
 * Continue Watching combines local playback rows with the selected tracker's
 * own records, and the two sides are free to identify the same title
 * differently: SIMKL may return `mal:1234` where the addon that played it used
 * `tt0903747`. Matching on identity sets rather than the raw contentId is what
 * keeps those from becoming two cards.
 *
 * Films and series are deduplicated separately so a movie can never collapse
 * into a show that happens to share an id in some provider's namespace.
 */
export function deduplicateContinueWatchingItems(items = []) {
  const groups = [];
  const identityGroups = {
    movie: new Map(),
    series: new Map()
  };

  (Array.isArray(items) ? items : [])
    .slice()
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .forEach((item) => {
      const isSeries = isSeriesType(item?.contentType);
      const byIdentity = identityGroups[isSeries ? "series" : "movie"];
      const identities = watchedItemIdentityValues(item);
      if (!identities.size) {
        return;
      }

      const matchingGroups = new Set(
        Array.from(identities)
          .map((identity) => byIdentity.get(identity))
          .filter(Boolean)
      );
      let group;
      if (matchingGroups.size) {
        group = Array.from(matchingGroups).sort(
          (left, right) => Number(right.item.updatedAt || 0) - Number(left.item.updatedAt || 0)
        )[0];
        group.item = mergeWatchedItemIdentities(group.item, item);
        matchingGroups.forEach((matchingGroup) => {
          if (matchingGroup === group) {
            return;
          }
          group.item = mergeWatchedItemIdentities(group.item, matchingGroup.item);
          matchingGroup.identities.forEach((identity) => {
            group.identities.add(identity);
          });
          const index = groups.indexOf(matchingGroup);
          if (index >= 0) {
            groups.splice(index, 1);
          }
        });
      } else {
        group = {
          item,
          identities: new Set()
        };
        groups.push(group);
      }

      identities.forEach((identity) => group.identities.add(identity));
      group.identities.forEach((identity) => byIdentity.set(identity, group));
    });

  return groups
    .filter(({ item }) => shouldTreatAsInProgressForContinueWatching(item))
    .map(({ item }) => item)
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}
