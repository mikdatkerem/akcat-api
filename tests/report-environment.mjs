import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { hashPassword } from '../src/security/password.ts'

export async function reportEnvironment({ migrations = ['0001_initial_schema.sql', '0002_financial_adjustments.sql'] } = {}) {
  assert.ok(migrations.every(file => ['0001_initial_schema.sql', '0002_financial_adjustments.sql'].includes(file)))
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..'), guard = randomBytes(32).toString('hex')
  const config = JSON.parse(await readFile(join(project, 'tests/wrangler.jsonc'), 'utf8'))
  assert.equal(config.d1_databases?.[0]?.database_id, '11111111-1111-4111-8111-111111111111', 'isolated test database identity')
  const temporary = await mkdtemp(join(tmpdir(), 'akcat-reports-test-')), origin = 'http://localhost:5173'
  const socket = createServer(); await new Promise(done => socket.listen(0, '127.0.0.1', done)); const port = socket.address().port
  await new Promise(done => socket.close(done))
  const child = spawn(process.execPath, [join(project, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', join(project, 'tests/wrangler.jsonc'),
    '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', join(temporary, 'state'),
    '--var', 'TEST_KEY:' + guard, '--show-interactive-dev-session', 'false'], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  child.stdout.resume(); child.stderr.resume()
  async function close() {
    if (child.exitCode === null) { const stopped = new Promise(done => child.once('exit', done)); child.kill(); await Promise.race([stopped, delay(10000, undefined, { ref: false })]) }
    const target = await realpath(temporary), parent = await realpath(tmpdir())
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase()); assert.ok(target.toLowerCase().startsWith((parent + sep + 'akcat-reports-test-').toLowerCase()))
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  const request = (path, { headers = {}, ...options } = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { 'X-Test-Key': guard, ...headers } })
  const sql = async (sql, params = []) => {
    const result = await request('/__test/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params }) })
    assert.equal(result.status, 200); return (await result.json()).results
  }
  async function fixture(role = 'employee') {
    const id = randomUUID(), username = 'report_' + randomBytes(6).toString('hex'), password = randomBytes(24).toString('base64url'), now = new Date().toISOString()
    await sql('INSERT INTO users(id,username,password_hash,role,is_active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)', [id, username, await hashPassword(password), role, now, now])
    const response = await request('/api/v1/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    assert.equal(response.status, 200)
    return { cookie: response.headers.get('set-cookie').split(';')[0], data: await response.json() }
  }
  const read = (auth, path, headers = {}) => request(path, { headers: { Cookie: auth.cookie, Origin: origin, ...headers } })
  const write = (auth, path, body, method = 'POST', headers = {}) => request(path, { method, headers: { Cookie: auth.cookie, Origin: origin, 'Content-Type': 'application/json',
    'X-CSRF-Token': auth.data.csrfToken, 'Idempotency-Key': randomUUID(), ...headers }, body: JSON.stringify(body) })
  try {
    let ready = false
    for (let attempt = 0; attempt < 160; attempt++) {
      if (child.exitCode !== null) throw new Error('Isolated report Worker stopped')
      try { if ((await request('/api/health')).ok) { ready = true; break } } catch { /* starting */ }
      await delay(250)
    }
    assert.ok(ready)
    const response = await request('/__test/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: (await Promise.all(migrations.map(file => readFile(join(project, 'migrations', file), 'utf8')))).join('\n') }) })
    assert.equal(response.status, 200)
    return { close, request, sql, fixture, read, write }
  } catch (error) { await close(); throw error }
}
