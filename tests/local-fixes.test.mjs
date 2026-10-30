import { migrationSql } from './migration-source.mjs'
import { legacyFinance } from './legacy-fixture.mjs'
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'

let env, admin, employee, customer, emptyCustomer, sale, original
const key = randomUUID()
const saved = async response => { assert.equal(response.status, 201); return (await response.json()).data }
const rows = async () => Object.fromEntries(await Promise.all(['sales', 'sale_items', 'payments', 'audit_logs'].map(async table => [table, await env.sql(`SELECT ${table === 'sales' ? 'id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at' : '*'} FROM ${table} ORDER BY id`)])))
const body = () => ({ customer_id: customer.id, sale_id: sale.id, amount_kurus: 25000, method: 'cash' })
before(async () => {
  env = await reportEnvironment({ migrations: ['0001_initial_schema.sql'] })
  admin = await env.fixture('admin'); employee = await env.fixture()
  const fixture = await legacyFinance(env, employee)
  customer = fixture.customer; sale = fixture.sale
  emptyCustomer = { id: randomUUID() }
  await env.sql('INSERT INTO customers(id,name,address,created_at,updated_at) VALUES(?,?,?,?,?)', [emptyCustomer.id, 'İzole boş geçmiş', 'Yalnızca izole test', new Date().toISOString(), new Date().toISOString()])
  original = await rows()
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('local fixes: missing 0002 yields safe schema error, never false empty/success; failed collection batch rolls back', async () => {
  for (const path of ['/api/v1/payments', '/api/v1/customers/' + emptyCustomer.id + '/ledger', '/api/v1/reports/payments', '/api/v1/reports/summary']) {
    const response = await env.read(employee, path)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: { code: 'DATABASE_SCHEMA_REQUIRED', message: 'Veritabanı güncellemesi gerekli. Sistem yöneticinizle iletişime geçin.' } })
  }
  const response = await env.write(employee, '/api/v1/payments', body(), 'POST', { 'Idempotency-Key': key })
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'DATABASE_SCHEMA_REQUIRED')
  assert.deepEqual(await rows(), original)
})

test('local fixes: additive 0002 preserves data and returns real zero-row histories', async () => {
  const response = await env.request('/__test/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: (await migrationSql()).slice((await migrationSql(['0001_initial_schema.sql'])).length) }) })
  assert.equal(response.status, 200); assert.deepEqual(await rows(), { ...original, sale_items: original.sale_items.map(row => ({ ...row, list_unit_price_kurus: null })) })
  for (const path of ['/api/v1/sales?customer_id=' + emptyCustomer.id, '/api/v1/payments', '/api/v1/customers/' + emptyCustomer.id + '/ledger', '/api/v1/customers/' + emptyCustomer.id + '/receivables', '/api/v1/reports/payments']) {
    const result = await env.read(employee, path); assert.equal(result.status, 200)
    const page = await result.json(); assert.deepEqual(page.data, []); assert.equal(page.pagination.total, 0); assert.equal(page.pagination.totalPages, 0)
  }
})

test('local fixes: same collection key succeeds after schema repair; replay, partial/full debt and validation remain safe', async () => {
  const created = await env.write(employee, '/api/v1/payments', body(), 'POST', { 'Idempotency-Key': key })
  assert.equal(created.status, 201); const receipt = (await created.json()).data
  assert.equal(receipt.amount_kurus, 25000); assert.equal(receipt.sale_remaining_kurus, 25000); assert.equal(receipt.is_valid, true)
  const replay = await env.write(employee, '/api/v1/payments', body(), 'POST', { 'Idempotency-Key': key })
  assert.equal(replay.status, 200); assert.equal((await replay.json()).data.id, receipt.id)
  for (const amount_kurus of [0, -1, 19.99, '25000']) {
    const invalid = await env.write(employee, '/api/v1/payments', { ...body(), amount_kurus })
    assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_FINANCE_INPUT')
  }
  for (const data of [{ ...body(), amount_kurus: 25001 }, { ...body(), customer_id: emptyCustomer.id }]) {
    const invalid = await env.write(employee, '/api/v1/payments', data)
    assert.equal(invalid.status, 422); assert.equal((await invalid.json()).error.code, 'PAYMENT_NOT_ALLOWED')
  }
  const denied = await env.write(employee, '/api/v1/payments', body(), 'POST', { 'X-CSRF-Token': '' })
  assert.equal(denied.status, 403)
  const full = await saved(await env.write(employee, '/api/v1/payments', body()))
  assert.equal(full.sale_remaining_kurus, 0)
  assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE sale_id=?', [sale.id]))[0].n, 2)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
})
