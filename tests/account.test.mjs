import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'
import { hashPassword, verifyPassword } from '../src/security/password.ts'

let env, admin
const path = '/api/v1/auth/change-password', me = '/api/v1/auth/me'
const secret = () => randomBytes(24).toString('base64url')
async function login(username, password) {
  const response = await env.request('/api/v1/auth/login', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  const data = await response.json()
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], data }
}
async function account(role = 'employee') {
  const id = randomUUID(), username = 'self_' + randomUUID().slice(0, 8), password = secret(), now = new Date().toISOString()
  await env.sql('INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)', [id, username, await hashPassword(password), role, now, now])
  return { id, username, password, auth: await login(username, password) }
}
const change = (user, next = secret(), current = user.password, headers = {}) => env.write(user.auth, path, { current_password: current, new_password: next }, 'POST', headers)
const count = async (sql, id) => (await env.sql(sql, [id]))[0].n
before(async () => { env = await reportEnvironment(); admin = await env.fixture('admin') }, { timeout: 60000 })
after(async () => { await env?.close() })

test('account: me provides actual authenticated username, role and active status for both roles', async () => {
  for (const role of ['admin', 'employee']) {
    const user = await account(role), response = await env.read(user.auth, me)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.deepEqual(data.user, { id: user.id, username: user.username, role }); assert.equal(data.is_active, true)
    assert.equal('password_hash' in data.user, false)
  }
})
test('account: both roles change own password; old password fails, new login succeeds, all sessions revoked, audit contains no secrets', async () => {
  for (const role of ['admin', 'employee']) {
    const user = await account(role), another = await login(user.username, user.password), next = secret()
    const response = await change(user, next)
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true })
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
    for (const auth of [user.auth, another]) assert.equal((await env.read(auth, me)).status, 401)
    assert.equal(await count('SELECT count(*) AS n FROM sessions WHERE user_id=? AND revoked_at IS NULL', user.id), 0)
    assert.equal((await login(user.username, user.password)).status, 401)
    assert.equal((await login(user.username, next)).status, 200)
    const stored = (await env.sql('SELECT password_hash FROM users WHERE id=?', [user.id]))[0].password_hash
    assert.match(stored, /^scrypt:v1:16384:8:5:/); assert.equal(await verifyPassword(next, stored), true)
    const audit = await env.sql("SELECT * FROM audit_logs WHERE action='auth.password_changed' AND entity_id=?", [user.id])
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, user.id); assert.equal(audit[0].entity_type, 'user'); assert.equal(audit[0].metadata, null)
    assert.ok(!JSON.stringify(audit).includes(user.password)); assert.ok(!JSON.stringify(audit).includes(next)); assert.ok(!JSON.stringify(audit).includes(stored))
  }
})
test('account: incorrect current password is rejected without losing session or changing password/audit', async () => {
  const user = await account(), response = await change(user, secret(), secret())
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'CURRENT_PASSWORD_INVALID')
  assert.equal((await env.read(user.auth, me)).status, 200)
  assert.equal((await login(user.username, user.password)).status, 200)
  assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='auth.password_changed'", user.id), 0)
})
test('account: weak, blank, oversized and unchanged new passwords are rejected', async () => {
  const user = await account()
  for (const next of ['short', ' '.repeat(20), secret().repeat(5), user.password]) {
    assert.equal((await change(user, next)).status, 400)
  }
  assert.equal((await env.read(user.auth, me)).status, 200)
})
test('account: employee cannot target another account through body, URL or admin reset endpoint', async () => {
  const user = await account(), other = await account(), next = secret()
  assert.equal((await env.write(user.auth, path, { current_password: user.password, new_password: next, user_id: other.id })).status, 400)
  assert.equal((await env.write(user.auth, path + '/' + other.id, { current_password: user.password, new_password: next })).status, 404)
  assert.equal((await env.write(user.auth, '/api/v1/users/' + other.id + '/reset-password', { password: next })).status, 403)
  assert.equal((await login(other.username, other.password)).status, 200)
})
test('account: authentication, Origin, CSRF, JSON and body-size protections remain enabled', async () => {
  const user = await account()
  assert.equal((await env.request(path, { method: 'POST' })).status, 401)
  assert.equal((await change(user, secret(), user.password, { 'X-CSRF-Token': 'invalid' })).status, 403)
  assert.equal((await change(user, secret(), user.password, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await change(user, secret(), user.password, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await change(user, secret().repeat(150))).status, 413)
})
test('account: password guesses are throttled per account independently of login', async () => {
  const user = await account()
  for (let i = 0; i < 5; i++) assert.equal((await change(user, secret(), secret())).status, 400)
  const response = await change(user)
  assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60')
  assert.equal((await response.json()).error.code, 'PASSWORD_CHANGE_RATE_LIMITED')
  assert.equal((await login(user.username, user.password)).status, 200)
})
test('account: concurrent password changes have one winner and one audit; stale requests cannot overwrite it', async () => {
  const user = await account(), next = [secret(), secret()]
  const responses = await Promise.all(next.map(value => change(user, value)))
  assert.equal(responses.filter(response => response.status === 200).length, 1)
  assert.ok(responses.every(response => [200, 401, 409].includes(response.status)))
  const winner = responses.findIndex(response => response.status === 200)
  assert.equal((await login(user.username, next[winner])).status, 200)
  assert.equal((await login(user.username, next[1 - winner])).status, 401)
  assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='auth.password_changed'", user.id), 1)
})
test('account: failed session revocation rolls back password and audit atomically', async () => {
  const user = await account(), next = secret()
  // Isolated D1 failure injection: no production hooks or altered authentication.
  await env.sql(`CREATE TRIGGER account_revoke_failure BEFORE UPDATE OF revoked_at ON sessions
    WHEN OLD.user_id = '${user.id}' BEGIN SELECT RAISE(ABORT, 'isolated rollback check'); END`)
  try { assert.equal((await change(user, next)).status, 500) }
  finally { await env.sql('DROP TRIGGER account_revoke_failure') }
  assert.equal((await env.read(user.auth, me)).status, 200)
  assert.equal((await login(user.username, user.password)).status, 200)
  assert.equal((await login(user.username, next)).status, 401)
  assert.equal(await count("SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='auth.password_changed'", user.id), 0)
})
test('account: admin reset and self-change races do not revive old sessions or allow old password login', async () => {
  const user = await account(), next = secret(), reset = secret()
  const [self, administrative] = await Promise.all([
    change(user, next), env.write(admin, '/api/v1/users/' + user.id + '/reset-password', { password: reset }),
  ])
  assert.equal(administrative.status, 200); assert.ok([200, 400, 401, 409].includes(self.status))
  assert.equal((await env.read(user.auth, me)).status, 401)
  assert.equal((await login(user.username, user.password)).status, 401)
  assert.equal((await login(user.username, reset)).status, 200)
  assert.equal((await login(user.username, next)).status, 401)
})
