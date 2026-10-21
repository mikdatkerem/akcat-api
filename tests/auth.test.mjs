import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { getPlatformProxy } from "wrangler";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "../src/security/password.ts";
import { tokenHash } from "../src/security/tokens.ts";
import { BOOTSTRAP_MARKER } from "../src/auth/bootstrap.ts";
import { bootstrapAdmin, BootstrapUnavailable } from "../src/auth/bootstrap.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://localhost:5173";
const key = randomBytes(32).toString("hex");
let child, temporary, base, workerOutput = "";

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function request(path, { headers = {}, ...options } = {}) {
  return fetch(`${base}${path}`, { ...options, headers: { "X-Test-Key": key, ...headers } });
}
async function sql(query, params = []) {
  const response = await request("/__test/sql", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: query, params }),
  });
  assert.equal(response.status, 200, "isolated SQL operation");
  return (await response.json()).results;
}
async function fixture({ role = "employee", active = 1, username } = {}) {
  const user = { id: randomUUID(), username: username ?? `test_${randomBytes(6).toString("hex")}`,
    password: randomBytes(24).toString("base64url"), role };
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(user.password);
  await sql("INSERT INTO users (id,username,password_hash,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    [user.id, user.username, passwordHash, role, active, now, now]);
  return user;
}
function login(user, { headers = {}, ...options } = {}) {
  return request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ username: user.username, password: user.password }),
    ...options, headers: { Origin: origin, "Content-Type": "application/json", ...headers } });
}
async function session(user, options) {
  const response = await login(user, options);
  assert.equal(response.status, 200, "fixture login");
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return { cookie: setCookie.split(";")[0], setCookie, data: await response.json() };
}
function me(cookie, headers = {}) {
  return request("/api/v1/auth/me", { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}
function logout(auth, csrf = auth.data.csrfToken, headers = {}) {
  return request("/api/v1/auth/logout", { method: "POST", headers: { Origin: origin, Cookie: auth.cookie,
    ...(csrf === null ? {} : { "X-CSRF-Token": csrf }), ...headers } });
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), "akcat-auth-test-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(project, "node_modules/wrangler/bin/wrangler.js"), "dev",
    "--config", join(project, "tests/wrangler.jsonc"), "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", "0", "--persist-to", join(temporary, "state"), "--var", `TEST_KEY:${key}`,
    "--show-interactive-dev-session", "false"], {
    cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { workerOutput = (workerOutput + data.toString()).slice(-12000); });
  let ready = false;
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated Worker failed to start: ${workerOutput.replaceAll(key, "[redacted]")}`);
    try { const response = await request("/api/health"); if (response.status === 200) { ready = true; break; } } catch { /* starting */ }
    await delay(250);
  }
  assert.ok(ready, "isolated Worker ready within 40 seconds");
  const schema = await readFile(join(project, "migrations/0001_initial_schema.sql"), "utf8");
  const response = await request("/__test/schema", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql: schema }) });
  assert.equal(response.status, 200);
}, { timeout: 60000 });

after(async () => {
  if (child && child.exitCode === null) {
    const stopped = new Promise((done) => child.once("exit", done));
    child.kill();
    await Promise.race([stopped, delay(10000, undefined, { ref: false })]);
  }
  if (temporary) {
    const target = await realpath(temporary);
    const parent = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase());
    assert.ok(target.toLowerCase().startsWith(`${parent}${sep}akcat-auth-test-`.toLowerCase()));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test("health uses the isolated D1 database; nine tables are present", async () => {
  const response = await request("/api/health");
  assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
  const tables = await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
  assert.equal(tables.length, 9);
});

test("bootstrap is atomic, one-use and remains locked after admin demotion", async () => {
  const first = { username: `first_${randomBytes(6).toString("hex")}`, password: randomBytes(24).toString("base64url") };
  const second = { username: `second_${randomBytes(6).toString("hex")}`, password: randomBytes(24).toString("base64url") };
  const bootstrap = (input) => request("/__test/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const responses = await Promise.all([bootstrap(first), bootstrap(second)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const [marker] = await sql("SELECT actor_user_id FROM audit_logs WHERE id = ?", [BOOTSTRAP_MARKER]);
  const [admin] = await sql("SELECT * FROM users WHERE id = ?", [marker.actor_user_id]);
  assert.ok(admin.password_hash.startsWith("scrypt:v1:16384:8:5:"));
  assert.notEqual(admin.password_hash, first.password);
  await sql("UPDATE users SET role = 'employee', is_active = 0 WHERE id = ?", [admin.id]);
  assert.equal((await bootstrap({ ...second, username: `retry_${randomBytes(6).toString("hex")}` })).status, 409);
  assert.equal((await sql("SELECT id FROM users")).length, 1);
});

test("valid credentials create an opaque hashed session and expose only public user fields", async () => {
  const user = await fixture();
  const auth = await session(user);
  assert.match(auth.cookie, /^akcat_session_dev=w1_[A-Za-z0-9_-]{43}$/);
  assert.match(auth.setCookie, /HttpOnly/i);
  assert.match(auth.setCookie, /SameSite=Lax/i);
  assert.match(auth.setCookie, /Max-Age=28800/i);
  assert.doesNotMatch(auth.setCookie, /; Secure/i);
  assert.deepEqual(Object.keys(auth.data).sort(), ["csrfToken", "expiresAt", "user"]);
  assert.deepEqual(auth.data.user, { id: user.id, username: user.username, role: "employee" });
  const raw = auth.cookie.split("=")[1];
  const [stored] = await sql("SELECT * FROM sessions WHERE user_id = ?", [user.id]);
  assert.equal(stored.id, tokenHash(raw));
  assert.notEqual(stored.id, raw);
  assert.ok(Date.parse(stored.expires_at) > Date.now());
  const response = await me(auth.cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), auth.data);
});

test("wrong password, missing user and inactive account have identical generic failures", async () => {
  const user = await fixture();
  const inactive = await fixture({ active: 0 });
  let expected;
  for (const input of [{ ...user, password: randomUUID() }, { username: `missing_${randomUUID()}`, password: randomUUID() }, inactive]) {
    const response = await login(input);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await response.json();
    expected ??= body;
    assert.deepEqual(body, expected);
  }
});

test("absent and unknown sessions return 401", async () => {
  assert.equal((await me()).status, 401);
  assert.equal((await me(`akcat_session_dev=w1_${randomBytes(32).toString("base64url")}`)).status, 401);
});

test("expired session returns 401", async () => {
  const user = await fixture(); const auth = await session(user);
  await sql("UPDATE sessions SET expires_at = ? WHERE user_id = ?", [new Date(Date.now() - 60000).toISOString(), user.id]);
  assert.equal((await me(auth.cookie)).status, 401);
});

test("logout revokes the session, clears the cookie and preserves audit history", async () => {
  const user = await fixture(); const auth = await session(user);
  const response = await logout(auth);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await me(auth.cookie)).status, 401);
  assert.ok((await sql("SELECT revoked_at FROM sessions WHERE user_id = ?", [user.id]))[0].revoked_at);
  const audit = await sql("SELECT action,metadata,entity_id FROM audit_logs WHERE actor_user_id = ?", [user.id]);
  assert.deepEqual(audit.map((row) => row.action).sort(), ["auth.login", "auth.logout"]);
  for (const row of audit) { assert.equal(row.metadata, null); assert.match(row.entity_id, /^[a-f0-9]{64}$/); }
});

test("employee receives 403 for admin endpoint and role changes apply immediately", async () => {
  const user = await fixture(); const auth = await session(user);
  const admin = () => request("/__test/admin", { headers: { Cookie: auth.cookie } });
  assert.equal((await admin()).status, 403);
  await sql("UPDATE users SET role='admin' WHERE id=?", [user.id]);
  assert.equal((await admin()).status, 200);
  assert.equal((await (await me(auth.cookie)).json()).user.role, "admin");
  await sql("UPDATE users SET role='employee' WHERE id=?", [user.id]);
  assert.equal((await admin()).status, 403);
  assert.equal((await request("/__test/admin")).status, 401);
});

test("deactivation rejects an already active session", async () => {
  const user = await fixture(); const auth = await session(user);
  await sql("UPDATE users SET is_active=0 WHERE id=?", [user.id]);
  assert.equal((await me(auth.cookie)).status, 401);
});

test("cookie mutations require an allowed Origin and a session-bound CSRF token", async () => {
  const auth = await session(await fixture());
  const other = await session(await fixture());
  assert.equal((await logout(auth, null)).status, 403);
  assert.equal((await logout(auth, "invalid")).status, 403);
  assert.equal((await logout(auth, other.data.csrfToken)).status, 403);
  assert.equal((await logout(auth, auth.data.csrfToken, { Origin: "https://untrusted.test" })).status, 403);
  assert.equal((await request("/api/v1/auth/logout", { method: "POST", headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.data.csrfToken } })).status, 403);
  assert.equal((await me(auth.cookie)).status, 200);
  assert.equal((await logout(auth)).status, 200);
});

test("login rejects missing/cross-site Origin and form content types", async () => {
  assert.equal((await request("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await login({ username: "unknown", password: "unknown" }, { headers: { Origin: "https://untrusted.test" } })).status, 403);
  assert.equal((await request("/api/v1/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "username=x&password=x" })).status, 415);
});

test("CORS allows only exact configured origins", async () => {
  const response = await request("/api/v1/auth/login", { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-csrf-token" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  const denied = await request("/api/v1/auth/me", { headers: { Origin: `${origin}.untrusted.test` } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("production response uses Secure HttpOnly __Host cookie", async () => {
  const user = await fixture();
  const auth = await session(user, { headers: { Origin: "https://app.akcat.test", "X-Test-Mode": "secure" } });
  assert.match(auth.setCookie, /^__Host-akcat_session=/);
  assert.match(auth.setCookie, /; Secure/i);
  assert.match(auth.setCookie, /; HttpOnly/i);
  assert.match(auth.setCookie, /; Path=\//i);
  assert.doesNotMatch(auth.setCookie, /Domain=/i);
  assert.equal((await me(auth.cookie, { Origin: "https://app.akcat.test", "X-Test-Mode": "secure" })).status, 200);
});

test("cookie and Bearer transports cannot be mixed; mobile is disabled by default", async () => {
  const user = await fixture(); const auth = await session(user);
  const mobile = `m1_${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  await sql("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    [tokenHash(mobile), user.id, new Date(Date.now() + 60000).toISOString(), now]);
  assert.equal((await me(undefined, { Authorization: `Bearer ${mobile}` })).status, 401);
  assert.equal((await me(undefined, { Authorization: `Bearer ${auth.cookie.split("=")[1]}`, "X-Test-Mode": "bearer" })).status, 401);
  assert.equal((await me(`akcat_session_dev=${mobile}`, { "X-Test-Mode": "bearer" })).status, 401);
  assert.equal((await me(auth.cookie, { Authorization: `Bearer ${mobile}`, "X-Test-Mode": "bearer" })).status, 401);
  assert.equal((await me(`${auth.cookie}; ${auth.cookie}`)).status, 401);
  const response = await me(undefined, { Authorization: `Bearer ${mobile}`, "X-Test-Mode": "bearer" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).csrfToken, undefined);
});

test("Zod validation, JSON parsing and size errors do not echo secrets", async () => {
  const sensitive = randomBytes(24).toString("base64url");
  for (const body of ["{", JSON.stringify({ username: "x", password: sensitive }),
    JSON.stringify({ username: "valid", password: sensitive, role: "admin" }),
    JSON.stringify({ username: "valid", password: sensitive.repeat(200) })]) {
    const response = await request("/api/v1/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
    assert.ok([400, 413].includes(response.status));
    const text = await response.text();
    assert.ok(!text.includes(sensitive));
    assert.doesNotMatch(text, /stack|SELECT|INSERT|password_hash/i);
  }
});

test("normalized Turkish usernames work without altering the password", async () => {
  const user = await fixture({ username: `ışık_${randomBytes(4).toString("hex")}` });
  const response = await login({ ...user, username: `  ${user.username.toLocaleUpperCase("tr-TR")}  ` });
  assert.equal(response.status, 200);
});

test("account rate limiting applies across different client IPs", async () => {
  const username = `rate_${randomBytes(6).toString("hex")}`;
  let status;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await login({ username, password: randomUUID() });
    status = response.status;
    if (status === 429) { assert.equal(response.headers.get("retry-after"), "60"); break; }
    assert.equal(status, 401);
  }
  assert.equal(status, 429);
});

test("IP rate limiting applies across different accounts", async () => {
  const ip = randomUUID(); let status;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request("/api/v1/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Test-IP": ip }, body: "{}" });
    status = response.status;
    if (status === 429) { assert.equal(response.headers.get("retry-after"), "60"); break; }
    assert.equal(status, 400);
  }
  assert.equal(status, 429);
});

