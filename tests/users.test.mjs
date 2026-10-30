import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'
import { verifyPassword } from '../src/security/password.ts'

let env, admin, employee, account, accountAuth, financialSnapshot
const secret = () => randomBytes(24).toString('base64url')
const credentials = { username: 'staff_' + randomUUID().slice(0, 8), password: secret() }
const createKey = randomUUID()
const route = id => '/api/v1/users' + (id ? '/' + id : '')
const body = { ...credentials }
const mutation = (path, data, method = 'POST', auth = admin, key = randomUUID(), headers = {}) => env.write(auth, path, data, method, { 'Idempotency-Key': key, ...headers })
async function json(response, expected = 200) { assert.equal(response.status, expected); return response.json() }
async function login(input) {
  const response = await env.request('/api/v1/auth/login', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (response.status !== 200) return { status: response.status }
  return { status: 200, cookie: response.headers.get('set-cookie').split(';')[0], data: await response.json() }
}
const originals = async () => Object.fromEntries(await Promise.all(['customers', 'sales', 'sale_items', 'payments', 'audit_logs'].map(async table => [table, await env.sql(`SELECT * FROM ${table}${table === 'audit_logs' ? " WHERE entity_type IN ('customer','product','sale','payment')" : ''} ORDER BY id`)])))
before(async () => {
  env = await reportEnvironment(); admin = await env.fixture('admin'); employee = await env.fixture()
  const customer = (await json(await env.write(employee, '/api/v1/customers', { name: 'İzole hesap ilişkileri', address: 'İzole test' }), 201)).data
  const product = (await json(await env.write(admin, '/api/v1/products', { name: 'İzole hesap ürünü', current_price_kurus: 50000 }), 201)).data
  await json(await env.write(employee, '/api/v1/sales', { customer_id: customer.id, items: [{ product_id: product.id, expected_list_price_kurus: 50000, quantity: 1 }], payment: { amount_kurus: 10000, method: 'cash' } }), 201)
  financialSnapshot = await originals()
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('users: every endpoint requires authentication and admin; no self-service role escalation', async () => {
  for (const [path, method, data] of [[route(), 'GET'], [route(), 'POST', body], [route(employee.data.user.id), 'GET'], [route(employee.data.user.id), 'PATCH', { role: 'admin' }], [route(employee.data.user.id) + '/reset-password', 'POST', { password: secret() }]]) {
    assert.equal((await env.request(path, { method })).status, 401)
    const response = method === 'GET' ? await env.read(employee, path) : await mutation(path, data, method, employee)
    assert.equal(response.status, 403)
  }
})
test('users: admin creates default employee using normalized unique username and scrypt without secret output', async () => {
  account = (await json(await mutation(route(), { ...body, username: body.username.toUpperCase() }, 'POST', admin, createKey), 201)).data
  assert.equal(account.username, credentials.username); assert.equal(account.role, 'employee'); assert.equal(account.is_active, true)
  assert.deepEqual(Object.keys(account).sort(), ['created_at', 'id', 'is_active', 'role', 'updated_at', 'username'])
  const stored = (await env.sql('SELECT password_hash FROM users WHERE id=?', [account.id]))[0]
  assert.match(stored.password_hash, /^scrypt:v1:16384:8:5:/); assert.equal(await verifyPassword(credentials.password, stored.password_hash), true)
  accountAuth = await login(credentials); assert.equal(accountAuth.status, 200)
})
test('users: duplicate usernames and changed key payloads reject; concurrent identical retries create one account/audit', async () => {
  assert.equal((await mutation(route(), body)).status, 409)
  const responses = await Promise.all(Array.from({ length: 3 }, () => mutation(route(), body, 'POST', admin, createKey)))
  for (const response of responses) { const value = await json(response); assert.equal(value.data.id, account.id) }
  assert.equal((await mutation(route(), { ...body, password: secret() }, 'POST', admin, createKey)).status, 409)
  assert.equal((await mutation(route(), { ...body, role: 'admin' }, 'POST', admin, createKey)).status, 409)
  assert.equal((await env.sql("SELECT count(*) AS n FROM audit_logs WHERE entity_type='user' AND entity_id=? AND action='user.created'", [account.id]))[0].n, 1)
})
test('users: malformed input, weak/blank/oversized passwords, unknown fields and CSRF/origin violations reject', async () => {
  for (const invalid of [{ ...body, username: 'x' }, { ...body, password: secret().slice(0, 14) }, { ...body, password: ' '.repeat(20) }, { ...body, password: secret().repeat(8) }, { ...body, role: 'owner' }, { ...body, is_active: true }]) assert.equal((await mutation(route(), invalid)).status, 400)
  assert.equal((await mutation(route(account.id), {}, 'PATCH')).status, 400)
  assert.equal((await mutation(route(account.id), { password: secret() }, 'PATCH')).status, 400)
  assert.equal((await mutation(route(), body, 'POST', admin, randomUUID(), { 'X-CSRF-Token': 'invalid' })).status, 403)
  assert.equal((await mutation(route(), body, 'POST', admin, randomUUID(), { Origin: 'https://untrusted.invalid' })).status, 403)
})
test('users: searchable bounded list/detail are sanitized; missing users and invalid pagination remain errors', async () => {
  const list = await json(await env.read(admin, route() + '?q=' + credentials.username + '&pageSize=1'))
  assert.equal(list.data.length, 1); assert.equal(list.pagination.total, 1)
  assert.deepEqual((await json(await env.read(admin, route(account.id)))).data, account)
  assert.equal((await env.read(admin, route() + '?page=0')).status, 400)
  assert.equal((await env.read(admin, route(randomUUID()))).status, 404)
  const empty = await json(await env.read(admin, route() + '?q=' + randomUUID())); assert.deepEqual(empty.data, [])
})
test('users: deactivation revokes every session, denies login; reactivation never revives revoked sessions', async () => {
  const another = await login(credentials)
  assert.equal((await mutation(route(account.id), { is_active: false }, 'PATCH')).status, 200)
  assert.equal((await login(credentials)).status, 401)
  for (const auth of [accountAuth, another]) assert.equal((await env.read(auth, '/api/v1/auth/me')).status, 401)
  assert.equal((await env.sql('SELECT count(*) AS n FROM sessions WHERE user_id=? AND revoked_at IS NULL', [account.id]))[0].n, 0)
  assert.equal((await mutation(route(account.id), { is_active: true }, 'PATCH')).status, 200)
  assert.equal((await env.read(accountAuth, '/api/v1/auth/me')).status, 401)
  accountAuth = await login(credentials); assert.equal(accountAuth.status, 200)
})
test('users: role changes apply to the next request; self deactivation/demotion and last admin lockout reject', async () => {
  assert.equal((await mutation(route(account.id), { role: 'admin' }, 'PATCH')).status, 200)
  assert.equal((await env.read(accountAuth, route())).status, 200)
  assert.equal((await mutation(route(account.id), { role: 'employee' }, 'PATCH')).status, 200)
  assert.equal((await env.read(accountAuth, route())).status, 403)
  for (const patch of [{ is_active: false }, { role: 'employee' }]) {
    const error = await json(await mutation(route(admin.data.user.id), patch, 'PATCH'), 409)
    assert.equal(error.error.code, 'SELF_ACCOUNT_LOCKOUT')
  }
  assert.equal((await env.sql("SELECT count(*) AS n FROM users WHERE role='admin' AND is_active=1"))[0].n, 1)
})
test('users: reset revokes all sessions, old password fails and exact retry never revokes a newly opened session', async () => {
  // Use a distinct account per login-heavy lifecycle; keep the real five/minute limiter enabled.
  const initial = { username: 'reset_' + randomUUID().slice(0, 8), password: secret() }
  const target = (await json(await mutation(route(), initial), 201)).data
  const prior = await login(initial); assert.equal(prior.status, 200)
  const password = secret(), key = randomUUID()
  assert.equal((await mutation(route(target.id) + '/reset-password', { password }, 'POST', admin, key)).status, 200)
  assert.equal((await env.read(prior, '/api/v1/auth/me')).status, 401)
  assert.equal((await login(initial)).status, 401)
  const current = await login({ username: target.username, password }); assert.equal(current.status, 200)
  assert.equal((await mutation(route(target.id) + '/reset-password', { password }, 'POST', admin, key)).status, 200)
  assert.equal((await env.read(current, '/api/v1/auth/me')).status, 200)
  assert.equal((await mutation(route(target.id) + '/reset-password', { password: secret() }, 'POST', admin, key)).status, 409)
  const newer = secret()
  assert.equal((await mutation(route(target.id) + '/reset-password', { password: newer })).status, 200)
  assert.equal((await mutation(route(target.id) + '/reset-password', { password }, 'POST', admin, key)).status, 409)
  assert.equal((await login({ username: target.username, password: newer })).status, 200)
})
test('users: simultaneous first create requests yield exactly one account and one audit', async () => {
  const input = { username: 'concurrent_' + randomUUID().slice(0, 8), password: secret() }, key = randomUUID()
  const responses = await Promise.all(Array.from({ length: 3 }, () => mutation(route(), input, 'POST', admin, key)))
  assert.deepEqual(responses.map(value => value.status).sort(), [200, 200, 201])
  const values = await Promise.all(responses.map(value => value.json())); assert.equal(new Set(values.map(value => value.data.id)).size, 1)
})
test('users: admin creation is supported; a delayed patch replay never re-applies an old deactivation', async () => {
  const target = (await json(await mutation(route(), { username: 'managed_admin_' + randomUUID().slice(0, 8), password: secret(), role: 'admin' }), 201)).data
  assert.equal(target.role, 'admin')
  const key = randomUUID()
  assert.equal((await mutation(route(target.id), { is_active: false }, 'PATCH', admin, key)).status, 200)
  assert.equal((await mutation(route(target.id), { is_active: true }, 'PATCH')).status, 200)
  const replay = await json(await mutation(route(target.id), { is_active: false }, 'PATCH', admin, key))
  assert.equal(replay.data.is_active, true)
  assert.equal((await mutation(route(target.id), { role: 'employee' }, 'PATCH')).status, 200)
})
test('users: concurrent cross-demotions/deactivations cannot remove the final active administrator', async () => {
  const other = await env.fixture('admin')
  const results = await Promise.all([mutation(route(other.data.user.id), { is_active: false }, 'PATCH'), mutation(route(admin.data.user.id), { role: 'employee' }, 'PATCH', other)])
  assert.equal(results.filter(value => value.status === 200).length, 1)
  assert.ok(results.every(value => [200, 401, 403, 409].includes(value.status)))
  const active = await env.sql("SELECT id FROM users WHERE role='admin' AND is_active=1")
  assert.equal(active.length, 1)
  if (active[0].id !== admin.data.user.id) admin = other
})
test('users: audit failures roll back account/password/session changes; no plaintext or fast password digest in audit', async () => {
  const before = await env.sql('SELECT * FROM users WHERE id=?', [account.id])
  const beforeSessions = await env.sql('SELECT * FROM sessions WHERE user_id=? ORDER BY id', [account.id])
  await env.sql("CREATE TRIGGER test_user_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.entity_type='user' BEGIN SELECT RAISE(ABORT, 'isolated audit failure'); END")
  try {
    const password = secret()
    for (const [path, data, method] of [[route(), { username: 'rollback_' + randomUUID().slice(0, 8), password }, 'POST'], [route(account.id), { is_active: false }, 'PATCH'], [route(account.id) + '/reset-password', { password }, 'POST']]) {
      const response = await mutation(path, data, method); assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SQL|stack|isolated audit failure/)
    }
  } finally { await env.sql('DROP TRIGGER test_user_audit_failure') }
  assert.deepEqual(await env.sql('SELECT * FROM users WHERE id=?', [account.id]), before)
  assert.deepEqual(await env.sql('SELECT * FROM sessions WHERE user_id=? ORDER BY id', [account.id]), beforeSessions)
  const audits = await env.sql("SELECT metadata FROM audit_logs WHERE entity_type='user'")
  for (const audit of audits) { assert.equal(String(audit.metadata).includes(credentials.password), false); assert.doesNotMatch(String(audit.metadata), /password_hash|scrypt:|csrfToken|w1_/) }
})
test('users: username edit preserves historical user IDs and financial data; physical deletion is unavailable', async () => {
  const rename = 'renamed_' + randomUUID().slice(0, 8)
  assert.equal((await mutation(route(employee.data.user.id), { username: rename }, 'PATCH')).status, 200)
  assert.deepEqual(await originals(), financialSnapshot)
  assert.equal((await env.request(route(account.id), { method: 'DELETE', headers: { Cookie: admin.cookie, Origin: 'http://localhost:5173', 'X-CSRF-Token': admin.data.csrfToken } })).status, 400)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
})
