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
import { registerFinanceTests } from "./finance.cases.mjs";
import { registerCorrectionTests } from "./corrections.cases.mjs";

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
  const schema = (await Promise.all(["0001_initial_schema.sql", "0002_financial_adjustments.sql"].map(file => readFile(join(project, "migrations", file), "utf8")))).join("\n");
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

test("health uses the isolated D1 database; ten tables are present", async () => {
  const response = await request("/api/health");
  assert.deepEqual(await response.json(), { status: "ok", database: "connected" });
  const tables = await sql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
  assert.equal(tables.length, 10);
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
    const schema = (await Promise.all(["0001_initial_schema.sql", "0002_financial_adjustments.sql"].map(file => readFile(join(project, "migrations", file), "utf8")))).join("\n");
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

let customerAdmin, customerEmployee, managedCustomer;
function customerRequest(auth, path = "", method = "GET", body, headers = {}) {
  return request("/api/v1/customers" + path, { method,
    headers: { Cookie: auth.cookie, Origin: origin, ...(method !== "GET" ? {
      "Content-Type": "application/json", "X-CSRF-Token": auth.data.csrfToken, "Idempotency-Key": randomUUID(),
    } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const customerInput = () => ({ name: `Müşteri ${randomUUID()}`, phone: "+90 (555) 123-45-67", address: `Adres ${randomUUID()}`, delivery_notes: "Kapı notu" });

test("customers: unauthenticated access is rejected; isolated table is genuinely empty", async () => {
  assert.equal((await request("/api/v1/customers")).status, 401);
  customerAdmin = await session(await fixture({ role: "admin" }));
  customerEmployee = await session(await fixture());
  const response = await customerRequest(customerEmployee);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
});

test("customers: both roles create customers; responses use UUIDs, UTC dates and boolean active state", async () => {
  for (const auth of [customerAdmin, customerEmployee]) {
    const response = await customerRequest(auth, "", "POST", customerInput());
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.match(data.id, /^[a-f0-9-]{36}$/);
    assert.equal(data.is_active, true);
    assert.match(data.created_at, /Z$/);
    managedCustomer = data;
  }
  const detail = await customerRequest(customerEmployee, "/" + managedCustomer.id);
  assert.deepEqual((await detail.json()).data, managedCustomer);
});

test("customers: employee edits basic fields without clearing omitted phone or notes", async () => {
  const response = await customerRequest(customerEmployee, "/" + managedCustomer.id, "PATCH", { name: "Güncel isim", address: "Güncel adres" });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.name, "Güncel isim"); assert.equal(data.address, "Güncel adres");
  assert.equal(data.phone, managedCustomer.phone); assert.equal(data.delivery_notes, managedCustomer.delivery_notes);
  const cleared = await customerRequest(customerEmployee, "/" + managedCustomer.id, "PATCH", { delivery_notes: null, phone: "" });
  assert.equal(cleared.status, 200);
  const result = (await cleared.json()).data;
  assert.equal(result.phone, null); assert.equal(result.delivery_notes, null);
});

test("customers: employee cannot send active status; admin deactivates and reactivates", async () => {
  for (const state of [false, true]) assert.equal((await customerRequest(customerEmployee, "/" + managedCustomer.id, "PATCH", { is_active: state })).status, 403);
  const response = await customerRequest(customerAdmin, "/" + managedCustomer.id, "PATCH", { is_active: false });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.is_active, false);
  const inactive = await customerRequest(customerEmployee, "?status=inactive");
  assert.ok((await inactive.json()).data.some(item => item.id === managedCustomer.id));
  const active = await customerRequest(customerEmployee, "?status=active");
  assert.ok((await active.json()).data.every(item => item.id !== managedCustomer.id));
  assert.equal((await customerRequest(customerAdmin, "/" + managedCustomer.id, "PATCH", { is_active: true })).status, 200);
  assert.equal((await customerRequest(customerAdmin, "/" + managedCustomer.id, "DELETE")).status, 404);
});

test("customers: Turkish case-insensitive name and formatted phone search; SQL/wildcards stay literal", async () => {
  const input = { ...customerInput(), name: "IŞIK İNŞAAT " + randomUUID(), phone: "+44 (20) 7946-0958 ext 123" };
  const created = (await (await customerRequest(customerAdmin, "", "POST", input)).json()).data;
  for (const query of ["ışık inşaat", "+44 20 7946", "2079460958"]) {
    const response = await customerRequest(customerEmployee, "?q=" + encodeURIComponent(query));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).data.some(item => item.id === created.id));
  }
  for (const query of ["' OR 1=1 --", "%", "_"]) {
    assert.deepEqual((await (await customerRequest(customerEmployee, "?q=" + encodeURIComponent(query))).json()).data, []);
  }
});

test("customers: bounded pagination is stable and complete", async () => {
  const prefix = "Sayfa " + randomUUID();
  for (let index = 0; index < 5; index++) {
    assert.equal((await customerRequest(customerAdmin, "", "POST", { ...customerInput(), name: prefix + index })).status, 201);
  }
  const ids = [];
  for (let page = 1; page <= 3; page++) {
    const response = await customerRequest(customerEmployee, `?q=${encodeURIComponent(prefix)}&page=${page}&pageSize=2`);
    const result = await response.json();
    assert.equal(result.pagination.total, 5); assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.data.length, page === 3 ? 1 : 2);
    ids.push(...result.data.map(item => item.id));
  }
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual((await (await customerRequest(customerEmployee, `?q=${encodeURIComponent(prefix)}&page=4&pageSize=2`)).json()).data, []);
  for (const query of ["page=0", "page=-1", "page=1.5", "page=100001", "pageSize=0", "pageSize=101", "page=NaN", "status=anything"]) {
    assert.equal((await customerRequest(customerEmployee, "?" + query)).status, 400);
  }
});

test("customers: explicit empty search is accepted", async () => {
  for (const query of ["?q=", "?status=all", "?page=1&pageSize=20", "?q=&status=all&page=1&pageSize=20"]) {
    assert.equal((await customerRequest(customerEmployee, query)).status, 200, query);
  }
});

test("customers: optional fields and copied/international phone formats stay valid", async () => {
  const minimal = await customerRequest(customerEmployee, "", "POST", { name: "Asgari " + randomUUID(), address: "Adres" });
  assert.equal(minimal.status, 201);
  const value = (await minimal.json()).data;
  assert.equal(value.phone, null); assert.equal(value.delivery_notes, null);
  for (const phone of ["+90\u00a0555\u00a0123–45–67", "00442079460958 dahili 123", "444 1 444"]) {
    assert.equal((await customerRequest(customerEmployee, "", "POST", { ...customerInput(), phone })).status, 201);
  }
});

test("customers: invalid bodies and paths are rejected without reflecting personal data", async () => {
  const sensitive = "Private " + randomUUID();
  for (const body of [{ name: sensitive }, { ...customerInput(), name: " " }, { ...customerInput(), address: " " },
    { ...customerInput(), phone: "invalid" }, { ...customerInput(), phone: "123" }, { ...customerInput(), phone: "1".repeat(16) },
    { ...customerInput(), is_active: false }, { ...customerInput(), delivery_notes: "x".repeat(2001) },
    { ...customerInput(), name: "control\u0000name" }, { ...customerInput(), delivery_notes: "control\u0001note" }]) {
    const response = await customerRequest(customerEmployee, "", "POST", body);
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes(sensitive));
  }
  for (const body of [{}, { id: randomUUID() }, { is_active: "false" }]) assert.equal((await customerRequest(customerAdmin, "/" + managedCustomer.id, "PATCH", body)).status, 400);
  assert.equal((await customerRequest(customerAdmin, "/bad-id")).status, 400);
  assert.equal((await customerRequest(customerAdmin, "/" + randomUUID())).status, 404);
  assert.equal((await customerRequest(customerAdmin, "/" + randomUUID(), "PATCH", { name: "Yok" })).status, 404);
});

test("customers: concurrent/retried create is idempotent and mismatched payload conflicts", async () => {
  const input = customerInput(); const key = randomUUID();
  const send = body => customerRequest(customerEmployee, "", "POST", body, { "Idempotency-Key": key });
  const responses = await Promise.all([send(input), send(input)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.equal(bodies[0].data.id, bodies[1].data.id);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM customers WHERE name=?", [input.name]))[0].count, 1);
  assert.equal((await send({ ...input, address: input.address + "changed" })).status, 409);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type='customer' AND entity_id=?", [bodies[0].data.id]))[0].count, 1);
});

test("customers: audit records contain actor, action, entity and field names, not personal values", async () => {
  const audit = await sql("SELECT * FROM audit_logs WHERE entity_type='customer' AND entity_id=? ORDER BY created_at", [managedCustomer.id]);
  assert.ok(audit.some(row => row.action === "customer.created" && row.actor_user_id === customerEmployee.data.user.id));
  assert.ok(audit.some(row => row.action === "customer.updated" && row.actor_user_id === customerAdmin.data.user.id));
  for (const row of audit) {
    const metadata = JSON.parse(row.metadata);
    assert.ok(Array.isArray(metadata.fields));
    assert.ok(Object.keys(metadata).every(key => ["fields", "request_hash"].includes(key)));
    assert.ok(!row.metadata.includes(managedCustomer.address));
    assert.ok(!row.metadata.includes(managedCustomer.phone));
    assert.ok(!row.metadata.includes(customerEmployee.cookie));
  }
});

test("customers: CSRF and exact-origin CORS remain enforced, including PATCH preflight", async () => {
  assert.equal((await customerRequest(customerEmployee, "", "POST", customerInput(), { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await customerRequest(customerEmployee, "/" + managedCustomer.id, "PATCH", { name: "Blocked" }, { Origin: "https://untrusted.test" })).status, 403);
  const response = await request("/api/v1/customers/" + managedCustomer.id, { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type,x-csrf-token,idempotency-key" } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.ok(response.headers.get("access-control-allow-methods").includes("PATCH"));
});

test("customers: audit failure rolls back the customer mutation atomically", async () => {
  const before = (await (await customerRequest(customerAdmin, "/" + managedCustomer.id)).json()).data;
  await sql("CREATE TRIGGER test_reject_customer_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='customer' BEGIN SELECT RAISE(ABORT, 'isolated audit failure'); END");
  try {
    const response = await customerRequest(customerAdmin, "/" + managedCustomer.id, "PATCH", { address: "Must roll back" });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SQL|stack|Must roll back|isolated audit failure/);
    const input = customerInput();
    assert.equal((await customerRequest(customerAdmin, "", "POST", input)).status, 500);
    assert.equal((await sql("SELECT COUNT(*) AS count FROM customers WHERE name=?", [input.name]))[0].count, 0);
  } finally { await sql("DROP TRIGGER test_reject_customer_audit"); }
  assert.deepEqual((await (await customerRequest(customerAdmin, "/" + managedCustomer.id)).json()).data, before);
});

let managedProduct;
const productInput = () => ({ name: `Ürün ${randomUUID()}`, current_price_kurus: 1999, is_active: true });
function productRequest(auth, path = "", method = "GET", body, headers = {}) {
  return request("/api/v1/products" + path, { method, headers: { Cookie: auth.cookie, Origin: origin,
    ...(method !== "GET" ? { "Content-Type": "application/json", "X-CSRF-Token": auth.data.csrfToken, "Idempotency-Key": randomUUID() } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("products: unauthenticated access is rejected and employee sees a genuinely empty list", async () => {
  assert.equal((await request("/api/v1/products")).status, 401);
  const response = await productRequest(customerEmployee);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
});
test("products: admin creates an integer-priced product; employee reads list and detail", async () => {
  const input = productInput();
  const response = await productRequest(customerAdmin, "", "POST", input);
  assert.equal(response.status, 201);
  managedProduct = (await response.json()).data;
  assert.equal(managedProduct.name, input.name); assert.equal(managedProduct.current_price_kurus, 1999);
  assert.equal(managedProduct.is_active, true); assert.match(managedProduct.created_at, /Z$/);
  assert.deepEqual((await (await productRequest(customerEmployee, "/" + managedProduct.id)).json()).data, managedProduct);
  assert.ok((await (await productRequest(customerEmployee)).json()).data.some(row => row.id === managedProduct.id));
  assert.equal((await sql("SELECT typeof(current_price_kurus) AS type FROM products WHERE id=?", [managedProduct.id]))[0].type, "integer");
});
test("products: employee cannot create or change name, price or active state", async () => {
  assert.equal((await productRequest(customerEmployee, "", "POST", productInput())).status, 403);
  for (const body of [{ name: "Denied" }, { current_price_kurus: 1 }, { is_active: false }]) {
    assert.equal((await productRequest(customerEmployee, "/" + managedProduct.id, "PATCH", body)).status, 403);
  }
  assert.deepEqual((await (await productRequest(customerEmployee, "/" + managedProduct.id)).json()).data, managedProduct);
});
test("products: admin changes price, deactivates, filters and reactivates without deletion", async () => {
  const changed = await productRequest(customerAdmin, "/" + managedProduct.id, "PATCH", { current_price_kurus: 15000, is_active: false });
  assert.equal(changed.status, 200);
  const result = (await changed.json()).data;
  assert.equal(result.current_price_kurus, 15000); assert.equal(result.name, managedProduct.name); assert.equal(result.is_active, false);
  assert.ok((await (await productRequest(customerEmployee, "?status=inactive")).json()).data.some(row => row.id === result.id));
  assert.ok((await (await productRequest(customerEmployee, "?status=active")).json()).data.every(row => row.id !== result.id));
  const active = await productRequest(customerAdmin, "/" + result.id, "PATCH", { is_active: true });
  assert.equal(active.status, 200); assert.equal((await active.json()).data.is_active, true);
  assert.equal((await productRequest(customerAdmin, "/" + result.id, "DELETE")).status, 404);
  assert.equal((await productRequest(customerEmployee, "/" + result.id)).status, 200);
});
test("products: invalid prices, names, bodies and ids are rejected; zero and safe integer maximum are exact", async () => {
  for (const body of [{ ...productInput(), name: " " }, { ...productInput(), name: "x".repeat(161) }, { ...productInput(), name: "x\u0000" },
    ...[-1, 19.99, "1999", null, Number.MAX_SAFE_INTEGER + 1].map(price => ({ ...productInput(), current_price_kurus: price })),
    { name: "Missing price" }, { ...productInput(), stock: 1 }, { ...productInput(), is_active: 1 }]) {
    assert.equal((await productRequest(customerAdmin, "", "POST", body)).status, 400);
  }
  for (const body of [{}, { current_price_kurus: -1 }, { current_price_kurus: 1.5 }, { is_active: "false" }, { name: " " }, { id: randomUUID() }]) {
    assert.equal((await productRequest(customerAdmin, "/" + managedProduct.id, "PATCH", body)).status, 400);
  }
  for (const price of [0, Number.MAX_SAFE_INTEGER]) {
    const response = await productRequest(customerAdmin, "", "POST", { ...productInput(), current_price_kurus: price, is_active: false });
    assert.equal(response.status, 201); const item = (await response.json()).data;
    assert.equal(item.current_price_kurus, price); assert.equal(item.is_active, false);
    assert.equal((await sql("SELECT current_price_kurus FROM products WHERE id=?", [item.id]))[0].current_price_kurus, price);
  }
  assert.equal((await productRequest(customerEmployee, "/bad-id")).status, 400);
  assert.equal((await productRequest(customerEmployee, "/" + randomUUID())).status, 404);
  assert.equal((await productRequest(customerAdmin, "/" + randomUUID(), "PATCH", { name: "Missing" })).status, 404);
});
test("products: Turkish search, literal SQL/wildcards, empty q and bounded pagination", async () => {
  const prefix = "IŞIK İNŞAAT " + randomUUID();
  for (let index = 0; index < 5; index++) assert.equal((await productRequest(customerAdmin, "", "POST", { ...productInput(), name: prefix + index })).status, 201);
  const ids = [];
  for (let page = 1; page <= 3; page++) {
    const result = await (await productRequest(customerEmployee, `?q=${encodeURIComponent(prefix.toLocaleLowerCase("tr-TR"))}&page=${page}&pageSize=2`)).json();
    assert.equal(result.pagination.total, 5); assert.equal(result.pagination.totalPages, 3);
    assert.equal(result.data.length, page === 3 ? 1 : 2); ids.push(...result.data.map(row => row.id));
  }
  assert.equal(new Set(ids).size, 5);
  for (const q of ["' OR 1=1 --", "%", "_"]) assert.deepEqual((await (await productRequest(customerEmployee, "?q=" + encodeURIComponent(q))).json()).data, []);
  assert.equal((await productRequest(customerEmployee, "?q=&status=all&page=1&pageSize=20")).status, 200);
  for (const query of ["page=0", "page=1.5", "page=100001", "pageSize=101", "pageSize=0", "page=NaN", "status=bad"]) assert.equal((await productRequest(customerEmployee, "?" + query)).status, 400);
});
test("products: concurrent retries create exactly one product and audit; changed payload conflicts", async () => {
  const key = randomUUID(); const input = productInput();
  const send = body => productRequest(customerAdmin, "", "POST", body, { "Idempotency-Key": key });
  const responses = await Promise.all([send(input), send(input)]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 201]);
  const bodies = await Promise.all(responses.map(row => row.json()));
  assert.equal(bodies[0].data.id, bodies[1].data.id);
  assert.equal((await send({ ...input, current_price_kurus: 2000 })).status, 409);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM products WHERE name=?", [input.name]))[0].count, 1);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type='product' AND entity_id=?", [bodies[0].data.id]))[0].count, 1);
  assert.equal((await productRequest(customerAdmin, "", "POST", input, { "Idempotency-Key": "invalid" })).status, 400);
});
test("products: audit captures admin actor, actions and changed field names without credentials", async () => {
  const rows = await sql("SELECT * FROM audit_logs WHERE entity_type='product' AND entity_id=?", [managedProduct.id]);
  assert.equal(rows.filter(row => row.action === "product.created").length, 1);
  assert.equal(rows.filter(row => row.action === "product.updated").length, 2);
  for (const row of rows) {
    assert.equal(row.actor_user_id, customerAdmin.data.user.id);
    assert.ok(JSON.parse(row.metadata).fields.length > 0);
    assert.ok(!row.metadata.includes(customerAdmin.cookie));
  }
  assert.ok(rows.some(row => row.action === "product.updated" && JSON.parse(row.metadata).fields.includes("current_price_kurus")));
});
test("products: CSRF, exact origin and PATCH preflight remain enforced", async () => {
  assert.equal((await productRequest(customerAdmin, "", "POST", productInput(), { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await productRequest(customerAdmin, "/" + managedProduct.id, "PATCH", { name: "Blocked" }, { Origin: "https://untrusted.test" })).status, 403);
  const preflight = await request("/api/v1/products/" + managedProduct.id, { method: "OPTIONS", headers: { Origin: origin,
    "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type,x-csrf-token,idempotency-key" } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.ok(preflight.headers.get("access-control-allow-methods").includes("PATCH"));
});
test("products: audit failure rolls back both create and update atomically", async () => {
  const before = (await (await productRequest(customerAdmin, "/" + managedProduct.id)).json()).data;
  await sql("CREATE TRIGGER test_reject_product_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='product' BEGIN SELECT RAISE(ABORT, 'isolated audit failure'); END");
  try {
    const response = await productRequest(customerAdmin, "/" + managedProduct.id, "PATCH", { current_price_kurus: 1 });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SQL|stack|isolated audit failure/);
    const input = productInput(); assert.equal((await productRequest(customerAdmin, "", "POST", input)).status, 500);
    assert.equal((await sql("SELECT COUNT(*) AS count FROM products WHERE name=?", [input.name]))[0].count, 0);
  } finally { await sql("DROP TRIGGER test_reject_product_audit"); }
  assert.deepEqual((await (await productRequest(customerAdmin, "/" + managedProduct.id)).json()).data, before);
});
test("products: catalog price/name changes preserve historical sale snapshots", async () => {
  const sale = randomUUID(); const item = randomUUID(); const now = new Date().toISOString();
  await sql("INSERT INTO sales(id,customer_id,created_by,total_kurus,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    [sale, managedCustomer.id, customerAdmin.data.user.id, 15000, randomUUID(), now, now]);
  await sql("INSERT INTO sale_items(id,sale_id,product_id,product_name_snapshot,unit_price_kurus,quantity,line_total_kurus) VALUES(?,?,?,?,?,1,?)",
    [item, sale, managedProduct.id, managedProduct.name, 15000, 15000]);
  const before = await sql("SELECT * FROM sale_items WHERE id=?", [item]);
  assert.equal((await productRequest(customerAdmin, "/" + managedProduct.id, "PATCH", { name: "Güncel " + randomUUID(), current_price_kurus: 22000 })).status, 200);
  assert.deepEqual(await sql("SELECT * FROM sale_items WHERE id=?", [item]), before);
  assert.equal((await sql("SELECT total_kurus FROM sales WHERE id=?", [sale]))[0].total_kurus, 15000);
});
test("products: database errors stay errors, never fabricated or empty-success data", async () => {
  const response = await productRequest(customerEmployee, "", "GET", undefined, { "X-Test-Mode": "product-db-error" });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: "INTERNAL_ERROR", message: "İstek işlenemedi." } });
});

let saleCustomer, saleProduct, otherSaleProduct, partialSale;
function saleRequest(auth, path = "", method = "GET", body, headers = {}) {
  return request("/api/v1/sales" + path, { method, headers: { Cookie: auth.cookie, Origin: origin,
    ...(method === "POST" ? { "Content-Type": "application/json", "X-CSRF-Token": auth.data.csrfToken, "Idempotency-Key": randomUUID() } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const saleInput = (amount = 0, method = null) => ({ customer_id: saleCustomer.id,
  items: [{ product_id: saleProduct.id, quantity: 2 }], payment: { amount_kurus: amount, method } });
test("sales: unauthenticated access is rejected; isolated customer's history is empty", async () => {
  saleCustomer = (await (await customerRequest(customerEmployee, "", "POST", customerInput())).json()).data;
  saleProduct = (await (await productRequest(customerAdmin, "", "POST", { ...productInput(), current_price_kurus: 25000 })).json()).data;
  otherSaleProduct = (await (await productRequest(customerAdmin, "", "POST", { ...productInput(), current_price_kurus: 10000 })).json()).data;
  assert.equal((await request("/api/v1/sales")).status, 401);
  assert.equal((await request("/api/v1/sales", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(saleInput()) })).status, 401);
  assert.deepEqual((await (await saleRequest(customerEmployee, "?customer_id=" + saleCustomer.id)).json()).data, []);
});
test("sales: employee creates fully paid cash sale with server prices and snapshots", async () => {
  const response = await saleRequest(customerEmployee, "", "POST", { ...saleInput(50000, "cash"), total_kurus: 1,
    items: [{ product_id: saleProduct.id, quantity: 2, unit_price_kurus: 1, line_total_kurus: 2 }] });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.total_kurus, 50000); assert.equal(data.paid_kurus, 50000); assert.equal(data.remaining_kurus, 0);
  assert.equal(data.status, "completed"); assert.equal(data.payment_status, "paid");
  assert.equal(data.created_by, customerEmployee.data.user.id);
  assert.equal(data.items[0].unit_price_kurus, 25000); assert.equal(data.items[0].product_name_snapshot, saleProduct.name);
  assert.equal(data.payments.length, 1); assert.equal(data.payments[0].method, "cash"); assert.equal(data.payments[0].is_initial, true);
});
test("sales: 500 TL total and 100 TL card payment produce exactly 400 TL debt", async () => {
  const response = await saleRequest(customerAdmin, "", "POST", saleInput(10000, "card"));
  assert.equal(response.status, 201); partialSale = (await response.json()).data;
  assert.equal(partialSale.total_kurus, 50000); assert.equal(partialSale.paid_kurus, 10000); assert.equal(partialSale.remaining_kurus, 40000);
  assert.equal(partialSale.payment_status, "partial"); assert.equal(partialSale.payments[0].method, "card");
});
test("sales: credit creates no payment; multi-product bank payment retains separate lines", async () => {
  const credit = await saleRequest(customerEmployee, "", "POST", saleInput());
  assert.equal(credit.status, 201); const data = (await credit.json()).data;
  assert.equal(data.payment_status, "credit"); assert.equal(data.remaining_kurus, 50000); assert.deepEqual(data.payments, []);
  assert.equal((await sql("SELECT count(*) AS n FROM payments WHERE sale_id=?", [data.id]))[0].n, 0);
  const multi = await saleRequest(customerEmployee, "", "POST", { ...saleInput(20000, "bank"), items: [
    { product_id: saleProduct.id, quantity: 2 }, { product_id: otherSaleProduct.id, quantity: 3 }] });
  assert.equal(multi.status, 201); const result = (await multi.json()).data;
  assert.equal(result.total_kurus, 80000); assert.equal(result.remaining_kurus, 60000); assert.equal(result.items.length, 2);
  assert.equal(result.payments[0].method, "bank");
});
test("sales: zero-price product is valid; quantity, payment and safe-integer bounds are enforced", async () => {
  const before = (await sql("SELECT count(*) AS n FROM sales"))[0].n;
  for (const body of [
    { ...saleInput(), items: [] }, ...[0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1].map(quantity => ({ ...saleInput(), items: [{ product_id: saleProduct.id, quantity }] })),
    ...[-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map(amount_kurus => ({ ...saleInput(), payment: { amount_kurus, method: "cash" } })),
    { ...saleInput(), payment: { amount_kurus: 1 } }, { ...saleInput(), payment: { amount_kurus: 1, method: "crypto" } },
    { ...saleInput(), items: [{ product_id: saleProduct.id, quantity: 1 }, { product_id: saleProduct.id, quantity: 2 }] },
  ]) assert.equal((await saleRequest(customerEmployee, "", "POST", body)).status, 400);
  assert.equal((await saleRequest(customerEmployee, "", "POST", saleInput(50001, "cash"))).status, 422);
  assert.equal((await saleRequest(customerEmployee, "", "POST", { ...saleInput(), items: [{ product_id: saleProduct.id, quantity: Number.MAX_SAFE_INTEGER }] })).status, 422);
  assert.equal((await sql("SELECT count(*) AS n FROM sales"))[0].n, before);
  const free = (await (await productRequest(customerAdmin, "", "POST", { ...productInput(), current_price_kurus: 0 })).json()).data;
  const response = await saleRequest(customerEmployee, "", "POST", { ...saleInput(), items: [{ product_id: free.id, quantity: 1 }] });
  assert.equal(response.status, 201); assert.equal((await response.json()).data.total_kurus, 0);
});
test("sales: sum overflow and line overflow reject safely before multiplication/storage", async () => {
  const huge = (await (await productRequest(customerAdmin, "", "POST", { ...productInput(), current_price_kurus: Number.MAX_SAFE_INTEGER })).json()).data;
  for (const items of [[{ product_id: huge.id, quantity: 2 }], [{ product_id: huge.id, quantity: 1 }, { product_id: saleProduct.id, quantity: 1 }]]) {
    assert.equal((await saleRequest(customerEmployee, "", "POST", { ...saleInput(), items })).status, 422);
  }
  const valid = await saleRequest(customerEmployee, "", "POST", { ...saleInput(), items: [{ product_id: huge.id, quantity: 1 }] });
  assert.equal(valid.status, 201); assert.equal((await valid.json()).data.total_kurus, Number.MAX_SAFE_INTEGER);
});
test("sales: inactive/missing products and inactive/missing customers reject all writes", async () => {
  await productRequest(customerAdmin, "/" + otherSaleProduct.id, "PATCH", { is_active: false });
  for (const product_id of [otherSaleProduct.id, randomUUID()]) assert.equal((await saleRequest(customerEmployee, "", "POST", { ...saleInput(), items: [{ product_id, quantity: 1 }] })).status, 422);
  await productRequest(customerAdmin, "/" + otherSaleProduct.id, "PATCH", { is_active: true });
  assert.equal((await saleRequest(customerEmployee, "", "POST", { ...saleInput(), customer_id: randomUUID() })).status, 422);
  await customerRequest(customerAdmin, "/" + saleCustomer.id, "PATCH", { is_active: false });
  assert.equal((await saleRequest(customerEmployee, "", "POST", saleInput())).status, 422);
  await customerRequest(customerAdmin, "/" + saleCustomer.id, "PATCH", { is_active: true });
});
test("sales: price/name edits never change historical item snapshots or debt", async () => {
  await productRequest(customerAdmin, "/" + saleProduct.id, "PATCH", { name: "Yeni ad " + randomUUID(), current_price_kurus: 30000 });
  const response = await saleRequest(customerAdmin, "/" + partialSale.id);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, partialSale);
  await productRequest(customerAdmin, "/" + saleProduct.id, "PATCH", { current_price_kurus: 25000 });
});
test("sales: concurrent idempotent retries commit one sale, items, initial payment and audit", async () => {
  const key = randomUUID(); const input = saleInput(10000, "cash");
  const send = body => saleRequest(customerEmployee, "", "POST", body, { "Idempotency-Key": key });
  const responses = await Promise.all(Array.from({ length: 4 }, () => send(input)));
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 200, 200, 201]);
  const bodies = await Promise.all(responses.map(row => row.json())); const id = bodies[0].data.id;
  assert.ok(bodies.every(row => row.data.id === id));
  assert.equal((await sql("SELECT count(*) AS n FROM sale_items WHERE sale_id=?", [id]))[0].n, 1);
  assert.equal((await sql("SELECT count(*) AS n FROM payments WHERE sale_id=?", [id]))[0].n, 1);
  assert.equal((await sql("SELECT count(*) AS n FROM audit_logs WHERE entity_type='sale' AND entity_id=?", [id]))[0].n, 1);
  assert.equal((await send({ ...input, payment: { amount_kurus: 9000, method: "cash" } })).status, 409);
  await productRequest(customerAdmin, "/" + saleProduct.id, "PATCH", { is_active: false });
  assert.equal((await send(input)).status, 200); // Retry must not revalidate/reprice an already committed sale.
  await productRequest(customerAdmin, "/" + saleProduct.id, "PATCH", { is_active: true });
  assert.equal((await saleRequest(customerEmployee, "", "POST", input, { "Idempotency-Key": "bad" })).status, 400);
});
test("sales: distinct concurrent keys create independent consistent sales", async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => saleRequest(customerEmployee, "", "POST", saleInput())));
  assert.ok(responses.every(row => row.status === 201));
  const bodies = await Promise.all(responses.map(row => row.json()));
  assert.equal(new Set(bodies.map(row => row.data.id)).size, 5);
  assert.ok(bodies.every(row => row.data.total_kurus === row.data.items.reduce((sum, item) => sum + item.line_total_kurus, 0)));
});
test("sales: concurrent price/active changes cannot mix header and snapshot states", async () => {
  for (let index = 0; index < 6; index++) {
    await productRequest(customerAdmin, "/" + otherSaleProduct.id, "PATCH", { current_price_kurus: 10000, is_active: true });
    const [sale, patch] = await Promise.all([
      saleRequest(customerEmployee, "", "POST", { ...saleInput(), items: [{ product_id: otherSaleProduct.id, quantity: 3 }] }),
      productRequest(customerAdmin, "/" + otherSaleProduct.id, "PATCH", { current_price_kurus: 12000, is_active: index % 2 === 0 }),
    ]);
    assert.equal(patch.status, 200); assert.ok([201, 422].includes(sale.status));
    if (sale.status === 201) {
      const { data } = await sale.json();
      assert.ok([10000, 12000].includes(data.items[0].unit_price_kurus));
      assert.equal(data.total_kurus, data.items[0].unit_price_kurus * 3); assert.equal(data.total_kurus, data.items[0].line_total_kurus);
    }
  }
  await productRequest(customerAdmin, "/" + otherSaleProduct.id, "PATCH", { current_price_kurus: 10000, is_active: true });
});
test("sales: failure at items, payment or audit rolls back ALL financial writes", async () => {
  const counts = () => sql("SELECT (SELECT count(*) FROM sales) AS sales, (SELECT count(*) FROM sale_items) AS items, (SELECT count(*) FROM payments) AS payments, (SELECT count(*) FROM audit_logs) AS audits");
  for (const table of ["sale_items", "payments", "audit_logs"]) {
    const before = await counts();
    await sql(`CREATE TRIGGER test_sale_failure BEFORE INSERT ON ${table} ${table === "audit_logs" ? "WHEN NEW.entity_type='sale'" : ""} BEGIN SELECT RAISE(ABORT, 'isolated failure'); END`);
    try {
      const response = await saleRequest(customerEmployee, "", "POST", saleInput(10000, "cash"));
      assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SQL|stack|isolated failure/);
    } finally { await sql("DROP TRIGGER test_sale_failure"); }
    assert.deepEqual(await counts(), before);
  }
});
test("sales: audit has actor/action/entity and digest without credentials", async () => {
  const rows = await sql("SELECT * FROM audit_logs WHERE entity_type='sale' AND entity_id=?", [partialSale.id]);
  assert.equal(rows.length, 1); assert.equal(rows[0].action, "sale.created"); assert.equal(rows[0].actor_user_id, customerAdmin.data.user.id);
  assert.match(JSON.parse(rows[0].metadata).request_hash, /^[a-f0-9]{64}$/);
  assert.ok(!rows[0].metadata.includes(customerAdmin.cookie));
});
test("sales: cash/card/bank remain distinct; no cash total contains card/bank", async () => {
  const receipts = await sql("SELECT method, sum(amount_kurus) AS amount FROM payments WHERE sale_id IN (SELECT id FROM sales WHERE customer_id=?) GROUP BY method", [saleCustomer.id]);
  assert.ok(receipts.some(row => row.method === "cash" && row.amount >= 50000));
  assert.ok(receipts.some(row => row.method === "card" && row.amount === 10000));
  assert.ok(receipts.some(row => row.method === "bank" && row.amount === 20000));
  const cash = (await sql("SELECT sum(amount_kurus) AS amount FROM payments WHERE method='cash' AND sale_id IN (SELECT id FROM sales WHERE customer_id=?)", [saleCustomer.id]))[0].amount;
  assert.equal(cash, receipts.find(row => row.method === "cash").amount);
});
test("sales: customer/date filters, pagination, UTC boundaries and validation", async () => {
  const query = `?customer_id=${saleCustomer.id}&pageSize=2`;
  const first = await (await saleRequest(customerEmployee, query)).json();
  assert.equal(first.data.length, 2); assert.ok(first.data.every(row => row.customer_id === saleCustomer.id));
  const second = await (await saleRequest(customerEmployee, query + "&page=2")).json();
  assert.equal(second.pagination.total, first.pagination.total); assert.ok(!second.data.some(row => first.data.some(other => other.id === row.id)));
  const from = partialSale.created_at; const to = new Date(Date.parse(from) + 1).toISOString();
  const atTime = await (await saleRequest(customerAdmin, `?from=${from}&to=${to}`)).json();
  assert.ok(atTime.data.some(row => row.id === partialSale.id));
  assert.deepEqual((await (await saleRequest(customerEmployee, "?from=2100-01-01T00:00:00.000Z")).json()).data, []);
  for (const invalid of ["page=0", "pageSize=101", "from=bad", "customer_id=bad", "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z"]) assert.equal((await saleRequest(customerEmployee, "?" + invalid)).status, 400);
  assert.equal((await saleRequest(customerEmployee, "/bad-id")).status, 400);
  assert.equal((await saleRequest(customerEmployee, "/" + randomUUID())).status, 404);
});
test("sales: CSRF/origin enforced; edit/delete/cancellation absent and payments protected", async () => {
  assert.equal((await saleRequest(customerEmployee, "", "POST", saleInput(), { "X-CSRF-Token": "bad" })).status, 403);
  assert.equal((await saleRequest(customerEmployee, "", "POST", saleInput(), { Origin: "https://untrusted.test" })).status, 403);
  for (const method of ["PATCH", "DELETE"]) assert.equal((await saleRequest(customerEmployee, "/" + partialSale.id, method, undefined, { "X-CSRF-Token": customerEmployee.data.csrfToken })).status, 404);
  assert.equal((await saleRequest(customerEmployee, "/" + partialSale.id + "/cancel", "POST", {})).status, 400);
  assert.equal((await request("/api/v1/payments")).status, 401);
  const response = await saleRequest(customerEmployee, "", "GET", undefined, { "X-Test-Mode": "sale-db-error" });
  assert.equal(response.status, 500); assert.ok(!('data' in await response.json()));
});
test("sales: existing valid later receipts and full reversals affect debt, never the snapshot total", async () => {
  const now = new Date().toISOString(); const payment = randomUUID(); const initial = partialSale.payments[0];
  await sql("INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)",
    [payment, saleCustomer.id, partialSale.id, 5000, "cash", customerEmployee.data.user.id, randomUUID(), now]);
  let result = (await (await saleRequest(customerAdmin, "/" + partialSale.id)).json()).data;
  assert.equal(result.total_kurus, 50000); assert.equal(result.paid_kurus, 15000); assert.equal(result.remaining_kurus, 35000);
  assert.ok(result.payments.some(row => row.id === payment && !row.is_initial));
  await sql("INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [randomUUID(), saleCustomer.id, partialSale.id, initial.amount_kurus, initial.method, customerAdmin.data.user.id, randomUUID(), initial.id, now]);
  result = (await (await saleRequest(customerAdmin, "/" + partialSale.id)).json()).data;
  assert.equal(result.paid_kurus, 5000); assert.equal(result.remaining_kurus, 45000); assert.equal(result.payments.length, 1);
  assert.equal((await sql("SELECT count(*) AS n FROM payments WHERE sale_id=?", [partialSale.id]))[0].n, 3); // History preserved.
});
test("sales: employees share all company sales without gaining mutation permissions", async () => {
  assert.equal((await saleRequest(customerEmployee, "/" + partialSale.id)).status, 200);
  const own = await (await saleRequest(customerEmployee, "?customer_id=" + saleCustomer.id + "&pageSize=100")).json();
  assert.ok(own.data.some(row => row.created_by === customerEmployee.data.user.id));
  assert.ok(own.data.some(row => row.id === partialSale.id));
  const all = await (await saleRequest(customerAdmin, "?customer_id=" + saleCustomer.id + "&pageSize=100")).json();
  assert.ok(all.data.some(row => row.id === partialSale.id));
  assert.equal(all.pagination.total, own.pagination.total);
  const reader = await session(await fixture());
  assert.equal((await (await saleRequest(reader, "?customer_id=" + saleCustomer.id)).json()).pagination.total, all.pagination.total);
  assert.equal((await saleRequest(reader, "/" + own.data[0].id)).status, 200);
});

registerFinanceTests({ request, sql, origin, admin: () => customerAdmin, employee: () => customerEmployee,
  customerRequest, productRequest, saleRequest, fixture, session });
registerCorrectionTests({ request, sql, origin, admin: () => customerAdmin, employee: () => customerEmployee,
  customerRequest, productRequest, saleRequest, fixture, session });
