/* global __NUVIO_APP_VERSION__ */
import { SIMKL_API_URL, SIMKL_APP_NAME, SIMKL_CLIENT_ID } from "../../config.js";
import { SimklAuthStore } from "../local/simklAuthStore.js";
import { SimklCredentialSyncService } from "../../core/profile/simklCredentialSyncService.js";
import { ProfileManager } from "../../core/profile/profileManager.js";
import { LocalStore } from "../../core/storage/localStore.js";

const DEFAULT_API_URL = "https://api.simkl.com";
const MAX_ATTEMPTS = 5;
const REQUEST_INTERVAL_MS = 2000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_STATE_KEY_PREFIX = "simklRequestRateState";
const DEVICE_POLL_STATE_KEY = "simklDevicePollState";
let requestQueue = Promise.resolve();

function appVersion() {
  return typeof __NUVIO_APP_VERSION__ !== "undefined" ? __NUVIO_APP_VERSION__ : "0.0.0";
}

function activeProfileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function apiBaseUrl() {
  return String(SIMKL_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

function rateStateKey() {
  return `${RATE_STATE_KEY_PREFIX}:${SIMKL_CLIENT_ID || "unconfigured"}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url, options) {
  const request = async () => {
    const stateKey = rateStateKey();
    const state = LocalStore.get(stateKey, {});
    const now = Date.now();
    if (Number(state.cooldownUntil) > now) {
      const error = new Error("Simkl is rate limiting requests. Please try again later.");
      error.status = 429;
      error.retryAfter = Number(state.cooldownUntil) - now;
      throw error;
    }

    const waitMs = Number(state.lastRequestAt) + REQUEST_INTERVAL_MS - now;
    if (waitMs > 0) await sleep(waitMs);

    try {
      const response = await fetch(url, options);
      const completedAt = Date.now();
      const nextState = { lastRequestAt: completedAt };
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
        nextState.cooldownUntil = Math.max(
          Number(state.cooldownUntil) || 0,
          completedAt + (retryAfter || RATE_LIMIT_COOLDOWN_MS)
        );
      } else if (Number(state.cooldownUntil) > completedAt) {
        nextState.cooldownUntil = state.cooldownUntil;
      }
      LocalStore.set(stateKey, nextState);
      return response;
    } catch (error) {
      LocalStore.set(stateKey, { ...state, lastRequestAt: Date.now() });
      throw error;
    }
  };
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request("nuvio-simkl-api-rate", request) : request();
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp - Date.now());
}

export function withBrowserLock(name, callback) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(name, callback) : callback();
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

function errorMessage(payload, status) {
  if (payload && typeof payload === "object") {
    return String(
      payload.message || payload.error_description || payload.error || `HTTP ${status}`
    );
  }
  return `Simkl request failed (${status})`;
}

async function executeSimklRequest(
  path,
  {
    method = "GET",
    body = null,
    formEncoded = false,
    authenticated = true,
    retry = true,
    authorizationToken = null,
    authProfileId = null
  } = {}
) {
  if (!SIMKL_CLIENT_ID) throw new Error("Missing SIMKL_CLIENT_ID");
  const url = new URL(`${apiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("client_id", SIMKL_CLIENT_ID);
  url.searchParams.set("app-name", SIMKL_APP_NAME || "nuvio");
  url.searchParams.set("app-version", appVersion());
  const token = authenticated ? authorizationToken : null;
  if (authenticated && !token) throw new Error("Simkl authentication required");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) {
    headers["Content-Type"] = formEncoded
      ? "application/x-www-form-urlencoded"
      : "application/json";
  }

  const attempts = retry ? MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (authenticated) {
      const currentAuth = SimklAuthStore.get(authProfileId);
      if (currentAuth.authorizationRevoked || currentAuth.accessToken !== token) {
        throw new Error("Simkl authorization is invalid. Reconnect Simkl.");
      }
    }
    let response;
    try {
      response = await rateLimitedFetch(url.toString(), {
        method,
        headers,
        body:
          body == null
            ? undefined
            : formEncoded
              ? new URLSearchParams(body).toString()
              : JSON.stringify(body),
        // A scrobble is usually written while the page is going away -- the tab
        // is closing, or the app is being backgrounded -- and an ordinary fetch
        // is cancelled with the document. Payloads here are far below the 64KB
        // keepalive limit.
        keepalive: body != null
      });
    } catch (error) {
      if (error?.status === 429) throw error;
      if (attempt + 1 >= attempts) throw error;
      await sleep(Math.min(60000, 1000 * 2 ** attempt));
      continue;
    }
    const payload = await readPayload(response);
    if (response.ok || (response.status === 409 && path === "/scrobble/stop")) {
      return { response, payload };
    }
    if (response.status === 401) {
      SimklAuthStore.markAuthorizationRevoked(authProfileId);
      await SimklCredentialSyncService.deleteRemote(authProfileId);
      const error = new Error("Simkl authorization was rejected. Reconnect Simkl.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    const syncWriteLocked =
      response.status === 400 &&
      String(method).toUpperCase() !== "GET" &&
      String(path).startsWith("/sync/") &&
      String(payload?.error || "").toLowerCase() === "rate_limit";
    const transient = syncWriteLocked || [500, 502, 503].includes(response.status);
    if (!transient || attempt + 1 >= attempts) {
      const error = new Error(errorMessage(payload, response.status));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
    await sleep(
      Math.min(60000, Math.max(retryAfter, syncWriteLocked ? 3000 : 1000 * 2 ** attempt))
    );
  }
  throw new Error("Simkl request failed");
}

export function simklRequest(path, options = {}) {
  const authProfileId = String(options.profileId || activeProfileId());
  const authorizationToken =
    options.authenticated === false ? null : SimklAuthStore.get(authProfileId).accessToken;
  const task = requestQueue.then(() =>
    executeSimklRequest(path, { ...options, authProfileId, authorizationToken })
  );
  requestQueue = task.catch(() => false);
  return task;
}

async function fetchUserSettings(profileId = activeProfileId()) {
  const { payload } = await simklRequest("/users/settings", { method: "POST", profileId });
  const username = String(payload?.user?.name || "") || null;
  const accountId = payload?.account?.id == null ? null : Number(payload.account.id);
  SimklAuthStore.saveIdentity({ username, accountId }, profileId);
  return username;
}

export const SimklAuthService = {
  hasRequiredCredentials() {
    return Boolean(SIMKL_CLIENT_ID);
  },

  getCurrentAuthState() {
    return SimklAuthStore.get();
  },

  isAuthenticated() {
    return SimklAuthStore.isAuthenticated();
  },

  async startDeviceAuth() {
    if (!SIMKL_CLIENT_ID) throw new Error("Missing SIMKL_CLIENT_ID");
    const profileId = activeProfileId();
    const current = SimklAuthStore.get(profileId);
    if (
      current.deviceCode &&
      current.userCode &&
      current.deviceClientId === SIMKL_CLIENT_ID &&
      current.expiresAt &&
      Date.now() < current.expiresAt
    ) {
      return current;
    }
    if (current.deviceCode || current.userCode) {
      SimklAuthStore.clearDeviceSession(profileId);
    }
    const { payload } = await simklRequest("/oauth2/device", {
      method: "POST",
      authenticated: false,
      formEncoded: true,
      body: { client_id: SIMKL_CLIENT_ID, scope: "media:read media:write" }
    });
    if (
      !payload?.device_code ||
      !payload?.user_code ||
      !(payload?.verification_url || payload?.verification_uri) ||
      !Number(payload?.expires_in)
    ) {
      throw new Error("Simkl returned an invalid device authorization response");
    }
    const state = SimklAuthStore.saveDeviceSession(
      { ...payload, clientId: SIMKL_CLIENT_ID },
      profileId
    );
    LocalStore.remove(`${DEVICE_POLL_STATE_KEY}:${profileId}`);
    return state;
  },

  async pollDeviceAuth() {
    const profileId = activeProfileId();
    return withBrowserLock(`nuvio-simkl-device-poll:${profileId}`, async () => {
      const state = SimklAuthStore.get(profileId);
      if (!state.deviceCode || !state.userCode) {
        return state.accessToken
          ? { type: "approved", username: state.username }
          : { type: "invalidated" };
      }
      if (state.deviceClientId !== SIMKL_CLIENT_ID) {
        SimklAuthStore.clearDeviceSession(profileId);
        LocalStore.remove(`${DEVICE_POLL_STATE_KEY}:${profileId}`);
        return { type: "invalidated" };
      }
      if (state.expiresAt && Date.now() >= state.expiresAt) {
        SimklAuthStore.clearDeviceSession(profileId);
        LocalStore.remove(`${DEVICE_POLL_STATE_KEY}:${profileId}`);
        return { type: "expired" };
      }
      const pollStateKey = `${DEVICE_POLL_STATE_KEY}:${profileId}`;
      const lastPollAt = Number(LocalStore.get(pollStateKey, 0)) || 0;
      const pollIntervalMs = Math.max(1, Number(state.pollInterval || 5)) * 1000;
      if (Date.now() - lastPollAt < pollIntervalMs) return { type: "pending" };
      LocalStore.set(pollStateKey, Date.now());

      let payload;
      try {
        ({ payload } = await simklRequest("/oauth2/token", {
          method: "POST",
          authenticated: false,
          retry: false,
          formEncoded: true,
          body: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: SIMKL_CLIENT_ID,
            device_code: state.deviceCode
          }
        }));
      } catch (error) {
        const oauthError = String(
          error?.payload?.error || error?.payload?.result || error?.payload?.message || ""
        ).toLowerCase();
        if (oauthError === "slow_down") {
          SimklAuthStore.setPollInterval(state.pollInterval + 5, profileId);
          return { type: "pending" };
        }
        if (oauthError === "authorization_pending" || oauthError === "ko") {
          return { type: "pending" };
        }
        if (
          oauthError === "expired_token" ||
          oauthError === "expired" ||
          oauthError === "invalid_grant"
        ) {
          SimklAuthStore.clearDeviceSession(profileId);
          LocalStore.remove(pollStateKey);
          return { type: "expired" };
        }
        throw error;
      }
      if (String(payload?.error || "").toLowerCase() === "slow_down") {
        SimklAuthStore.setPollInterval(state.pollInterval + 5, profileId);
        return { type: "pending" };
      }
      if (
        String(payload?.error || "").toLowerCase() === "authorization_pending" ||
        payload?.result === "KO"
      ) {
        return { type: "pending" };
      }
      const accessToken = String(payload?.access_token || "").trim();
      if (!accessToken) {
        SimklAuthStore.clearDeviceSession(profileId);
        LocalStore.remove(pollStateKey);
        return { type: "invalidated" };
      }
      SimklAuthStore.saveToken(accessToken, profileId);
      const username = await fetchUserSettings(profileId).catch(() => null);
      await SimklCredentialSyncService.pushCurrentToRemote(profileId);
      return { type: "approved", username };
    });
  },

  cancelDeviceAuth() {
    const profileId = activeProfileId();
    SimklAuthStore.clearDeviceSession(profileId);
    LocalStore.remove(`${DEVICE_POLL_STATE_KEY}:${profileId}`);
  },

  fetchUserSettings,

  async disconnect() {
    const profileId = activeProfileId();
    await SimklCredentialSyncService.deleteRemote(profileId);
    SimklAuthStore.clearAuth(profileId);
  }
};
