import { createProfileScopedStore } from "./profileScopedStore.js";

const KEY = "tvdbSettings";

function normalizeTvdbSettings(value = {}) {
  return {
    enabled: Boolean(value?.enabled),
    apiKey: String(value?.apiKey || "").trim(),
    pin: String(value?.pin || "").trim()
  };
}

const store = createProfileScopedStore({
  key: KEY,
  normalize: normalizeTvdbSettings,
  seedFromPrimary: false
});

function queueProviderCredentialPush(profileId) {
  void import("../../core/profile/providerCredentialSyncService.js")
    .then(({ ProviderCredentialSyncService }) => ProviderCredentialSyncService.queuePush(profileId))
    .catch((error) => console.warn("TVDB credential sync enqueue failed", error));
}

function queueIfCredentialChanged(profileId, previous, next, options = {}) {
  if (
    !options.silentCredentialSync &&
    (String(previous?.apiKey || "") !== String(next?.apiKey || "") ||
      String(previous?.pin || "") !== String(next?.pin || ""))
  ) {
    queueProviderCredentialPush(profileId);
  }
}

export const TvdbSettingsStore = {
  getForProfile(profileId) {
    return store.getForProfile(profileId);
  },

  get() {
    return store.get();
  },

  replaceForProfile(profileId, nextValue, options = {}) {
    const previous = store.getForProfile(profileId);
    const saved = store.replaceForProfile(profileId, nextValue, options);
    queueIfCredentialChanged(profileId, previous, saved, options);
    return saved;
  },

  setForProfile(profileId, partial, options = {}) {
    const previous = store.getForProfile(profileId);
    const saved = store.setForProfile(profileId, partial, options);
    queueIfCredentialChanged(profileId, previous, saved, options);
    return saved;
  },

  set(partial, options = {}) {
    return this.setForProfile(options.profileId, partial, options);
  }
};

export function getEffectiveTvdbCredentials() {
  const settings = TvdbSettingsStore.get();
  return {
    apiKey: String(settings.apiKey || "").trim(),
    pin: String(settings.pin || "").trim()
  };
}
