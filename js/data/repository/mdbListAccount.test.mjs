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
globalThis.__NUVIO_ENV__ = { MDBLIST_CLIENT_ID: "browser-public-mdblist-client" };

const { Platform } = await import("../../platform/index.js");
Platform.current = null;
const { MdbListAccount } = await import("./mdbListAccount.js");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("MDBList account connects with device OAuth and uses a bearer token for account reads", async () => {
  storage.clear();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(String(url));
    calls.push({ path: parsedUrl.pathname, options });
    if (parsedUrl.pathname === "/oauth/device-authorization/") {
      return json({
        device_code: "device-token",
        user_code: "ABCD-EFGH",
        verification_uri: "https://mdblist.com/oauth/device",
        expires_in: 300,
        interval: 1
      });
    }
    if (parsedUrl.pathname === "/oauth/token/") {
      return json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "write"
      });
    }
    if (parsedUrl.pathname === "/user") {
      assert.equal(options.headers.Authorization, "Bearer access-token");
      return json({ id: 123, name: "test-user" });
    }
    assert.fail(`Unexpected MDBList request: ${parsedUrl.pathname}`);
  };

  try {
    assert.equal(MdbListAccount.isConfigured(), true);
    const auth = await MdbListAccount.startDeviceAuth();
    assert.equal(auth.userCode, "ABCD-EFGH");
    assert.equal(calls[0].options.headers["Content-Type"], "application/x-www-form-urlencoded");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await MdbListAccount.pollDeviceAuth();
    assert.deepEqual(result, { type: "approved", username: "test-user" });
    assert.equal(MdbListAccount.isAuthenticated(), true);
    assert.equal(MdbListAccount.getCurrentAuthState().username, "test-user");
    assert.deepEqual(
      calls.map(({ path }) => path),
      ["/oauth/device-authorization/", "/oauth/token/", "/user"]
    );
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});

test("MDBList account disconnect clears account credentials", async () => {
  storage.clear();
  storage.set(
    "mdbListAccounts",
    JSON.stringify({
      1: {
        generation: 1,
        tokens: { accessToken: "access-token", refreshToken: "refresh-token", expiresAt: 0 },
        user: { id: 123, name: "test-user" }
      }
    })
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(String(url)).pathname, "/oauth/revoke_token/");
    return json({ success: true });
  };

  try {
    assert.equal(MdbListAccount.isAuthenticated(), true);
    assert.equal(await MdbListAccount.disconnect(), true);
    assert.equal(MdbListAccount.isAuthenticated(), false);
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});

test("MDBList refreshes the access token once for concurrent callers", async () => {
  storage.clear();
  storage.set(
    "mdbListAccounts",
    JSON.stringify({
      1: {
        generation: 1,
        tokens: { accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: 0 },
        user: { id: 123, name: "test-user" }
      }
    })
  );
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ path: new URL(String(url)).pathname, options });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return json({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 3600
    });
  };

  try {
    assert.deepEqual(
      await Promise.all([MdbListAccount.getAccessToken(), MdbListAccount.getAccessToken()]),
      ["new-access-token", "new-access-token"]
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/oauth/token/");
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});

test("cancelling an in-flight MDBList device poll prevents stale credentials from being saved", async () => {
  storage.clear();
  const originalFetch = globalThis.fetch;
  let releaseTokenResponse;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/oauth/device-authorization/") {
      return json({
        device_code: "device-token",
        user_code: "ABCD-EFGH",
        verification_uri: "https://mdblist.com/oauth/device",
        expires_in: 300,
        interval: 1
      });
    }
    if (path === "/oauth/token/") {
      return new Promise((resolve) => {
        releaseTokenResponse = () =>
          resolve(
            json({
              access_token: "stale-access-token",
              refresh_token: "stale-refresh-token",
              token_type: "Bearer",
              expires_in: 3600
            })
          );
      });
    }
    assert.fail(`Unexpected MDBList request: ${path}`);
  };

  try {
    await MdbListAccount.startDeviceAuth();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const pending = MdbListAccount.pollDeviceAuth();
    while (!releaseTokenResponse) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    MdbListAccount.cancelDeviceAuth();
    releaseTokenResponse();
    assert.deepEqual(await pending, { type: "invalidated" });
    assert.equal(MdbListAccount.isAuthenticated(), false);
  } finally {
    globalThis.fetch = originalFetch;
    storage.clear();
  }
});
