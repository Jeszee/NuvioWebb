import {
  mergeWatchedItemIdentities,
  watchedItemIdentityValues
} from "../../../data/repository/watchedIdentity.js";

export function deduplicateNextUpProgressCandidates(
  candidates = [],
  inProgressItems = [],
  shouldReplace = () => false
) {
  const inProgressIdentities = new Set(
    (Array.isArray(inProgressItems) ? inProgressItems : []).flatMap((item) =>
      Array.from(watchedItemIdentityValues(item))
    )
  );
  const groups = [];
  const identityGroups = new Map();

  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    const identities = watchedItemIdentityValues(candidate);
    if (!identities.size || Array.from(identities).some((id) => inProgressIdentities.has(id))) {
      return;
    }

    const matchingGroups = new Set(
      Array.from(identities)
        .map((identity) => identityGroups.get(identity))
        .filter(Boolean)
    );
    let group;
    if (!matchingGroups.size) {
      group = { item: candidate, identities: new Set() };
      groups.push(group);
    } else {
      const matched = Array.from(matchingGroups);
      group = matched[0];
      matched.slice(1).forEach((other) => {
        group.item = mergeWatchedItemIdentities(group.item, other.item);
        other.identities.forEach((identity) => group.identities.add(identity));
        const index = groups.indexOf(other);
        if (index >= 0) {
          groups.splice(index, 1);
        }
      });
      const winner = shouldReplace(group.item, candidate) ? candidate : group.item;
      const other = winner === candidate ? group.item : candidate;
      group.item = mergeWatchedItemIdentities(winner, other);
    }

    identities.forEach((identity) => group.identities.add(identity));
    group.identities.forEach((identity) => identityGroups.set(identity, group));
  });

  return groups.map(({ item }) => item);
}