test("missing rate-limit binding fails closed", async () => {
  assert.equal((await login({ username: "unknown", password: "unknown" }, { headers: { "X-Test-Mode": "no-rate-binding" } })).status, 503);
});

test("empty origin configuration and public HTTP fail closed without breaking health", async () => {
  for (const mode of ["unconfigured", "insecure-public"]) {
    assert.equal((await request("/api/v1/auth/me", { headers: { "X-Test-Mode": mode } })).status, 503);
    assert.equal((await request("/api/health", { headers: { "X-Test-Mode": mode } })).status, 200);
  }
});

test("Task and public registration routes are absent from API and OpenAPI", async () => {
  for (const path of ["/api/tasks", "/api/tasks/example", "/api/v1/auth/register"]) {
    assert.equal((await request(path)).status, 404);
  }
  const response = await request("/openapi.json");
  assert.equal(response.status, 200);
  const spec = await response.json();
  for (const path of ["login", "logout", "me"]) assert.ok(spec.paths[`/api/v1/auth/${path}`]);
  assert.ok(Object.keys(spec.paths).every((path) => !path.toLowerCase().includes("task")));
});

test("password salts are unique", async () => {
  const password = randomBytes(24).toString("base64url");
  const first = await hashPassword(password); const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.notEqual(first.split(":")[5], second.split(":")[5]);
});

test("local CLI D1 adapter works with isolated persistence and rejects an existing admin", async () => {
  const proxy = await getPlatformProxy({ configPath: join(project, "tests/wrangler.jsonc"),
    persist: { path: join(temporary, "cli-state") }, remoteBindings: false });
  try {
    const db = proxy.env.DB;
    const schema = await readFile(join(project, "migrations/0001_initial_schema.sql"), "utf8");
    await db.batch(schema.split(";").map((value) => value.trim()).filter(Boolean).map((value) => db.prepare(value)));
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,'admin',1,?,?)")
      .bind(randomUUID(), `existing_${randomBytes(6).toString("hex")}`, await hashPassword(randomBytes(24).toString("base64url")), now, now).run();
    await assert.rejects(() => bootstrapAdmin((batch) => db.batch(batch.map(({ sql, params }) => db.prepare(sql).bind(...params))),
      { username: `bootstrap_${randomBytes(6).toString("hex")}`, password: randomBytes(24).toString("base64url") }), BootstrapUnavailable);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM users").first()).count, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs").first()).count, 0);
  } finally { await proxy.dispose(); }
});
