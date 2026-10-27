import { MDBLIST_API_BASE_URL, MDBLIST_CLIENT_ID } from "../../config.js";
import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";

const STORE_KEY = "mdbListAccounts";
const LIBRARY_KEY = "mdbListLibraries";
const RATE_LIMIT_MS = 60 * 1000;
const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 45 * 1000;
const API_BASE_URL = String(MDBLIST_API_BASE_URL || "https://api.mdblist.com/").replace(/\/+$/, "");
const API_PROXY_PATH = "/api/mdblist";

let requestQueue = Promise.resolve();
let nextRequestAt = 0;
let cooldownUntil = 0;
const refreshInFlight = new Map();
const deviceAuthGeneration = new Map();

function profileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function accountFor(id = profileId()) {
  return LocalStore.get(STORE_KEY, {})?.[String(id)] || {};
}

function saveAccount(id, account) {
  const all = LocalStore.get(STORE_KEY, {});
  all[String(id)] = account;
  LocalStore.set(STORE_KEY, all);
  return account;
}

function clearLibrary(id) {
  const libraries = LocalStore.get(LIBRARY_KEY, {});
  delete libraries[String(id)];
  LocalStore.set(LIBRARY_KEY, libraries);
}

function error(code, status = 0) {
  const message =
    code === "mdblist_connection_failed"
      ? "Could not connect to MDBList. Check your connection and try again."
      : code === "mdblist_rate_limited"
        ? "MDBList rate limit reached. Please wait before trying again."
        : code === "mdblist_invalid_response"
          ? "MDBList returned an invalid response."
          : code;
  return Object.assign(new Error(message), { code, status });
}

function apiUrl(path, query = {}) {
  if (!/^\/(?!\/)[^?#]*$/.test(path)) throw error("mdblist_invalid_response");
  const browserLocation = globalThis.location;
  const useBrowserProxy = Boolean(
    browserLocation?.origin && /^https?:$/.test(browserLocation.protocol)
  );
  const url = useBrowserProxy
    ? new URL(`${API_PROXY_PATH}${path}`, browserLocation.origin)
    : new URL(path, `${API_BASE_URL}/`);
  if (
    !useBrowserProxy &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw error("mdblist_invalid_response");
  }
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url;
}

async function request(
  path,
  { method = "GET", query = {}, form = null, body = null, accessToken = null } = {}
) {
  const run = async () => {
    if (Date.now() < cooldownUntil) {
      throw Object.assign(error("mdblist_rate_limited", 429), {
        retryAfterMs: cooldownUntil - Date.now()
      });
    }
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const headers = { Accept: "application/json" };
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (body != null) headers["Content-Type"] = "application/json";
    const url = apiUrl(path, query).href;
    let response;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: "error",
        ...(controller ? { signal: controller.signal } : {}),
        ...(form
          ? { body: new URLSearchParams(form).toString() }
          : body != null
            ? { body: JSON.stringify(body) }
            : {})
      });
    } catch (cause) {
      if (timeout) clearTimeout(timeout);
      nextRequestAt = Date.now() + REQUEST_GAP_MS;
      throw Object.assign(error("mdblist_connection_failed"), { cause });
    }
    try {
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const delay = /^\d+$/.test(retryAfter || "") ? Number(retryAfter) * 1000 : RATE_LIMIT_MS;
        cooldownUntil = Date.now() + Math.max(delay, 1000);
        throw Object.assign(error("mdblist_rate_limited", 429), {
          retryAfterMs: cooldownUntil - Date.now()
        });
      }
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          if (response.ok) throw error("mdblist_invalid_response");
        }
      }
      return { status: response.status, payload, headers: response.headers };
    } catch (cause) {
      if (cause?.code) throw cause;
      throw Object.assign(error("mdblist_connection_failed"), { cause });
    } finally {
      if (timeout) clearTimeout(timeout);
      nextRequestAt = Date.now() + REQUEST_GAP_MS;
    }
  };
  const task = requestQueue.then(run, run);
  requestQueue = task.catch(() => {});
  return task;
}

function requireCurrentProfile(id) {
  if (profileId() !== String(id)) throw error("mdblist_profile_changed");
}

