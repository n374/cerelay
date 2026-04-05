import test from "node:test";
import assert from "node:assert/strict";
import {
  TokenStore,
  extractBearerToken,
  extractQueryToken,
} from "../src/auth.js";

test("TokenStore can create, verify, revoke, and cleanup tokens", async () => {
  const store = new TokenStore(true);
  const { tokenId, token } = store.createFixed(
    "fixed",
    "axon_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd"
  );

  assert.equal(store.verify(token), tokenId);
  assert.equal(store.list()[0]?.lastUsedAt instanceof Date, true);

  assert.equal(store.revoke(tokenId), true);
  assert.equal(store.verify(token), null);
  assert.equal(store.cleanup(), 1);
  assert.equal(store.list().length, 0);
});

test("TokenStore expires ttl tokens", async () => {
  const store = new TokenStore(true);
  const { token } = store.create("ttl", 1);

  assert.equal(store.verify(token) !== null, true);
  await delay(1100);
  assert.equal(store.verify(token), null);
  assert.equal(store.cleanup(), 1);
});

test("token extractors parse valid values", () => {
  assert.equal(extractBearerToken("Bearer axon_token"), "axon_token");
  assert.equal(extractBearerToken("bearer axon_token"), "axon_token");
  assert.equal(extractBearerToken("Basic abc"), null);
  assert.equal(extractQueryToken("/ws?token=axon_token"), "axon_token");
  assert.equal(extractQueryToken(undefined), null);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
