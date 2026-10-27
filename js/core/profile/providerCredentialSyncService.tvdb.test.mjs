import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const { buildProviderCredentialSnapshot, mergeProviderCredentialRows, providerCredentialParams } =
  await import("./providerCredentialSyncService.js");

test("TVDB API key and PIN use the profile-scoped provider credential sync", () => {
  const snapshot = buildProviderCredentialSnapshot(2, {
    tvdbSettings: { apiKey: "tvdb-key", pin: "4321" }
  });
  const tvdb = snapshot.values.find((entry) => entry.provider === "tvdb");
  assert.deepEqual(tvdb, {
    provider: "tvdb",
    field: "api_key",
    value: "tvdb-key",
    pin: "4321"
  });
  const params = providerCredentialParams(snapshot, "test-client");
  const remotePayload = params.p_credentials.find((entry) => entry.provider === "tvdb");
  assert.deepEqual(remotePayload, {
    provider: "tvdb",
    credential_json: { api_key: "tvdb-key", pin: "4321" }
  });

  const merged = mergeProviderCredentialRows(snapshot, [
    { provider: "tvdb", credential_json: { api_key: "remote-key", pin: "9876" } }
  ]);
  assert.deepEqual(
    merged.values.find((entry) => entry.provider === "tvdb"),
    {
      provider: "tvdb",
      field: "api_key",
      value: "remote-key",
      pin: "9876"
    }
  );
});
