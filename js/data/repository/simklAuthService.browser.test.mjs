import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  }
};
globalThis.__NUVIO_PLATFORM__ = "browser";
globalThis.__NUVIO_ENV__ = { SIMKL_CLIENT_ID: "browser-public-client" };

const { Platform } = await import("../../platform/index.js");
Platform.current = null;
const { SimklAuthStore } = await import("../local/simklAuthStore.js");
const { SimklAuthService, simklRequest } = await import("./simklAuthService.js");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("Simkl OAuth 2.0 device authorization and polling", async () => {
  storage.clear();
  storage.set("simklRequestRateState", JSON.stringify({ cooldownUntil: Date.now() + 60_000 }));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(String(url));
    calls.push({
      url: parsedUrl,
      method: options.method,
      body: options.body
        ? options.headers["Content-Type"] === "application/x-www-form-urlencoded"
          ? Object.fromEntries(new URLSearchParams(options.body))
          : JSON.parse(options.body)
        : null,
      headers: options.headers
    });

    if (parsedUrl.pathname === "/oauth2/device") {
      return json({
        device_code: "simkl-device-code",
        user_code: "ABCD-1234",
        verification_url: "https://simkl.com/activate",
        expires_in: 600,
        interval: 5
      });
    }
    if (parsedUrl.pathname === "/oauth2/token") {
      if (calls.filter((call) => call.url.pathname === "/oauth2/token").length === 1) {
        return json({ error: "authorization_pending" }, 400);
      }
      return json({ access_token: "simkl-access-token" });
    }
    if (parsedUrl.pathname === "/users/settings") {
      return json({ user: { name: "tester" }, account: { id: 123 } });
    }
    assert.fail(`Unexpected request: ${parsedUrl}`);
  };

  try {
    const state = await SimklAuthService.startDeviceAuth();
    assert.equal(state.deviceCode, "simkl-device-code");
    assert.equal(state.userCode, "ABCD-1234");
    assert.equal(calls[0].url.pathname, "/oauth2/device");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(calls[0].body, {
      client_id: "browser-public-client",
      scope: "media:read media:write"
    });
    assert.equal(calls[0].url.searchParams.get("client_id"), "browser-public-client");
    assert.equal(JSON.parse(storage.get("simklRequestRateState")).cooldownUntil, undefined);

    assert.deepEqual(await SimklAuthService.pollDeviceAuth(), { type: "pending" });
    assert.equal(calls[1].url.pathname, "/oauth2/token");
    assert.equal(calls[1].headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(calls[1].body, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "browser-public-client",
      device_code: "simkl-device-code"
    });

    assert.deepEqual(await SimklAuthService.pollDeviceAuth(), { type: "pending" });
    assert.equal(calls.filter((call) => call.url.pathname === "/oauth2/token").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 5100));

    const result = await SimklAuthService.pollDeviceAuth();
    assert.deepEqual(result, { type: "approved", username: "tester" });
    assert.equal(SimklAuthStore.get().accessToken, "simkl-access-token");
    assert.equal(SimklAuthStore.get().deviceCode, null);
    assert.equal(SimklAuthStore.get().userCode, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Simkl 429 responses are not retried and start a shared cooldown", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("{}", {
      status: 429,
      headers: { "Retry-After": "30", "Content-Type": "application/json" }
    });
  };

  try {
    await assert.rejects(simklRequest("/users/settings"), (error) => error.status === 429);
    await assert.rejects(simklRequest("/users/settings"), (error) => error.status === 429);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});

test("Simkl 401 responses invalidate the token and prevent subsequent API requests", async () => {
  storage.clear();
  SimklAuthStore.saveToken("simkl-access-token");
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("{}", {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    await assert.rejects(simklRequest("/sync/all-items/all/watching"), (error) => {
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(SimklAuthStore.get().authorizationRevoked, true);
    assert.equal(SimklAuthService.isAuthenticated(), false);
    await assert.rejects(simklRequest("/sync/all-items/all/watching"), /authentication required/);
    assert.equal(fetchCount, 1);
    SimklAuthStore.saveToken("new-simkl-access-token");
    assert.equal(SimklAuthStore.get().authorizationRevoked, false);
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});
