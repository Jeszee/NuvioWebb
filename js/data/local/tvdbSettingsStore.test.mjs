import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const { TvdbSettingsStore } = await import("./tvdbSettingsStore.js");

test("TVDB credentials and enablement are profile-scoped", () => {
  TvdbSettingsStore.setForProfile(
    "1",
    { enabled: true, apiKey: "profile-one-key", pin: "1111" },
    { silentCredentialSync: true, silentSync: true }
  );
  TvdbSettingsStore.setForProfile(
    "2",
    { enabled: true, apiKey: "profile-two-key", pin: "2222" },
    { silentCredentialSync: true, silentSync: true }
  );

  assert.deepEqual(TvdbSettingsStore.getForProfile("1"), {
    enabled: true,
    apiKey: "profile-one-key",
    pin: "1111"
  });
  assert.deepEqual(TvdbSettingsStore.getForProfile("2"), {
    enabled: true,
    apiKey: "profile-two-key",
    pin: "2222"
  });
});

test("TVDB credentials are normalized and an unset profile is disabled", () => {
  TvdbSettingsStore.setForProfile(
    "1",
    { enabled: 1, apiKey: " key ", pin: " 1234 " },
    { silentCredentialSync: true, silentSync: true }
  );
  assert.deepEqual(TvdbSettingsStore.getForProfile("1"), {
    enabled: true,
    apiKey: "key",
    pin: "1234"
  });
  assert.deepEqual(TvdbSettingsStore.getForProfile("3"), {
    enabled: false,
    apiKey: "",
    pin: ""
  });
});
