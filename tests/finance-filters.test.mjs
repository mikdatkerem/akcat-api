import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { reportEnvironment } from './report-environment.mjs'

let env, admin, employee, product, a, b, cancelled, reversed
const save = async response => { assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).data }
const post = async (path, body) => save(await env.write(admin, '/api/v1/' + path, body))
const get = async (path, actor = employee) => { const response = await env.read(actor, '/api/v1/' + path); assert.equal(response.status, 200, await response.clone().text()); return response.json() }
const sale = (customer, total, paid = 0, method = null) => post('sales', { customer_id: customer.id,
  items: [{ product_id: product.id, quantity: 1, unit_price_kurus: total }], payment: { amount_kurus: paid, method } })
before(async () => {
  env = await reportEnvironment(); admin = await env.fixture('admin'); employee = await env.fixture()
  product = await post('products', { name: 'İzole filtre ürünü', current_price_kurus: 200000 })
  a = await post('customers', { name: 'İPEK ŞEN', address: 'İzole test adresi' })
  b = await post('customers', { name: 'Diğer müşteri', address: 'İzole test adresi' })
  const first = await sale(a, 200000, 150000, 'cash') // 2.000 TL sales, 500 TL debt, not 2.000 TL debt.
  await sale(a, 50000, 20000, 'card') // total debt 800 TL across multiple sales.
  await sale(b, 100000, 50000, 'bank') // debt 500 TL.
  await post('sales', { sale_type: 'walk_in', customer_id: null, walk_in_customer_name: 'İPEK TEZGÂH', items: [{ product_id: product.id, quantity: 1, unit_price_kurus: 1999 }], payment: { amount_kurus: 1999, method: 'cash' } })
  cancelled = await sale(b, 900000)
  const cancel = await env.write(admin, '/api/v1/sales/' + cancelled.id + '/cancel', { reason: 'İzole iptal doğrulaması' })
  assert.equal(cancel.status, 200, await cancel.clone().text())
  const correction = await post('correction-requests', { target_type: 'payment', target_id: first.payments[0].id, correction_type: 'payment_reversal', reason: 'İzole ters kayıt', requested_change: 'Tam ters kayıt' })
  const preview = correction.financial_preview
  const approval = await env.write(admin, '/api/v1/correction-requests/' + correction.id + '/approve', { reason: 'İzole ters kayıt onayı', expected_amount_kurus: preview.amount_kurus,
    expected_sale_remaining_kurus: preview.before_sale_remaining_kurus, expected_customer_debt_kurus: preview.before_customer_debt_kurus })
  assert.equal(approval.status, 200, await approval.clone().text()); reversed = first.payments[0].id
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('finance filters: inclusive payment bounds and filtered total precede pagination; zero/empty/one-sided bounds work', async () => {
  const all = await get('payments'); assert.equal(all.pagination.total, 5)
  const filtered = await get('payments?min_amount_kurus=20000&max_amount_kurus=150000&pageSize=1&page=2')
  assert.equal(filtered.data.length, 1); assert.equal(filtered.pagination.total, 4); assert.equal(filtered.pagination.totalPages, 4)
  assert.equal((await get('payments?min_amount_kurus=1999&max_amount_kurus=1999')).pagination.total, 1)
  assert.equal((await get('payments?min_amount_kurus=150000')).pagination.total, 2)
  assert.equal((await get('payments?max_amount_kurus=1999')).pagination.total, 1)
  assert.equal((await get('payments?min_amount_kurus=&max_amount_kurus=')).pagination.total, 5)
  assert.equal((await get('payments?min_amount_kurus=0&max_amount_kurus=0')).pagination.total, 0)
})
test('finance filters: Turkish customer search intersects date/method/ID/status/amount; walk-in names remain searchable', async () => {
  const rows = await get('payments?q=' + encodeURIComponent('ipek şen') + '&method=cash&min_amount_kurus=150000&max_amount_kurus=150000&customer_id=' + a.id + '&from=2000-01-01T00:00:00Z&to=2099-01-01T00:00:00Z')
  assert.equal(rows.pagination.total, 2)
  assert.ok(rows.data.every(row => row.adjustment_kind === 'record_reversal' && !row.is_valid))
  assert.ok(rows.data.some(row => row.reversal_of_payment_id === reversed))
  assert.equal((await get('payments?status=valid&min_amount_kurus=150000')).pagination.total, 0)
  assert.equal((await get('payments?q=' + encodeURIComponent('ipek tezgâh') + '&max_amount_kurus=1999')).pagination.total, 1)
  assert.equal((await get('payments?q=' + encodeURIComponent("' OR 1=1 --"))).pagination.total, 0)
})
test('finance filters: debt is aggregated current balance after reversal, partial payments and cancellation, without walk-in debt', async () => {
  const all = await get('receivables'); assert.equal(all.pagination.total, 2)
  assert.equal(all.data.find(row => row.id === a.id).total_debt_kurus, 230000)
  assert.equal(all.data.find(row => row.id === b.id).total_debt_kurus, 50000)
  const lower = await get('receivables?min_debt_kurus=50000&max_debt_kurus=50000')
  assert.deepEqual(lower.data.map(row => row.id), [b.id])
  assert.equal((await get('receivables?min_debt_kurus=100000')).pagination.total, 1)
  assert.equal((await get('receivables?max_debt_kurus=49999')).pagination.total, 0)
  const page = await get('receivables?min_debt_kurus=50000&max_debt_kurus=230000&page=2&pageSize=1')
  assert.equal(page.pagination.total, 2); assert.deepEqual(page.data.map(row => row.id), [b.id])
  assert.equal((await get('receivables?q=' + encodeURIComponent('ipek') + '&min_debt_kurus=230000&max_debt_kurus=230000')).pagination.total, 1)
  assert.equal((await get('receivables?min_debt_kurus=&max_debt_kurus=')).pagination.total, 2)
})
test('finance filters: invalid, fractional, negative, unsafe and reversed bounds reject on both endpoints', async () => {
  for (const [path, min, max] of [['payments','min_amount_kurus','max_amount_kurus'],['receivables','min_debt_kurus','max_debt_kurus']]) {
    for (const value of ['-1','1.2','NaN','Infinity','9007199254740992','1e3','0x10',' ']) {
      const response = await env.read(employee, '/api/v1/' + path + '?' + new URLSearchParams({ [min]: value }))
      assert.equal(response.status, 400, path + ': ' + value)
    }
    assert.equal((await env.read(employee, '/api/v1/' + path + '?' + min + '=2&' + max + '=1')).status, 400)
    assert.equal((await env.request('/api/v1/' + path + '?' + min + '=1')).status, 401)
  }
})
test('finance filters: external refund rows keep their kind and remain excluded from valid collections', async () => {
  const original = (await env.sql('SELECT id FROM payments WHERE customer_id=?', [b.id]))[0]
  const row = await post('correction-requests', { target_type: 'payment', target_id: original.id, correction_type: 'payment_refund', reason: 'İzole harici iade', requested_change: 'Tam iade teyidi' })
  const p = row.financial_preview
  const response = await env.write(admin, '/api/v1/correction-requests/' + row.id + '/approve', { reason: 'İzole harici iade onayı', expected_amount_kurus: p.amount_kurus,
    expected_sale_remaining_kurus: p.before_sale_remaining_kurus, expected_customer_debt_kurus: p.before_customer_debt_kurus,
    refund_confirmation: { confirmed: true, reference: 'isolated-filter-refund' } })
  assert.equal(response.status, 200, await response.clone().text())
  const all = await get('payments?customer_id=' + b.id + '&min_amount_kurus=50000&max_amount_kurus=50000')
  assert.equal(all.pagination.total, 2)
  assert.ok(all.data.every(payment => payment.adjustment_kind === 'external_refund' && !payment.is_valid))
  assert.equal((await get('payments?customer_id=' + b.id + '&status=valid&min_amount_kurus=50000')).pagination.total, 0)
  assert.equal((await get('receivables?min_debt_kurus=100000&max_debt_kurus=100000')).data[0].id, b.id)
})
