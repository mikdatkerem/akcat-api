import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function registerCorrectionTests({ request, sql, origin, admin, employee, customerRequest, productRequest, saleRequest, fixture, session }) {
  let customer, product, other
  const write = (auth, path, body, key = randomUUID(), extra = {}) => request('/api/v1' + path, { method: 'POST', headers: {
    Cookie: auth.cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.data.csrfToken, 'Idempotency-Key': key, ...extra }, body: JSON.stringify(body) })
  const read = (path, auth = employee()) => request('/api/v1' + path, { headers: { Cookie: auth.cookie, Origin: origin } })
  const newSale = async (actor = employee(), paid = 0) => {
    const response = await saleRequest(actor, '', 'POST', { customer_id: customer.id, items: [{ product_id: product.id, expected_list_price_kurus: 12500, quantity: 1 }], payment: { amount_kurus: paid, method: paid ? 'cash' : null } })
    assert.equal(response.status, 201); return (await response.json()).data
  }
  const cancel = (sale, auth = employee(), key, reason = 'Hatalı satış iptali') => write(auth, '/sales/' + sale.id + '/cancel', { reason }, key)
  const pay = (sale, auth = other) => write(auth, '/payments', { customer_id: customer.id, sale_id: sale.id, amount_kurus: 1, method: 'cash' })
  const body = sale => ({ target_type: 'sale', target_id: sale.id, correction_type: 'sale_cancel', reason: 'Hatalı kayıt', requested_change: 'Satış iptal edilsin' })
  const create = async (input, actor = employee()) => {
    const response = await write(actor, '/correction-requests', input); assert.equal(response.status, 201); return (await response.json()).data
  }
  const review = (r, approve = true, auth = admin(), key) => write(auth, '/correction-requests/' + r.id + (approve ? '/approve' : '/reject'), { reason: 'İncelendi ve karar verildi' }, key)
  test('corrections: own recent unpaid sale cancels, retains records and exact debt history', async () => {
    other = await session(await fixture())
    customer = (await (await customerRequest(employee(), '', 'POST', { name: 'İzole iptal ' + randomUUID(), address: 'İzole test' })).json()).data
    product = (await (await productRequest(admin(), '', 'POST', { name: 'İzole iptal ürünü', current_price_kurus: 12500 })).json()).data
    const sale = await newSale()
    assert.equal((await (await read('/sales/' + sale.id)).json()).data.cancellation_eligibility.allowed, true)
    assert.equal((await cancel(sale)).status, 200)
    const current = (await (await read('/sales/' + sale.id)).json()).data
    assert.equal(current.status, 'cancelled'); assert.equal(current.remaining_kurus, 0); assert.equal(current.total_kurus, 12500)
    assert.equal(current.items.length, 1); assert.equal(current.cancellation_history.length, 1)
    assert.equal(current.cancellation_history[0].username, employee().data.user.username)
    const debt = await (await read('/customers/' + customer.id + '/receivables')).json()
    assert.equal(debt.summary.total_debt_kurus, 0); assert.deepEqual(debt.data, [])
    const ledger = await (await read('/customers/' + customer.id + '/ledger')).json()
    const events = ledger.data.filter(row => row.sale_id === sale.id)
    assert.deepEqual(events.map(row => row.type), ['cancellation', 'sale'])
    assert.equal(events[1].sale_balance_after_kurus, 12500); assert.equal(events[0].sale_balance_after_kurus, 0)
    assert.equal((await pay(sale)).status, 422)
    assert.equal((await sql('SELECT count(*) AS n FROM sale_items WHERE sale_id=?', [sale.id]))[0].n, 1)
  })
  test('corrections: employee cannot cancel another worker sale', async () => { assert.equal((await cancel(await newSale(other))).status, 409) })
  test('corrections: five-minute limit and future timestamps enforced', async () => {
    for (const date of [new Date(Date.now() - 301000).toISOString(), new Date(Date.now() + 60000).toISOString()]) {
      const sale = await newSale(); await sql('UPDATE sales SET created_at=? WHERE id=?', [date, sale.id]); assert.equal((await cancel(sale)).status, 409)
    }
  })
  test('corrections: any payment history, including full reversal, prevents direct cancellation', async () => {
    const sale = await newSale(employee(), 100), p = sale.payments[0]
    assert.equal((await cancel(sale)).status, 409); assert.equal((await cancel(sale, admin())).status, 409)
    await sql('INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [randomUUID(), customer.id, sale.id, 100, 'cash', admin().data.user.id, randomUUID(), p.id, new Date().toISOString()])
    assert.equal((await cancel(sale, admin())).status, 409)
  })
  test('corrections: admin can cancel old unpaid sale with original snapshot intact', async () => {
    const sale = await newSale(other); await sql('UPDATE sales SET created_at=? WHERE id=?', ['2020-01-01T00:00:00.000Z', sale.id])
    assert.equal((await cancel(sale, admin())).status, 200); assert.equal((await cancel(sale, admin())).status, 409)
  })
  test('corrections: cancellation retries share one audit; key mismatch conflicts', async () => {
    const sale = await newSale(), key = randomUUID()
    const responses = await Promise.all(Array.from({ length: 3 }, () => cancel(sale, employee(), key)))
    assert.ok(responses.every(row => row.status === 200)); assert.equal((await cancel(sale, employee(), key, 'Farklı gerekçe')).status, 409)
    assert.equal((await sql("SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='sale.cancelled'", [sale.id]))[0].n, 1)
  })
  test('corrections: reason/schema/key/CSRF/origin/auth and no delete', async () => {
    const sale = await newSale()
    assert.equal((await cancel(sale, employee(), undefined, '   ')).status, 400)
    assert.equal((await cancel(sale, employee(), 'bad')).status, 400)
    assert.equal((await write(employee(), '/sales/' + sale.id + '/cancel', { reason: 'Neden' }, undefined, { 'X-CSRF-Token': 'bad' })).status, 403)
    assert.equal((await write(employee(), '/sales/' + sale.id + '/cancel', { reason: 'Neden' }, undefined, { Origin: 'https://evil.test' })).status, 403)
    assert.equal((await request('/api/v1/correction-requests')).status, 401)
    assert.equal((await request('/api/v1/sales/' + sale.id, { method: 'DELETE', headers: { Cookie: admin().cookie, Origin: origin, 'X-CSRF-Token': admin().data.csrfToken } })).status, 404)
  })
  test('corrections: request creation is idempotent and employee sees only own requests', async () => {
    const sale = await newSale(), input = body(sale), key = randomUUID()
    const results = await Promise.all([write(employee(), '/correction-requests', input, key), write(employee(), '/correction-requests', input, key)])
    assert.deepEqual(results.map(row => row.status).sort(), [200, 201])
    const first = (await results[0].json()).data
    assert.equal((await write(employee(), '/correction-requests', { ...input, reason: 'Farklı' }, key)).status, 409)
    assert.equal((await read('/correction-requests/' + first.id, other)).status, 404)
    const list = await (await read('/correction-requests?status=all', other)).json(); assert.deepEqual(list.data, [])
    assert.equal((await read('/correction-requests/' + first.id, admin())).status, 200)
  })
  test('corrections: admin reject preserves financial state and reason/history', async () => {
    const sale = await newSale(), r = await create(body(sale))
    const result = await review(r, false); assert.equal(result.status, 200)
    const actual = (await result.json()).data; assert.equal(actual.status, 'rejected'); assert.equal(actual.history.length, 2)
    assert.equal(actual.history.find(row => row.action === 'correction.rejected').metadata.reason, 'İncelendi ve karar verildi')
    assert.equal((await (await read('/sales/' + sale.id)).json()).data.status, 'completed')
  })
  test('corrections: supported approval actually cancels and writes two linked audits atomically', async () => {
    const sale = await newSale(other), r = await create(body(sale)); assert.equal(r.can_approve, true)
    assert.equal((await review(r)).status, 200)
    const actual = (await (await read('/sales/' + sale.id)).json()).data
    assert.equal(actual.status, 'cancelled'); assert.equal(actual.remaining_kurus, 0)
    assert.equal(actual.cancellation_history[0].correction_id, r.id); assert.equal(actual.cancellation_history[0].approved_by, admin().data.user.id)
  })
  test('corrections: unsupported sale/payment corrections never approve, but can reject', async () => {
    const sale = await newSale(employee(), 100)
    for (const input of [body(sale), { ...body(sale), correction_type: 'sale_customer' }, { ...body(sale), correction_type: 'sale_items' },
      { ...body(sale), target_type: 'payment', target_id: sale.payments[0].id, correction_type: 'payment_amount' },
      { ...body(sale), target_type: 'payment', target_id: sale.payments[0].id, correction_type: 'payment_method' }]) {
      const r = await create(input); assert.equal(r.can_approve, false); assert.equal((await review(r)).status, 422)
      assert.equal((await (await read('/correction-requests/' + r.id)).json()).data.status, 'pending')
      assert.equal((await review(r, false)).status, 200)
    }
  })
  test('corrections: employee cannot approve or reject even own request', async () => {
    const r = await create(body(await newSale()))
    assert.equal((await review(r, true, employee())).status, 403); assert.equal((await review(r, false, employee())).status, 403)
  })
  test('corrections: double/concurrent approval applies once; identical retry returns saved decision', async () => {
    const sale = await newSale(), r = await create(body(sale)), key = randomUUID()
    const responses = await Promise.all([review(r, true, admin(), key), review(r, true, admin(), key)])
    assert.deepEqual(responses.map(row => row.status), [200, 200]); assert.equal((await review(r)).status, 409)
    assert.equal((await sql("SELECT count(*) AS n FROM audit_logs WHERE entity_id=? AND action='sale.cancelled'", [sale.id]))[0].n, 1)
  })
  test('corrections: cancellation and collection race has one financial winner', async () => {
    const sale = await newSale(), [c, p] = await Promise.all([cancel(sale), pay(sale)])
    assert.ok((c.status === 200 && p.status === 422) || (c.status === 409 && p.status === 201))
    const actual = (await (await read('/sales/' + sale.id)).json()).data
    assert.equal(actual.remaining_kurus, actual.status === 'cancelled' ? 0 : 12499)
    assert.equal(actual.payments.length, actual.status === 'cancelled' ? 0 : 1)
  })
  test('corrections: approval and collection race never approves a paid sale', async () => {
    const sale = await newSale(), r = await create(body(sale))
    const [a, p] = await Promise.all([review(r), pay(sale)])
    assert.ok((a.status === 200 && p.status === 422) || (a.status === 422 && p.status === 201))
    const actual = (await (await read('/correction-requests/' + r.id)).json()).data
    assert.equal(actual.status, a.status === 200 ? 'approved' : 'pending')
  })
  test('corrections: audit failure rolls back direct cancellation and preserves original row', async () => {
    const sale = await newSale(), key = randomUUID()
    await sql("CREATE TRIGGER isolated_cancel_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='sale.cancelled' BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END")
    try { assert.equal((await cancel(sale, employee(), key)).status, 500) } finally { await sql('DROP TRIGGER isolated_cancel_audit_failure') }
    assert.equal((await (await read('/sales/' + sale.id)).json()).data.status, 'completed')
    assert.equal((await cancel(sale, employee(), key)).status, 200)
  })
  test('corrections: second audit failure rolls back approval audit, decision and sale together', async () => {
    const sale = await newSale(), r = await create(body(sale)), key = randomUUID()
    await sql("CREATE TRIGGER isolated_approval_failure BEFORE INSERT ON audit_logs WHEN NEW.action='sale.cancelled' BEGIN SELECT RAISE(ABORT,'isolated approval failure'); END")
    try { assert.equal((await review(r, true, admin(), key)).status, 500) } finally { await sql('DROP TRIGGER isolated_approval_failure') }
    const current = (await (await read('/correction-requests/' + r.id)).json()).data
    assert.equal(current.status, 'pending'); assert.equal(current.history.length, 1)
    assert.equal((await (await read('/sales/' + sale.id)).json()).data.status, 'completed')
    assert.equal((await review(r, true, admin(), key)).status, 200)
  })
  test('corrections: malformed/absent targets reject and missing records never mutate', async () => {
    assert.equal((await write(employee(), '/correction-requests', { ...body({ id: randomUUID() }) })).status, 404)
    assert.equal((await write(employee(), '/correction-requests', { ...body(await newSale()), target_type: 'payment' })).status, 400)
    assert.equal((await read('/correction-requests/bad')).status, 400)
    assert.equal((await review({ id: randomUUID() })).status, 404)
    assert.equal((await read('/correction-requests?page=0')).status, 400)
  })
  test('corrections: legacy free-text requests remain readable and cannot approve', async () => {
    const sale = await newSale(), id = randomUUID()
    await sql('INSERT INTO correction_requests(id,target_type,target_id,requested_by,reason,proposed_change,created_at) VALUES(?,?,?,?,?,?,?)',
      [id, 'sale', sale.id, employee().data.user.id, 'Eski gerekçe', 'JSON olmayan eski talep', new Date().toISOString()])
    const current = (await (await read('/correction-requests/' + id)).json()).data
    assert.equal(current.correction_type, 'legacy'); assert.equal(current.can_approve, false)
    assert.equal((await read('/correction-requests?status=all', admin())).status, 200)
    assert.equal((await review({ id })).status, 422)
  })
  test('corrections: request creation and rejection roll back on audit failure', async () => {
    const sale = await newSale(), input = body(sale), key = randomUUID()
    await sql("CREATE TRIGGER isolated_request_failure BEFORE INSERT ON audit_logs WHEN NEW.action='correction.requested' BEGIN SELECT RAISE(ABORT,'isolated request failure'); END")
    try { assert.equal((await write(employee(), '/correction-requests', input, key)).status, 500) } finally { await sql('DROP TRIGGER isolated_request_failure') }
    assert.equal((await sql('SELECT count(*) AS n FROM correction_requests WHERE target_id=?', [sale.id]))[0].n, 0)
    const response = await write(employee(), '/correction-requests', input, key); assert.equal(response.status, 201); const r = (await response.json()).data
    await sql("CREATE TRIGGER isolated_reject_failure BEFORE INSERT ON audit_logs WHEN NEW.action='correction.rejected' BEGIN SELECT RAISE(ABORT,'isolated reject failure'); END")
    try { assert.equal((await review(r, false)).status, 500) } finally { await sql('DROP TRIGGER isolated_reject_failure') }
    assert.equal((await (await read('/correction-requests/' + r.id)).json()).data.status, 'pending')
  })
  test('corrections: concurrent approve/reject decisions never overwrite each other', async () => {
    const sale = await newSale(), r = await create(body(sale))
    const [a, b] = await Promise.all([review(r), review(r, false)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    const current = (await (await read('/correction-requests/' + r.id)).json()).data
    assert.equal(current.history.length, 2)
    assert.equal((await (await read('/sales/' + sale.id)).json()).data.status, current.status === 'approved' ? 'cancelled' : 'completed')
  })
}
