import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'

let env, admin, otherAdmin, employee, customer, product, first, request, original, refundSale
const saved = async response => { assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).data }
const get = async (path, actor = admin) => { const response = await env.read(actor, '/api/v1/' + path); assert.equal(response.status, 200); return response.json() }
const sale = async (paid = 10000, method = 'cash') => saved(await env.write(employee, '/api/v1/sales', {
  customer_id: customer.id, items: [{ product_id: product.id, expected_list_price_kurus: 50000, quantity: 1 }], payment: { amount_kurus: paid, method: paid ? method : null },
}))
const correction = async (type, id) => saved(await env.write(employee, '/api/v1/correction-requests', {
  target_type: type.startsWith('payment_') ? 'payment' : 'sale', target_id: id, correction_type: type,
  reason: 'İzole düzeltme gerekçesi', requested_change: type === 'payment_refund' ? 'Harici tamamlanmış tam iade' : 'Hatalı kaydın tam tersine çevrilmesi',
}))
const bodyFor = row => ({ reason: 'Admin incelemesi tamamlandı', expected_amount_kurus: row.financial_preview.amount_kurus,
  expected_sale_remaining_kurus: row.financial_preview.before_sale_remaining_kurus, expected_customer_debt_kurus: row.financial_preview.before_customer_debt_kurus,
  ...(row.correction_type === 'payment_refund' ? { refund_confirmation: { confirmed: true, reference: randomUUID() } } : {}),
})
const approve = (row, body = bodyFor(row), actor = admin, key = randomUUID()) => env.write(actor, '/api/v1/correction-requests/' + row.id + '/approve', body, 'POST', { 'Idempotency-Key': key })
const refreshed = async row => (await get('correction-requests/' + row.id)).data
const debt = async () => (await get('customers/' + customer.id + '/receivables')).summary.total_debt_kurus
before(async () => {
  env = await reportEnvironment(); admin = await env.fixture('admin'); otherAdmin = await env.fixture('admin'); employee = await env.fixture()
  customer = await saved(await env.write(employee, '/api/v1/customers', { name: 'İzole finansal düzeltme', address: 'Test adresi' }))
  product = await saved(await env.write(admin, '/api/v1/products', { name: 'İzole ürün', current_price_kurus: 50000 }))
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('adjustments: employee requests correction without mutating original receipt or debt', async () => {
  first = await sale(); original = (await env.sql('SELECT * FROM payments WHERE id=?', [first.payments[0].id]))[0]
  request = await correction('payment_reversal', original.id)
  assert.equal(request.status, 'pending'); assert.equal(request.can_approve, true)
  assert.equal(request.financial_preview.before_sale_remaining_kurus, 40000); assert.equal(request.financial_preview.after_sale_remaining_kurus, 50000)
  assert.equal(await debt(), 40000); assert.equal((await env.sql('SELECT count(*) AS n FROM payments'))[0].n, 1)
})
test('adjustments: employee cannot approve, supply fake actor or bypass CSRF/origin', async () => {
  assert.equal((await approve(request, bodyFor(request), employee)).status, 403)
  assert.equal((await approve(request, { ...bodyFor(request), approved_by: employee.data.user.id })).status, 400)
  assert.equal((await env.write(admin, '/api/v1/correction-requests/' + request.id + '/approve', bodyFor(request), 'POST', { 'X-CSRF-Token': 'wrong' })).status, 403)
  assert.equal((await env.write(admin, '/api/v1/correction-requests/' + request.id + '/approve', bodyFor(request), 'POST', { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await env.write(employee, '/api/v1/financial-adjustments', {})).status, 404)
})
test('adjustments: financial approval requires current full amount and balance preview', async () => {
  assert.equal((await approve(request, { reason: 'Onay' })).status, 400)
  for (const patch of [{ expected_amount_kurus: 9999 }, { expected_sale_remaining_kurus: 0 }, { expected_customer_debt_kurus: 0 }])
    assert.equal((await approve(request, { ...bodyFor(request), ...patch })).status, 409)
  assert.equal((await refreshed(request)).status, 'pending')
})
test('adjustments: admin reversal is positive, atomic, attributed and preserves original payment and items', async () => {
  const items = await env.sql('SELECT * FROM sale_items WHERE sale_id=?', [first.id])
  const response = await approve(request); assert.equal(response.status, 200, await response.clone().text())
  const result = (await response.json()).data, f = result.adjustment
  assert.equal(result.status, 'approved'); assert.equal(result.financial_preview, null); assert.equal(f.kind, 'record_reversal')
  assert.equal(f.requested_by, employee.data.user.id); assert.equal(f.approved_by, admin.data.user.id); assert.equal(f.performed_by, admin.data.user.id)
  assert.equal(f.before_customer_debt_kurus, 40000); assert.equal(f.after_customer_debt_kurus, 50000); assert.equal(f.external_reference, null)
  const reversal = (await env.sql('SELECT * FROM payments WHERE reversal_of_payment_id=?', [original.id]))[0]
  assert.equal(reversal.amount_kurus, 10000); assert.equal(reversal.method, original.method); assert.equal(reversal.id, f.reversal_payment_id)
  assert.deepEqual((await env.sql('SELECT * FROM payments WHERE id=?', [original.id]))[0], original)
  assert.deepEqual(await env.sql('SELECT * FROM sale_items WHERE sale_id=?', [first.id]), items)
  assert.equal(await debt(), 50000)
})
test('adjustments: two admins cannot reverse the same payment via different requests', async () => {
  const duplicate = await correction('payment_reversal', original.id)
  assert.equal(duplicate.can_approve, false)
  assert.equal((await approve(duplicate, { reason: 'Tekrar', expected_amount_kurus: 10000, expected_sale_remaining_kurus: 50000, expected_customer_debt_kurus: 50000 }, otherAdmin)).status, 409)
  assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE reversal_of_payment_id=?', [original.id]))[0].n, 1)
})
test('adjustments: paid sale stays completed until externally confirmed refund resolves every receipt', async () => {
  refundSale = await sale(50000, 'card')
  const cancellation = await correction('sale_cancel', refundSale.id)
  assert.equal(cancellation.can_approve, false)
  assert.equal((await approve(cancellation, { reason: 'İade yapılmadı' })).status, 422)
  const refund = await correction('payment_refund', refundSale.payments[0].id)
  const missing = bodyFor(refund); delete missing.refund_confirmation
  assert.equal((await approve(refund, missing)).status, 409)
  assert.equal((await approve(refund, { ...bodyFor(refund), refund_confirmation: { confirmed: false, reference: 'x' } })).status, 400)
  assert.equal((await approve(refund, { ...bodyFor(refund), refund_confirmation: { confirmed: true, reference: ' ' } })).status, 400)
  assert.equal((await get('sales/' + refundSale.id)).data.status, 'completed')
  const approved = await approve(refund); assert.equal(approved.status, 200); const f = (await approved.json()).data.adjustment
  assert.equal(f.kind, 'external_refund'); assert.ok(f.external_reference); assert.ok(f.external_confirmed_at)
  assert.equal((await get('sales/' + refundSale.id)).data.remaining_kurus, 50000)
  assert.equal((await env.write(admin, '/api/v1/sales/' + refundSale.id + '/cancel', { reason: 'Doğrudan iptal denemesi' })).status, 409)
  assert.equal((await refreshed(cancellation)).can_approve, true)
  assert.equal((await approve(cancellation, { reason: 'Tam iade kapatıldı; satış iptali' })).status, 200)
  const result = (await get('sales/' + refundSale.id)).data
  assert.equal(result.status, 'cancelled'); assert.equal(result.remaining_kurus, 0); assert.equal(await debt(), 50000)
  assert.equal((await env.write(employee, '/api/v1/payments', { customer_id: customer.id, sale_id: refundSale.id, amount_kurus: 1, method: 'cash' })).status, 422)
})
test('adjustments: ledger retains original receipt, refund and cancellation history with zero final sale balance', async () => {
  const rows = (await get('customers/' + customer.id + '/ledger?pageSize=100')).data.filter(row => row.sale_id === refundSale.id)
  assert.deepEqual(new Set(rows.map(row => row.type)), new Set(['sale', 'payment', 'external_refund', 'cancellation']))
  assert.ok(rows.every(row => row.effective)); assert.equal(rows[0].sale_balance_after_kurus, 0)
  assert.equal(rows.find(row => row.type === 'payment').sale_balance_after_kurus, 0)
  assert.equal(rows.find(row => row.type === 'external_refund').sale_balance_after_kurus, 50000)
})
test('adjustments: legacy untyped reversal cannot unlock paid cancellation', async () => {
  const s = await sale(20000), p = s.payments[0]
  await env.sql('INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [randomUUID(), customer.id, s.id, p.amount_kurus, p.method, admin.data.user.id, randomUUID(), p.id, new Date().toISOString()])
  const r = await correction('sale_cancel', s.id); assert.equal(r.can_approve, false)
  assert.equal((await approve(r, { reason: 'Eski iade türü bilinmiyor' })).status, 422)
})
test('adjustments: concurrent different admins apply exactly one decision and one reversal', async () => {
  const s = await sale(3000, 'bank'), r = await correction('payment_reversal', s.payments[0].id), body = bodyFor(r)
  const responses = await Promise.all([approve(r, body), approve(r, body, otherAdmin)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])
  assert.equal((await env.sql('SELECT count(*) AS n FROM financial_adjustments WHERE correction_request_id=?', [r.id]))[0].n, 1)
})
test('adjustments: same idempotency key replays committed result after lost response and rejects changed body', async () => {
  const s = await sale(1999), r = await correction('payment_reversal', s.payments[0].id), body = bodyFor(r), key = randomUUID()
  const responses = await Promise.all([approve(r, body, admin, key), approve(r, body, admin, key)])
  assert.deepEqual(responses.map(r => r.status), [200, 200])
  const first = (await responses[0].json()).data, repeat = (await (await approve(r, body, admin, key)).json()).data
  assert.equal(first.adjustment.id, repeat.adjustment.id)
  assert.equal((await approve(r, { ...body, reason: 'Başka bilgi' }, admin, key)).status, 409)
  assert.equal((await env.sql('SELECT count(*) AS n FROM financial_adjustments WHERE correction_request_id=?', [r.id]))[0].n, 1)
})
test('adjustments: changed balance from concurrent collection blocks stale preview without side effects', async () => {
  const s = await sale(1000), r = await correction('payment_reversal', s.payments[0].id), stale = bodyFor(r)
  await saved(await env.write(employee, '/api/v1/payments', { customer_id: customer.id, sale_id: s.id, amount_kurus: 500, method: 'cash' }))
  assert.equal((await approve(r, stale)).status, 409); assert.equal((await refreshed(r)).status, 'pending')
  assert.equal((await approve(await refreshed(r))).status, 200)
})
test('adjustments: final financial audit failure rolls back reversal, adjustment and request decision', async () => {
  const s = await sale(1200), r = await correction('payment_reversal', s.payments[0].id), before = await debt(), body = bodyFor(r), key = randomUUID()
  await env.sql("CREATE TRIGGER reject_financial_audit BEFORE INSERT ON audit_logs WHEN NEW.action='payment.record_reversal' BEGIN SELECT RAISE(ABORT, 'isolated audit failure'); END")
  try {
    assert.equal((await approve(r, body, admin, key)).status, 500)
    assert.equal((await refreshed(r)).status, 'pending'); assert.equal(await debt(), before)
    assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE reversal_of_payment_id=?', [s.payments[0].id]))[0].n, 0)
    assert.equal((await env.sql('SELECT count(*) AS n FROM financial_adjustments WHERE correction_request_id=?', [r.id]))[0].n, 0)
  } finally { await env.sql('DROP TRIGGER reject_financial_audit') }
  assert.equal((await approve(r, body, admin, key)).status, 200)
})
test('adjustments: refund proof cannot be reused for another receipt of the same method', async () => {
  const a = await sale(1600, 'card'), b = await sale(1700, 'card'), reference = randomUUID()
  let r = await correction('payment_refund', a.payments[0].id)
  assert.equal((await approve(r, { ...bodyFor(r), refund_confirmation: { confirmed: true, reference } })).status, 200)
  r = await correction('payment_refund', b.payments[0].id)
  assert.equal((await approve(r, { ...bodyFor(r), refund_confirmation: { confirmed: true, reference } })).status, 409)
})
test('adjustments: reports separate valid receipts from reversals/refunds by approval date and method', async () => {
  const sum = (await env.sql("SELECT sum(CASE WHEN kind='record_reversal' THEN amount_kurus ELSE 0 END) AS reversed, sum(CASE WHEN kind='external_refund' THEN amount_kurus ELSE 0 END) AS refunded FROM financial_adjustments"))[0]
  const report = await get('reports/summary')
  assert.equal(report.adjustments.record_reversal_kurus, sum.reversed); assert.equal(report.adjustments.external_refund_kurus, sum.refunded)
  assert.equal(report.adjustments.refund_card_kurus, sum.refunded); assert.equal(report.adjustments.refund_cash_kurus, 0)
  const valid = (await env.sql('SELECT coalesce(sum(p.amount_kurus),0) AS total FROM payments p WHERE p.reversal_of_payment_id IS NULL AND NOT EXISTS(SELECT 1 FROM payments r WHERE r.reversal_of_payment_id=p.id)'))[0].total
  assert.equal(report.payments.payments_total_kurus, valid); assert.equal(report.receivables.total_debt_kurus, await debt())
  assert.equal((await get('reports/payments')).adjustments.external_refund_kurus, sum.refunded)
  const employees = await get('reports/employees'); const reviewers = employees.data.filter(row => [admin.data.user.id, otherAdmin.data.user.id].includes(row.id))
  assert.equal(reviewers.reduce((n, row) => n + row.record_reversal_kurus, 0), sum.reversed)
  assert.equal(reviewers.reduce((n, row) => n + row.external_refund_kurus, 0), sum.refunded)
  assert.ok(report.recent.some(row => ['record_reversal', 'external_refund'].includes(row.type)))
  const history = await get('financial-adjustments?sale_id=' + refundSale.id, employee)
  assert.equal(history.data.length, 1); assert.equal(history.data[0].kind, 'external_refund')
  assert.equal((await env.read(employee, '/api/v1/financial-adjustments?created_by=' + admin.data.user.id)).status, 403)
  const payments = (await get('payments?sale_id=' + refundSale.id)).data
  assert.equal(payments.length, 2); assert.ok(payments.every(row => row.adjustment_kind === 'external_refund' && !row.is_valid))
})
test('adjustments: receipt dates and approval dates remain distinct in historical reports', async () => {
  const s = await sale(2500, 'bank')
  await env.sql('UPDATE payments SET created_at=? WHERE id=?', ['2020-02-01T12:00:00.000Z', s.payments[0].id])
  const r = await correction('payment_refund', s.payments[0].id); assert.equal((await approve(r)).status, 200)
  const historical = await get('reports/payments?period=custom&from=2020-02-01&to=2020-02-01')
  assert.equal(historical.summary.payments_total_kurus, 0); assert.equal(historical.adjustments.external_refund_kurus, 0)
  assert.equal((await get('reports/summary')).adjustments.refund_bank_kurus, 2500)
})
test('adjustments: no physical delete/update endpoints or secret leakage; pagination and error states fail closed', async () => {
  assert.equal((await env.write(admin, '/api/v1/financial-adjustments', {}, 'DELETE')).status, 404)
  assert.equal((await env.read(admin, '/api/v1/financial-adjustments?pageSize=101')).status, 400)
  assert.equal((await env.read(admin, '/api/v1/financial-adjustments?from=2026-01-01T00:00:00.000Z&to=2026-01-01T00:00:00Z')).status, 400)
  assert.deepEqual((await get('financial-adjustments?sale_id=' + randomUUID())).data, [])
  const response = await env.read(admin, '/api/v1/financial-adjustments', { 'X-Test-Mode': 'finance-db-error' }); assert.equal(response.status, 500)
  const text = JSON.stringify(await get('financial-adjustments'))
  assert.ok(!/password_hash|csrfToken|session_token/.test(text))
})