function validateTokens(payload, priorRefreshToken = null) {
  const expiresIn = Number(payload?.expires_in);
  const accessToken = String(payload?.access_token || "");
  const refreshToken = String(payload?.refresh_token || priorRefreshToken || "");
  if (
    !accessToken ||
    !refreshToken ||
    String(payload?.token_type || "").toLowerCase() !== "bearer" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw error("mdblist_invalid_response");
  }
  if (payload?.scope != null && !String(payload.scope).split(/\s+/).includes("write")) {
    throw error("mdblist_insufficient_scope");
  }
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

function trustedVerificationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" && url.hostname === "mdblist.com") return url.href;
  } catch {
    // The provider response is rejected below.
  }
  throw error("mdblist_invalid_response");
}

export const MdbListAccount = {
  isConfigured() {
    return Boolean(MDBLIST_CLIENT_ID);
  },

  isAuthenticated(id = profileId()) {
    return Boolean(accountFor(id).tokens?.refreshToken);
  },

  getCurrentAuthState(id = profileId()) {
    const account = accountFor(id);
    return {
      username: account.user?.name || null,
      userCode: account.device?.userCode || null,
      verificationUrl: account.device?.verificationUrl || null,
      expiresAt: account.device?.expiresAt || null,
      pollInterval: account.device?.pollInterval || 5
    };
  },

  async startDeviceAuth() {
    if (!MDBLIST_CLIENT_ID) throw error("mdblist_missing_client");
    const id = profileId();
    this.cancelDeviceAuth();
    const generation = deviceAuthGeneration.get(id);
    const { status, payload } = await request("/oauth/device-authorization/", {
      method: "POST",
      form: { client_id: MDBLIST_CLIENT_ID, scope: "write" }
    });
    requireCurrentProfile(id);
    if (status < 200 || status >= 300) throw error("mdblist_unavailable", status);
    if (deviceAuthGeneration.get(id) !== generation) return { type: "invalidated" };
    const interval = Number(payload?.interval);
    const expiresIn = Number(payload?.expires_in);
    const userCode = String(payload?.user_code || "");
    const deviceCode = String(payload?.device_code || "");
    const verificationUrl = trustedVerificationUrl(payload?.verification_uri);
    if (
      !deviceCode ||
      !userCode ||
      !Number.isInteger(interval) ||
      interval < 1 ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw error("mdblist_invalid_response");
    }
    const device = {
      deviceCode,
      userCode,
      verificationUrl,
      pollInterval: interval,
      nextPollAt: Date.now() + interval * 1000,
      expiresAt: Date.now() + expiresIn * 1000
    };
    saveAccount(id, { ...accountFor(id), device });
    return this.getCurrentAuthState(id);
  },

  async pollDeviceAuth() {
    const id = profileId();
    const device = accountFor(id).device;
    if (!device?.deviceCode) return { type: "invalidated" };
    if (Date.now() >= device.expiresAt) {
      saveAccount(id, { ...accountFor(id), device: null });
      return { type: "expired" };
    }
    if (Date.now() < device.nextPollAt) return { type: "pending" };
    device.nextPollAt = Date.now() + device.pollInterval * 1000;
    saveAccount(id, { ...accountFor(id), device });
    const generation = deviceAuthGeneration.get(id) || 0;
    const { status, payload } = await request("/oauth/token/", {
      method: "POST",
      form: {
        client_id: MDBLIST_CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        scope: "write"
      }
    });
    requireCurrentProfile(id);
    if (
      deviceAuthGeneration.get(id) !== generation ||
      accountFor(id).device?.deviceCode !== device.deviceCode
    ) {
      return { type: "invalidated" };
    }
    if (status >= 200 && status < 300) {
      const tokens = validateTokens(payload);
      saveAccount(id, { tokens, user: null, device: null, generation: Date.now() });
      clearLibrary(id);
      const { payload: user } = await this.api("/user", { profileId: id });
      const userId = Number(user?.user_id ?? user?.id);
      if (Number.isSafeInteger(userId) && userId > 0) {
        saveAccount(id, {
          ...accountFor(id),
          user: { id: userId, name: String(user.name || user.username || "") }
        });
      }
      return { type: "approved", username: accountFor(id).user?.name || null };
    }
    if (payload?.error === "authorization_pending") return { type: "pending" };
    if (payload?.error === "slow_down") {
      device.pollInterval = Math.min(3600, device.pollInterval + 5);
      device.nextPollAt = Date.now() + device.pollInterval * 1000;
      saveAccount(id, { ...accountFor(id), device });
      return { type: "slow_down" };
    }
    if (payload?.error === "expired_token") {
      saveAccount(id, { ...accountFor(id), device: null });
      return { type: "expired" };
    }
    return {
      type: "failed",
      message: String(
        payload?.error_description || payload?.error || "MDBList authorization failed"
      )
    };
  },

  cancelDeviceAuth() {
    const id = profileId();
    deviceAuthGeneration.set(id, (deviceAuthGeneration.get(id) || 0) + 1);
    const account = accountFor(id);
    if (account.device) saveAccount(id, { ...account, device: null });
  },

  async getAccessToken(id = profileId()) {
    const account = accountFor(id);
    const tokens = account.tokens;
    if (!tokens?.refreshToken) throw error("mdblist_authorization_required", 401);
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    if (refreshInFlight.has(String(id))) return refreshInFlight.get(String(id));
    const refresh = Promise.resolve()
      .then(async () => {
        const { status, payload } = await request("/oauth/token/", {
          method: "POST",
          form: {
            client_id: MDBLIST_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: tokens.refreshToken
          }
        });
        requireCurrentProfile(id);
        if (accountFor(id).tokens?.refreshToken !== tokens.refreshToken) {
          throw error("mdblist_profile_changed");
        }
        if (status < 200 || status >= 300) {
          if (["invalid_grant", "invalid_token"].includes(payload?.error)) {
            saveAccount(id, { user: account.user, generation: Date.now() });
            clearLibrary(id);
          }
          throw error("mdblist_authorization_revoked", status);
        }
        const updatedTokens = validateTokens(payload, tokens.refreshToken);
        saveAccount(id, { ...account, tokens: updatedTokens });
        return updatedTokens.accessToken;
      })
      .finally(() => refreshInFlight.delete(String(id)));
    refreshInFlight.set(String(id), refresh);
    return refresh;
  },

  async api(path, { profileId: id = profileId(), method = "GET", query = {}, body = null } = {}) {
    let token = await this.getAccessToken(id);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await request(path, { method, query, body, accessToken: token });
      requireCurrentProfile(id);
      if (result.status === 401 && attempt === 0) {
        const current = accountFor(id).tokens?.accessToken;
        if (current === token)
          saveAccount(id, {
            ...accountFor(id),
            tokens: { ...accountFor(id).tokens, expiresAt: 0 }
          });
        token = await this.getAccessToken(id);
        continue;
      }
      if (result.status < 200 || result.status >= 300) {
        const detail = String(
          result.payload?.error_description ||
            result.payload?.message ||
            result.payload?.error ||
            ""
        ).trim();
        const message = detail
          ? `MDBList request failed (HTTP ${result.status}): ${detail}`
          : `MDBList request failed (HTTP ${result.status})`;
        throw Object.assign(new Error(message), {
          code: "mdblist_request_failed",
          status: result.status,
          payload: result.payload
        });
      }
      return result;
    }
    throw error("mdblist_authorization_revoked", 401);
  },

  async disconnect() {
    const id = profileId();
    this.cancelDeviceAuth();
    const previous = accountFor(id);
    saveAccount(id, { generation: Date.now() });
    clearLibrary(id);
    if (!previous.tokens?.refreshToken || !MDBLIST_CLIENT_ID) return true;
    try {
      const { status } = await request("/oauth/revoke_token/", {
        method: "POST",
        form: {
          client_id: MDBLIST_CLIENT_ID,
          token: previous.tokens.refreshToken,
          token_type_hint: "refresh_token"
        }
      });
      return status >= 200 && status < 300;
    } catch (error) {
      console.warn("MDBList token revocation failed", error);
      return false;
    }
  }
};
