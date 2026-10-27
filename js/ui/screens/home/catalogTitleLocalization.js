export function containsJapaneseScript(value) {
  return /[\u3040-\u30ff]/u.test(String(value || ""));
}

export function localizedCatalogTitle(currentTitle, candidateTitle) {
  const current = String(currentTitle || "").trim();
  const candidate = String(candidateTitle || "").trim();
  if (!current || !candidate || containsJapaneseScript(candidate)) {
    return "";
  }
  return containsJapaneseScript(current) ? candidate : "";
}
