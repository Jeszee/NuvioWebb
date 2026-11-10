import assert from "node:assert/strict";
import test from "node:test";
import { containsJapaneseScript, localizedCatalogTitle } from "./catalogTitleLocalization.js";

test("detects Japanese kana in catalog titles", () => {
  assert.equal(containsJapaneseScript("進撃の巨人"), true);
  assert.equal(containsJapaneseScript("Shingeki no Kyojin"), false);
});

test("uses a non-Japanese metadata title only when the catalog title needs localization", () => {
  assert.equal(localizedCatalogTitle("進撃の巨人", "Attack on Titan"), "Attack on Titan");
  assert.equal(localizedCatalogTitle("Attack on Titan", "Attack on Titan"), "");
  assert.equal(localizedCatalogTitle("進撃の巨人", "しんげきのきょじん"), "");
  assert.equal(localizedCatalogTitle("進撃の巨人", ""), "");
});
