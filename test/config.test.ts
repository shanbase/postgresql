import test from "node:test";
import assert from "node:assert/strict";
import { buildHba, loadSettings } from "../src/config.js";

test("defaults to loopback-only PostgreSQL without TLS", () => {
  const settings = loadSettings({});
  assert.equal(settings.port, 5432);
  assert.equal(settings.listenAddresses, "127.0.0.1");
  assert.equal(settings.ssl, false);
  assert.equal(settings.maxConnections, 30);
});

test("rejects public listeners without TLS", () => {
  assert.throws(
    () => loadSettings({ PG_LISTEN_ADDRESSES: "*" }),
    /TLS is required/
  );
});

test("requires certificate and key when TLS is enabled", () => {
  assert.throws(
    () => loadSettings({ POSTGRES_SSL: "on" }),
    /POSTGRES_SSL_CERT and POSTGRES_SSL_KEY/
  );
});

test("accepts public listeners with TLS files configured", () => {
  const settings = loadSettings({
    PG_LISTEN_ADDRESSES: "*",
    POSTGRES_SSL: "on",
    POSTGRES_SSL_CERT: "/run/secrets/server.crt",
    POSTGRES_SSL_KEY: "/run/secrets/server.key"
  });
  assert.equal(settings.ssl, true);
  assert.equal(settings.listenAddresses, "*");
});

test("rejects invalid ports and connection limits", () => {
  assert.throws(() => loadSettings({ PGPORT: "70000" }), /PGPORT/);
  assert.throws(() => loadSettings({ PG_MAX_CONNECTIONS: "2" }), /PG_MAX_CONNECTIONS/);
});

test("generates TLS-only remote authentication rules", () => {
  const hba = buildHba(true);
  assert.match(hba, /hostnossl all all 0\.0\.0\.0\/0 reject/);
  assert.match(hba, /hostssl all all 0\.0\.0\.0\/0 scram-sha-256/);
});

test("generates loopback-only rules without TLS", () => {
  const hba = buildHba(false);
  assert.match(hba, /127\.0\.0\.1\/32 scram-sha-256/);
  assert.doesNotMatch(hba, /0\.0\.0\.0/);
});
