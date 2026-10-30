import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'
import { reportRange } from '../src/reports/range.ts'
let env, admin, employee, colleague, period, range, customer, product, oldSale, bankSale, cancelledSale, later, renamedSale
before(async () => { env = await reportEnvironment(); admin = await env.fixture('admin'); employee = await env.fixture(); colleague = await env.fixture() }, { timeout: 60000 })
after(async () => { await env?.close() })
const report = async (kind, query = period, actor = employee) => {
  const response = await env.read(actor, '/api/v1/reports/' + kind + (query ? '?' + query : '')); assert.equal(response.status, 200); return response.json()
}
const saved = async response => { assert.equal(response.status, 201); return (await response.json()).data }
const createSale = async (actor, price, paid = 0, method = 'cash') => {
  const response = await env.write(admin, '/api/v1/products/' + product.id, { current_price_kurus: price }, 'PATCH'); assert.equal(response.status, 200)
  return saved(await env.write(actor, '/api/v1/sales', { customer_id: customer.id, items: [{ product_id: product.id, expected_list_price_kurus: price, quantity: 1 }], payment: { amount_kurus: paid, method: paid ? method : null } }))
}
const stampSale = async (sale, time) => {
  await env.sql('UPDATE sales SET created_at=?,updated_at=? WHERE id=?', [time, time, sale.id]); await env.sql('UPDATE payments SET created_at=? WHERE sale_id=?', [time, sale.id])
}
test('reports: genuinely empty database returns zeros, bounded empty histories and server Istanbul range', async () => {
  const result = await report('summary', 'period=today'); range = result.range
  assert.equal(result.sales.sales_total_kurus, 0); assert.equal(result.sales.sales_count, 0); assert.equal(result.payments.payments_total_kurus, 0)
  assert.equal(result.receivables.total_debt_kurus, 0); assert.deepEqual(result.recent, [])
  assert.equal(range.time_zone, 'Europe/Istanbul'); assert.ok(range.from.endsWith('21:00:00.000Z'))
  period = new URLSearchParams({ period: 'custom', from: range.start_date, to: range.end_date }).toString()
  for (const kind of ['sales', 'payments', 'receivables', 'employees']) assert.deepEqual((await report(kind, period, admin)).data, [])
})
test('reports: establish real API sales, initial payments, later collection and cancellation fixtures', async () => {
  customer = await saved(await env.write(employee, '/api/v1/customers', { name: 'IŞIK Rapor ' + randomUUID(), address: 'İzole rapor adresi' }))
  product = await saved(await env.write(admin, '/api/v1/products', { name: 'Tarihsel rapor ürünü', current_price_kurus: 50000 }))
  oldSale = await createSale(employee, 50000, 10000)
  await stampSale(oldSale, new Date(Date.parse(range.from) - 3600000).toISOString())
  later = await saved(await env.write(colleague, '/api/v1/payments', { customer_id: customer.id, sale_id: oldSale.id, amount_kurus: 25000, method: 'card' }))
  await env.sql('UPDATE payments SET created_at=? WHERE id=?', [new Date(Date.parse(range.from) + 60000).toISOString(), later.id])
  bankSale = await createSale(employee, 20000, 20000, 'bank'); await stampSale(bankSale, range.from)
  cancelledSale = await createSale(employee, 8000); assert.equal((await env.write(admin, '/api/v1/sales/' + cancelledSale.id + '/cancel', { reason: 'İzole iptal' })).status, 200)
  await stampSale(cancelledSale, new Date(Date.parse(range.from) + 120000).toISOString())
})
test('reports: sales and receipts differ; old sale collection belongs to receipt day; initial payment once', async () => {
  const result = await report('summary')
  assert.equal(result.sales.sales_total_kurus, 20000); assert.equal(result.sales.sales_count, 1)
  assert.equal(result.payments.payments_total_kurus, 45000); assert.equal(result.payments.payments_count, 2)
  assert.equal(result.payments.cash_kurus, 0); assert.equal(result.payments.card_kurus, 25000); assert.equal(result.payments.bank_kurus, 20000)
  assert.equal(result.sales.cancelled_total_kurus, 8000); assert.equal(result.sales.cancelled_count, 1)
  assert.equal(result.receivables.total_debt_kurus, 15000)
})
test('reports: current debt ignores report dates, cancels excluded and multiple sales aggregate', async () => {
  const second = await createSale(colleague, 6000); await stampSale(second, new Date(Date.parse(range.from) - 2 * 86400000).toISOString())
  const data = await report('receivables', 'period=custom&from=2099-01-01&to=2099-01-01')
  assert.equal(data.balance_scope, 'current'); assert.equal(data.summary.total_debt_kurus, 21000); assert.equal(data.summary.debtor_count, 1)
  assert.equal(data.summary.open_sales_count, 2); assert.equal(data.data[0].sales_total_kurus, 56000); assert.equal(data.data[0].paid_kurus, 35000)
  const existing = await (await env.read(employee, '/api/v1/receivables')).json(); assert.equal(existing.data[0].total_debt_kurus, data.data[0].total_debt_kurus)
})
test('reports: valid and cancelled sale lists are separate and keep snapshots', async () => {
  assert.deepEqual((await report('sales')).data.map(row => row.id), [bankSale.id])
  const cancelled = await report('sales', period + '&view=cancelled'); assert.deepEqual(cancelled.data.map(row => row.id), [cancelledSale.id]); assert.equal(cancelled.data[0].remaining_kurus, 0)
  const items = await report('sales', period + '&view=items'); assert.equal(items.data[0].unit_price_kurus, 20000); assert.equal(items.data[0].quantity, 1)
})
test('reports: product grouping uses original name and price after catalog edits', async () => {
  assert.equal((await env.write(admin, '/api/v1/products/' + product.id, { name: 'Yeni katalog adı', current_price_kurus: 1999 }, 'PATCH')).status, 200)
  renamedSale = await createSale(employee, 1999, 999, 'cash'); await stampSale(renamedSale, new Date(Date.parse(range.from) + 180000).toISOString())
  const rows = (await report('sales', period + '&view=products')).data
  assert.equal(rows.length, 2); assert.ok(rows.some(row => row.product_name_snapshot === 'Tarihsel rapor ürünü' && row.unit_price_kurus === 20000 && row.total_kurus === 20000))
  assert.ok(rows.some(row => row.product_name_snapshot === 'Yeni katalog adı' && row.unit_price_kurus === 1999 && row.total_kurus === 1999))
  assert.ok(!rows.some(row => row.total_kurus === 8000))
})
test('reports: collection attribution uses collector, not original sale creator, without join fanout', async () => {
  const result = await report('employees', period, admin), collector = result.data.find(row => row.id === colleague.data.user.id), creator = result.data.find(row => row.id === employee.data.user.id)
  assert.equal(collector.payments_total_kurus, 25000); assert.equal(collector.card_kurus, 25000); assert.equal(collector.sales_count, 0)
  assert.equal(creator.sales_count, 2); assert.equal(creator.sales_total_kurus, 21999); assert.equal(creator.payments_total_kurus, 20999)
  const receipts = await report('payments', period + '&created_by=' + colleague.data.user.id, admin); assert.deepEqual(receipts.data.map(row => row.id), [later.id])
  const sales = await report('sales', period + '&created_by=' + colleague.data.user.id, admin); assert.equal(sales.data.length, 0)
})
test('reports: today/yesterday/last7/month and custom dates are server resolved at Istanbul midnight', () => {
  const now = new Date('2026-10-31T21:10:00.000Z'), parse = period => ({ period, page: 1, pageSize: 20, q: '', view: 'sales' })
  assert.equal(reportRange(parse('today'), now).start_date, '2026-11-01')
  assert.equal(reportRange(parse('yesterday'), now).from, '2026-10-30T21:00:00.000Z')
  assert.equal(reportRange(parse('last7'), now).start_date, '2026-10-26')
  assert.equal(reportRange(parse('month'), now).to, '2026-11-01T21:00:00.000Z')
  assert.equal(reportRange({ ...parse('custom'), from: '2015-01-01', to: '2015-01-01' }, now).from, '2014-12-31T22:00:00.000Z')
})
test('reports: half-open UTC boundaries include local midnight and exclude next day midnight', async () => {
  const before = await createSale(employee, 3), after = await createSale(employee, 7)
  await stampSale(before, new Date(Date.parse(range.from) - 1).toISOString()); await stampSale(after, range.to)
  const rows = (await report('sales')).data
  assert.ok(rows.some(row => row.id === bankSale.id)); assert.ok(!rows.some(row => row.id === before.id || row.id === after.id))
})
test('reports: authenticated shared operational reads; employee management report forbidden before validation', async () => {
  for (const kind of ['summary', 'sales', 'payments', 'receivables', 'employees']) assert.equal((await env.request('/api/v1/reports/' + kind)).status, 401)
  assert.equal((await env.read(employee, '/api/v1/reports/employees')).status, 403)
  assert.equal((await env.read(employee, '/api/v1/reports/employees?page=bad')).status, 403)
  for (const kind of ['sales', 'payments']) assert.equal((await env.read(employee, '/api/v1/reports/' + kind + '?created_by=' + employee.data.user.id)).status, 403)
  assert.equal((await env.read(employee, '/api/v1/reports/sales?period=today', { Origin: 'https://untrusted.test' })).status, 403)
  assert.equal((await env.read(admin, '/api/v1/reports/summary')).headers.get('cache-control'), 'no-store')
})
test('reports: invalid periods, reversed/impossible/missing/custom dates and pagination reject', async () => {
  for (const query of ['period=bad', 'period=custom', 'period=custom&from=2026-02-30&to=2026-03-01', 'period=custom&from=2026-03-01&to=2026-02-01',
    'period=custom&from=2026-01-01', 'period=today&from=2026-01-01', 'page=0', 'pageSize=101', 'view=bad', 'created_by=bad', 'q=' + 'x'.repeat(101)]) {
    assert.equal((await env.read(admin, '/api/v1/reports/sales?' + query)).status, 400, query)
  }
})
test('reports: Turkish literal search, zero-result filters and bounded pagination across report modes', async () => {
  const byName = await report('payments', period + '&q=' + encodeURIComponent(customer.name.toLocaleLowerCase('tr-TR')) + '&pageSize=1')
  assert.equal(byName.pagination.total, 3); assert.equal(byName.data.length, 1)
  const second = await report('payments', period + '&pageSize=1&page=2'); assert.notEqual(byName.data[0].id, second.data[0].id)
  for (const kind of ['sales', 'payments', 'receivables', 'employees']) {
    for (const text of ["' OR 1=1 --", '%', '__']) assert.deepEqual((await report(kind, period + '&q=' + encodeURIComponent(text), admin)).data, [])
  }
})
test('reports: recent movements contain type/customer/amount/actor/time, max ten, without secrets', async () => {
  const result = await report('summary'); assert.ok(result.recent.length <= 10)
  assert.ok(result.recent.some(row => row.type === 'payment' && row.created_by === colleague.data.user.id && row.amount_kurus === 25000))
  for (const row of result.recent) { assert.equal(typeof row.customer_name, 'string'); assert.equal(typeof row.created_by_username, 'string'); assert.ok(Number.isFinite(Date.parse(row.created_at))) }
  assert.ok(!JSON.stringify(result).includes('idempotency_key')); assert.ok(!JSON.stringify(result).includes('password'))
})
test('reports: existing full reversals are excluded from valid receipts, never applied pending requests', async () => {
  const p = renamedSale.payments[0]
  await env.sql('INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [randomUUID(), customer.id, renamedSale.id, p.amount_kurus, p.method, admin.data.user.id, randomUUID(), p.id, new Date().toISOString()])
  const result = await report('payments'); assert.equal(result.summary.payments_total_kurus, 45000); assert.equal(result.summary.cash_kurus, 0)
  assert.equal((await env.write(employee, '/api/v1/correction-requests', { target_type: 'payment', target_id: later.id, correction_type: 'payment_amount', reason: 'İzole inceleme', requested_change: 'Tutar incelensin' })).status, 201)
  assert.equal((await report('payments')).summary.card_kurus, 25000)
})
test('reports: date-index query plans and large bounded pages use existing indexes', async () => {
  for (const table of ['sales', 'payments']) {
    const plan = await env.sql(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20`, [range.from, range.to])
    assert.ok(plan.some(row => String(row.detail).includes('idx_' + table + '_date')))
  }
  await env.sql(`INSERT INTO sales(id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at)
    SELECT value,?,?,'completed',1,value,?,? FROM json_each(?)`, [customer.id, employee.data.user.id, range.from, range.from, JSON.stringify(Array.from({ length: 45 }, () => randomUUID()))])
  const pages = []
  for (let page = 1; page <= 3; page++) pages.push(await report('sales', period + '&pageSize=20&page=' + page))
  assert.equal(pages[0].pagination.total, 47); assert.equal(pages[0].data.length, 20); assert.equal(pages[2].data.length, 7)
  assert.equal(new Set(pages.flatMap(row => row.data.map(sale => sale.id))).size, 47)
})
test('reports: actual database faults fail closed with no fake report data', async () => {
  const response = await env.read(employee, '/api/v1/reports/summary', { 'X-Test-Mode': 'finance-db-error' })
  assert.equal(response.status, 500); assert.ok(!('sales' in await response.json()))
  assert.deepEqual(await (await env.request('/api/health')).json(), { status: 'ok', database: 'connected' })
})
test('reports: unsafe aggregate totals return an error instead of rounded financial values', async () => {
  const large = await createSale(employee, Number.MAX_SAFE_INTEGER); await stampSale(large, range.from)
  for (const kind of ['summary', 'sales', 'receivables', 'employees']) {
    assert.equal((await env.read(admin, '/api/v1/reports/' + kind + '?' + period)).status, 500)
  }
})
