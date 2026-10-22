import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'

let env, admin, employee, customer, product, legacy, snapshot
const saved = async response => { assert.equal(response.status, 201); return (await response.json()).data }
const read = async path => { const response = await env.read(admin, '/api/v1/' + path); assert.equal(response.status, 200); return response.json() }
const originalRows = async () => Object.fromEntries(await Promise.all(['sales', 'sale_items', 'payments', 'audit_logs'].map(async table =>
  [table, await env.sql(`SELECT * FROM ${table} ORDER BY id`)])))
const request = async (type, id) => saved(await env.write(employee, '/api/v1/correction-requests', {
  target_type: type === 'sale_cancel' ? 'sale' : 'payment', target_id: id, correction_type: type, reason: 'İzole denetim gerekçesi', requested_change: 'Denetim akışı',
}))
const approve = async row => {
  const p = row.financial_preview
  const response = await env.write(admin, '/api/v1/correction-requests/' + row.id + '/approve', { reason: 'Denetim onayı', ...(p ? {
    expected_amount_kurus: p.amount_kurus, expected_sale_remaining_kurus: p.before_sale_remaining_kurus, expected_customer_debt_kurus: p.before_customer_debt_kurus,
    ...(p.requires_external_confirmation ? { refund_confirmation: { confirmed: true, reference: randomUUID() } } : {}),
  } : {}) })
  assert.equal(response.status, 200); return (await response.json()).data
}
async function sameDebt(expected) {
  const account = await read('customers/' + customer.id + '/receivables'), ledger = await read('customers/' + customer.id + '/ledger'),
    debtors = await read('receivables'), report = await read('reports/receivables'), summary = await read('reports/summary')
  assert.equal(account.summary.total_debt_kurus, expected); assert.equal(ledger.summary.total_debt_kurus, expected)
  if (ledger.data.length) assert.equal(ledger.data[0].balance_after_kurus, expected)
  assert.equal(debtors.data.reduce((sum, row) => sum + row.total_debt_kurus, 0), expected)
  assert.equal(report.summary.total_debt_kurus, expected); assert.equal(summary.receivables.total_debt_kurus, expected)
}
before(async () => {
  env = await reportEnvironment({ migrations: ['0001_initial_schema.sql'] }); admin = await env.fixture('admin'); employee = await env.fixture()
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('audit: 0001 legacy database accepts real sales before additive 0002 upgrade', async () => {
  customer = await saved(await env.write(employee, '/api/v1/customers', { name: 'Denetim müşterisi', address: 'Yalnızca izole test' }))
  product = await saved(await env.write(admin, '/api/v1/products', { name: 'Orijinal snapshot', current_price_kurus: 50000 }))
  legacy = await saved(await env.write(employee, '/api/v1/sales', { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment: { amount_kurus: 10000, method: 'cash' } }))
  snapshot = await originalRows()
  assert.equal((await env.sql("SELECT count(*) AS n FROM sqlite_master WHERE name='financial_adjustments'"))[0].n, 0)
})
test('audit: 0002 upgrade preserves every original sale, item, receipt and audit byte-for-byte', async () => {
  const sql = await readFile(new URL('../migrations/0002_financial_adjustments.sql', import.meta.url), 'utf8')
  const response = await env.request('/__test/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) })
  assert.equal(response.status, 200); assert.deepEqual(await originalRows(), snapshot)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
  await sameDebt(40000)
  for (const path of ['sales', 'sales/' + legacy.id, 'payments', 'financial-adjustments', 'reports/payments', 'reports/sales', 'reports/employees']) await read(path)
})
test('audit: raw duplicate migration fails safely without overwriting existing data', async () => {
  const sql = await readFile(new URL('../migrations/0002_financial_adjustments.sql', import.meta.url), 'utf8')
  const response = await env.request('/__test/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) })
  assert.equal(response.status, 500); assert.deepEqual(await originalRows(), snapshot)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), []); await sameDebt(40000)
})
test('audit: complete finance chain yields identical debt on account, ledger, debt list and reports at every step', async () => {
  const later = await saved(await env.write(employee, '/api/v1/payments', { customer_id: customer.id, sale_id: legacy.id, amount_kurus: 25000, method: 'bank' }))
  await sameDebt(15000)
  await approve(await request('payment_reversal', legacy.payments[0].id)); await sameDebt(25000)
  await approve(await request('payment_refund', later.id)); await sameDebt(50000)
  await approve(await request('sale_cancel', legacy.id)); await sameDebt(0)
  const report = await read('reports/summary')
  assert.equal(report.payments.payments_total_kurus, 0); assert.equal(report.adjustments.record_reversal_kurus, 10000)
  assert.equal(report.adjustments.refund_bank_kurus, 25000); assert.equal(report.sales.cancelled_total_kurus, 50000)
  const original = (await env.sql('SELECT * FROM payments WHERE id=?', [legacy.payments[0].id]))[0]
  assert.deepEqual(original, snapshot.payments[0]); assert.deepEqual(await env.sql('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [legacy.id]), snapshot.sale_items)
})
test('audit: foreign keys and unique original-payment/request/refund constraints remain enforced', async () => {
  const invalid = await env.request('/__test/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    sql: 'INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', params: [randomUUID(), randomUUID(), new Date().toISOString(), new Date().toISOString()],
  }) })
  assert.equal(invalid.status, 500)
  const duplicate = await env.request('/__test/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    sql: 'INSERT INTO financial_adjustments SELECT ?,' + ['correction_request_id','payment_id','reversal_payment_id','sale_id','customer_id','kind','amount_kurus','method','reason','requested_by','performed_by','approved_by','before_sale_remaining_kurus','after_sale_remaining_kurus','before_customer_debt_kurus','after_customer_debt_kurus','external_reference','external_confirmed_at','created_at'].join(',') + ' FROM financial_adjustments LIMIT 1', params: [randomUUID()],
  }) })
  assert.equal(duplicate.status, 500); assert.equal((await env.sql('SELECT count(*) AS n FROM financial_adjustments'))[0].n, 2)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
})
test('audit: four concurrent collections cannot overpay; snapshot and cross-screen balance stay consistent', async () => {
  const sale = await saved(await env.write(employee, '/api/v1/sales', { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment: { amount_kurus: 0, method: null } }))
  const responses = await Promise.all(Array.from({ length: 4 }, () => env.write(employee, '/api/v1/payments', { customer_id: customer.id, sale_id: sale.id, amount_kurus: 15000, method: 'card' })))
  assert.deepEqual(responses.map(row => row.status).sort(), [201, 201, 201, 422]); await sameDebt(5000)
  assert.equal((await env.write(admin, '/api/v1/products/' + product.id, { name: 'Yeni katalog', current_price_kurus: 1999 }, 'PATCH')).status, 200)
  const record = (await read('sales/' + sale.id)).data
  assert.equal(record.total_kurus, 50000); assert.equal(record.items[0].unit_price_kurus, 50000); assert.equal(record.items[0].product_name_snapshot, 'Orijinal snapshot')
})
test('audit: every declared business operation authenticates before accepting input', async () => {
  const response = await env.request('/openapi.json'); assert.equal(response.status, 200); const spec = await response.json()
  let checked = 0
  for (const [path, operations] of Object.entries(spec.paths)) {
    if (!path.startsWith('/api/v1/') || path === '/api/v1/auth/login') continue
    for (const method of Object.keys(operations).filter(key => ['get','post','patch','delete','put'].includes(key))) {
      const route = path.replace(/\{[^}]+\}/g, randomUUID())
      const result = await env.request(route, { method: method.toUpperCase(), headers: { Origin: 'http://localhost:5173', ...(method !== 'get' ? { 'Content-Type': 'application/json' } : {}) }, ...(method !== 'get' ? { body: '{}' } : {}) })
      assert.equal(result.status, 401, `${method} ${path}`); checked++
    }
  }
  assert.ok(checked >= 25)
  for (const path of ['/api/v1/reports/employees', '/api/v1/products', '/api/v1/correction-requests/' + randomUUID() + '/approve']) {
    const result = path.endsWith('employees') ? await env.read(employee, path) : await env.write(employee, path, {})
    assert.equal(result.status, 403)
  }
})
