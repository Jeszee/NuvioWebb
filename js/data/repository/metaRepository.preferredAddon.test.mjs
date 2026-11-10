import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear()
};

const { LayoutPreferences } = await import("../local/layoutPreferences.js");
const { addonRepository } = await import("./addonRepository.js");
const { metaRepository } = await import("./metaRepository.js");

test("preferred metadata add-on is tried by supported IDs before automatic matches", async (t) => {
  const preferredUrl = "https://xperience.example/manifest.json";
  const automaticUrl = "https://catalog.example/manifest.json";
  const originalGetInstalledAddons = addonRepository.getInstalledAddons;
  const originalGetMeta = metaRepository.getMeta;
  const calls = [];

  t.after(() => {
    addonRepository.getInstalledAddons = originalGetInstalledAddons;
    metaRepository.getMeta = originalGetMeta;
    metaRepository.clearCache();
    LayoutPreferences.set({ preferredMetadataAddonBaseUrl: "" });
  });

  storage.clear();
  metaRepository.clearCache();
  LayoutPreferences.set({ preferredMetadataAddonBaseUrl: preferredUrl });
  addonRepository.getInstalledAddons = async () => [
    {
      baseUrl: preferredUrl,
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tvdb:"] }]
    },
    {
      baseUrl: automaticUrl,
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tt"] }]
    }
  ];
  metaRepository.getMeta = async (baseUrl, type, id) => {
    calls.push({ baseUrl, type, id });
    if (baseUrl === preferredUrl && id === "tvdb:12345") {
      return { status: "success", data: { name: "Xperience metadata" } };
    }
    return { status: "error", message: "Meta not found" };
  };

  const result = await metaRepository.getMetaFromAllAddonsForIds("series", [
    "tt1234567",
    "tmdb:9876",
    "tvdb:12345"
  ]);

  assert.equal(result.data.name, "Xperience metadata");
  assert.deepEqual(calls, [{ baseUrl: preferredUrl, type: "series", id: "tvdb:12345" }]);
});

test("metadata lookup falls back to installed add-ons when the preferred one misses", async (t) => {
  const preferredUrl = "https://xperience.example/manifest.json";
  const automaticUrl = "https://catalog.example/manifest.json";
  const originalGetInstalledAddons = addonRepository.getInstalledAddons;
  const originalGetMeta = metaRepository.getMeta;
  const calls = [];

  t.after(() => {
    addonRepository.getInstalledAddons = originalGetInstalledAddons;
    metaRepository.getMeta = originalGetMeta;
    metaRepository.clearCache();
    LayoutPreferences.set({ preferredMetadataAddonBaseUrl: "" });
  });

  storage.clear();
  metaRepository.clearCache();
  LayoutPreferences.set({ preferredMetadataAddonBaseUrl: preferredUrl });
  addonRepository.getInstalledAddons = async () => [
    {
      baseUrl: preferredUrl,
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tvdb:"] }]
    },
    {
      baseUrl: automaticUrl,
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tt"] }]
    }
  ];
  metaRepository.getMeta = async (baseUrl, type, id) => {
    calls.push({ baseUrl, type, id });
    return baseUrl === automaticUrl
      ? { status: "success", data: { name: "Automatic metadata" } }
      : { status: "error", message: "Meta not found" };
  };

  const result = await metaRepository.getMetaFromAllAddonsForIds("series", [
    "tt1234567",
    "tvdb:12345"
  ]);

  assert.equal(result.data.name, "Automatic metadata");
  assert.deepEqual(calls, [
    { baseUrl: preferredUrl, type: "series", id: "tvdb:12345" },
    { baseUrl: automaticUrl, type: "series", id: "tt1234567" }
  ]);
});
