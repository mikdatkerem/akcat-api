import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export function registerFinanceTests({ request, sql, origin, admin, employee, customerRequest, productRequest, saleRequest, fixture, session }) {
  let customer, sale, colleague
  const pay = (auth, body, key = randomUUID(), headers = {}) => request('/api/v1/payments', { method: 'POST', headers: {
    Cookie: auth.cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.data.csrfToken, 'Idempotency-Key': key, ...headers }, body: JSON.stringify(body) })
  const read = (path, auth = employee(), headers = {}) => request(path, { headers: { Cookie: auth.cookie, Origin: origin, ...headers } })
  const input = (amount, method = 'cash', target = sale) => ({ customer_id: customer.id, sale_id: target.id, amount_kurus: amount, method })
  const newSale = async (total = 50000, initial = 10000, actor = employee(), targetCustomer = customer) => {
    const created = await productRequest(admin(), '', 'POST', { name: 'İzole finans ürünü ' + randomUUID(), current_price_kurus: total })
    const item = (await created.json()).data
    const response = await saleRequest(actor, '', 'POST', { customer_id: targetCustomer.id, items: [{ product_id: item.id, expected_list_price_kurus: total, quantity: 1 }], payment: { amount_kurus: initial, method: initial ? 'cash' : null } })
    assert.equal(response.status, 201); return (await response.json()).data
  }
  const receivables = async () => (await (await read(`/api/v1/customers/${customer.id}/receivables`)).json())
  test('finance: authenticated empty history/receivables are real empty results', async () => {
    customer = (await (await customerRequest(employee(), '', 'POST', { name: 'IŞIK Finans ' + randomUUID(), address: 'İzole adres' })).json()).data
    colleague = await session(await fixture())
    const result = await receivables()
    assert.equal(result.summary.total_debt_kurus, 0); assert.equal(result.summary.open_sales_count, 0); assert.deepEqual(result.data, [])
    const ledger = await (await read(`/api/v1/customers/${customer.id}/ledger`)).json(); assert.deepEqual(ledger.data, [])
    const payments = await (await read('/api/v1/payments?customer_id=' + customer.id)).json(); assert.deepEqual(payments.data, [])
  })
  test('finance: 500/100 plus another worker collection of 250 yields 350 paid and 150 debt', async () => {
    sale = await newSale()
    const response = await pay(colleague, input(25000, 'card'))
    assert.equal(response.status, 201); const data = (await response.json()).data
    assert.equal(data.created_by, colleague.data.user.id); assert.equal(data.sale_remaining_kurus, 15000); assert.equal(data.is_initial, false)
    const actual = (await (await saleRequest(colleague, '/' + sale.id)).json()).data
    assert.equal(actual.total_kurus, 50000); assert.equal(actual.paid_kurus, 35000); assert.equal(actual.remaining_kurus, 15000); assert.equal(actual.payments.length, 2)
    const result = await receivables(); assert.equal(result.summary.total_debt_kurus, 15000); assert.equal(result.summary.open_sales_count, 1)
  })
  test('finance: multiple open sales aggregate debt; incremental and full collections close debt', async () => {
    const second = await newSale(20000, 0)
    assert.equal((await receivables()).summary.total_debt_kurus, 35000)
    assert.equal((await pay(employee(), input(10000, 'bank', second))).status, 201)
    assert.equal((await pay(colleague, input(10000, 'cash', second))).status, 201)
    assert.equal((await receivables()).summary.open_sales_count, 1)
    assert.equal((await pay(colleague, input(15000, 'bank'))).status, 201)
    const result = await receivables(); assert.equal(result.summary.total_debt_kurus, 0); assert.equal(result.summary.open_sales_count, 0)
    const list = await (await read('/api/v1/receivables?q=' + encodeURIComponent(customer.name))).json(); assert.deepEqual(list.data, [])
  })
  test('finance: negative/zero/fractional/unsafe values, missing method and unknown fields reject', async () => {
    const target = await newSale()
    for (const body of [...[-1, 0, 0.1, '100', null, Number.MAX_SAFE_INTEGER + 1].map(amount => input(amount, 'cash', target)),
      { ...input(1, 'cash', target), method: undefined }, input(1, 'crypto', target), { ...input(1, 'cash', target), created_by: colleague.data.user.id }]) {
      assert.equal((await pay(colleague, body)).status, 400)
    }
    assert.equal((await pay(colleague, input(40001, 'cash', target))).status, 422)
    assert.equal((await pay(colleague, input(1, 'cash', target), 'bad-key')).status, 400)
  })
  test('finance: customer/sale mismatch, absent sale, cancelled sale and paid sale reject', async () => {
    const target = await newSale()
    assert.equal((await pay(colleague, { ...input(1, 'cash', target), customer_id: randomUUID() })).status, 422)
    assert.equal((await pay(colleague, { ...input(1), sale_id: randomUUID() })).status, 422)
    assert.equal((await pay(colleague, input(1))).status, 422)
    await sql("UPDATE sales SET status='cancelled' WHERE id=?", [target.id]) // Isolated read/write rejection fixture only, no cancellation feature.
    assert.equal((await pay(colleague, input(1, 'cash', target))).status, 422)
  })
  test('finance: inactive customers can settle existing debt', async () => {
    const target = await newSale(10000, 0)
    await customerRequest(admin(), '/' + customer.id, 'PATCH', { is_active: false })
    assert.equal((await pay(colleague, input(10000, 'cash', target))).status, 201)
    await customerRequest(admin(), '/' + customer.id, 'PATCH', { is_active: true })
  })
  test('finance: two workers collecting 80 from debt 100 cannot collect 160', async () => {
    const target = await newSale(10000, 0)
    const responses = await Promise.all([pay(colleague, input(8000, 'cash', target)), pay(employee(), input(8000, 'bank', target))])
    assert.deepEqual(responses.map(row => row.status).sort(), [201, 422])
    const actual = (await (await saleRequest(employee(), '/' + target.id)).json()).data
    assert.equal(actual.paid_kurus, 8000); assert.equal(actual.remaining_kurus, 2000); assert.equal(actual.payments.length, 1)
  })
  test('finance: concurrent retries have one payment/audit; different payload conflicts after debt is paid', async () => {
    const target = await newSale(10000, 0), key = randomUUID(), body = input(10000, 'cash', target)
    const responses = await Promise.all(Array.from({ length: 4 }, () => pay(colleague, body, key)))
    assert.deepEqual(responses.map(row => row.status).sort(), [200, 200, 200, 201])
    const bodies = await Promise.all(responses.map(row => row.json())); assert.equal(new Set(bodies.map(row => row.data.id)).size, 1)
    assert.equal((await pay(colleague, body, key)).status, 200)
    assert.equal((await pay(colleague, { ...body, amount_kurus: 1 }, key)).status, 409)
    const count = (await sql("SELECT count(*) AS n FROM audit_logs WHERE entity_type='payment' AND entity_id=?", [bodies[0].data.id]))[0].n
    assert.equal(count, 1)
  })
  test('finance: audit failure rolls back payment; same key safely retries after failure', async () => {
    const target = await newSale(), key = randomUUID()
    const before = (await sql('SELECT count(*) AS n FROM payments WHERE sale_id=?', [target.id]))[0].n
    await sql("CREATE TRIGGER test_payment_audit_fail BEFORE INSERT ON audit_logs WHEN NEW.entity_type='payment' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END")
    try { const response = await pay(colleague, input(10000, 'cash', target), key); assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /SQL|stack|isolated failure/) }
    finally { await sql('DROP TRIGGER test_payment_audit_fail') }
    assert.equal((await sql('SELECT count(*) AS n FROM payments WHERE sale_id=?', [target.id]))[0].n, before)
    assert.equal((await pay(colleague, input(10000, 'cash', target), key)).status, 201)
  })
  test('finance: actor/method audit integrity and immutable financial history', async () => {
    const rows = await sql("SELECT p.id,p.method,p.created_by,a.actor_user_id,a.action,a.metadata FROM payments p JOIN audit_logs a ON a.entity_id=p.id AND a.entity_type='payment' WHERE p.customer_id=?", [customer.id])
    assert.ok(['cash', 'card', 'bank'].every(method => rows.some(row => row.method === method)))
    for (const row of rows) { assert.equal(row.actor_user_id, row.created_by); assert.equal(row.action, 'payment.created'); assert.match(JSON.parse(row.metadata).request_hash, /^[a-f0-9]{64}$/); assert.ok(!row.metadata.includes(colleague.cookie)) }
    const before = rows.length
    for (const method of ['PATCH', 'DELETE']) assert.equal((await request('/api/v1/payments/' + rows[0].id, { method, headers: { Cookie: colleague.cookie, Origin: origin, 'X-CSRF-Token': colleague.data.csrfToken } })).status, 404)
    assert.equal((await sql("SELECT count(*) AS n FROM payments p JOIN audit_logs a ON a.entity_id=p.id AND a.entity_type='payment' WHERE p.customer_id=?", [customer.id]))[0].n, before)
  })
  test('finance: ledger includes first payment once and running balances survive paging/filtering', async () => {
    const full = await (await read(`/api/v1/customers/${customer.id}/ledger?pageSize=100`)).json()
    const first = full.data.find(row => row.sale_id === sale.id && row.type === 'sale'); assert.ok(first)
    const payments = full.data.filter(row => row.sale_id === sale.id && row.type === 'payment'); assert.equal(payments.length, 3)
    const last = payments.sort((a, b) => b.created_at.localeCompare(a.created_at))[0]; assert.equal(last.sale_balance_after_kurus, 0)
    const page1 = await (await read(`/api/v1/customers/${customer.id}/ledger?pageSize=1`)).json()
    assert.deepEqual(page1.data[0], full.data[0])
    const filtered = await (await read(`/api/v1/customers/${customer.id}/ledger?type=payment&pageSize=100`)).json()
    assert.ok(filtered.data.every(row => row.type === 'payment')); assert.equal(filtered.summary.total_debt_kurus, full.summary.total_debt_kurus)
  })
  test('finance: debt search/pagination, initial-payment history, method/date/customer/sale filters', async () => {
    const list = await (await read('/api/v1/receivables?q=' + encodeURIComponent(customer.name.toLocaleLowerCase('tr-TR')) + '&pageSize=1')).json()
    assert.equal(list.data.length, 1); assert.equal(list.data[0].id, customer.id); assert.ok(list.data[0].total_debt_kurus > 0)
    assert.ok(list.data[0].last_payment_at)
    const history = await (await read(`/api/v1/payments?customer_id=${customer.id}&sale_id=${sale.id}&method=card&pageSize=1`)).json()
    assert.equal(history.pagination.total, 1); assert.equal(history.data[0].method, 'card'); assert.equal(history.data[0].created_by, colleague.data.user.id)
    const initial = await (await read(`/api/v1/payments?sale_id=${sale.id}&pageSize=100`)).json()
    assert.equal(initial.data.filter(row => row.is_initial).length, 1)
    assert.deepEqual((await (await read('/api/v1/payments?from=2100-01-01T00:00:00Z')).json()).data, [])
  })
  test('finance: all read/write routes require auth, origin/CSRF still protect writes', async () => {
    for (const path of ['/api/v1/payments', '/api/v1/receivables', `/api/v1/customers/${customer.id}/ledger`, `/api/v1/customers/${customer.id}/receivables`]) assert.equal((await request(path)).status, 401)
    assert.equal((await request('/api/v1/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(1)) })).status, 401)
    assert.equal((await pay(colleague, input(1), randomUUID(), { 'X-CSRF-Token': 'bad' })).status, 403)
    assert.equal((await pay(colleague, input(1), randomUUID(), { Origin: 'https://untrusted.test' })).status, 403)
    assert.equal((await productRequest(colleague, '', 'POST', { name: 'Denied', current_price_kurus: 1 })).status, 403)
  })
  test('finance: invalid filters/IDs, missing customers and actual DB faults stay errors', async () => {
    for (const path of ['/api/v1/payments?page=0', '/api/v1/payments?method=bad', '/api/v1/payments?customer_id=bad', '/api/v1/receivables?pageSize=101', `/api/v1/customers/${customer.id}/ledger?type=bad`]) assert.equal((await read(path)).status, 400)
    for (const suffix of ['receivables', 'ledger']) assert.equal((await read(`/api/v1/customers/${randomUUID()}/${suffix}`)).status, 404)
    for (const path of ['/api/v1/payments', '/api/v1/receivables', `/api/v1/customers/${customer.id}/ledger`, `/api/v1/customers/${customer.id}/receivables`]) {
      const response = await read(path, colleague, { 'X-Test-Mode': 'finance-db-error' }); assert.equal(response.status, 500); assert.ok(!('data' in await response.json()))
    }
  })
  test('finance: debtor/open-sale/payment pages are bounded and complete; SQL/wildcards stay literal', async () => {
    const prefix = 'Finans sayfası ' + randomUUID(), ids = []
    for (let index = 0; index < 3; index++) {
      const created = (await (await customerRequest(employee(), '', 'POST', { name: prefix + index, address: 'İzole adres' })).json()).data
      await newSale((index + 1) * 1000, 0, colleague, created); ids.push(created.id)
    }
    const first = await (await read('/api/v1/receivables?q=' + encodeURIComponent(prefix) + '&pageSize=2')).json()
    const second = await (await read('/api/v1/receivables?q=' + encodeURIComponent(prefix) + '&pageSize=2&page=2')).json()
    assert.equal(first.pagination.total, 3); assert.equal(first.pagination.totalPages, 2); assert.equal(second.data.length, 1)
    assert.equal(new Set([...first.data, ...second.data].map(row => row.id)).size, 3)
    assert.deepEqual(first.data.map(row => row.id), ids.slice(1).reverse())
    for (const q of ['%', '_', "' OR 1=1 --"]) assert.deepEqual((await (await read('/api/v1/receivables?q=' + encodeURIComponent(q))).json()).data, [])
    const open = await (await read(`/api/v1/customers/${customer.id}/receivables?pageSize=1`)).json()
    assert.equal(open.data.length, 1); assert.ok(open.pagination.total > 1); assert.equal(open.pagination.total, open.summary.open_sales_count)
    const payments = await (await read(`/api/v1/payments?customer_id=${customer.id}&pageSize=1`)).json()
    assert.equal(payments.data.length, 1); assert.ok(payments.pagination.total > 1)
  })
  test('finance: existing full reversals stay visible; valid payment/debt/ledger agree without erasing history', async () => {
    const target = await newSale(10000, 5000), before = await receivables()
    const paid = (await (await pay(colleague, input(5000, 'bank', target))).json()).data
    // The fixture runs in Node, writes originate in workerd. Match the real
    // reversal writer's causal timestamp floor instead of assuming aligned clocks.
    const now = new Date(Math.max(Date.now(), Date.parse(paid.created_at), Date.parse(target.created_at))).toISOString()
    await sql('INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [randomUUID(), customer.id, target.id, 5000, 'bank', colleague.data.user.id, randomUUID(), paid.id, now])
    const all = await (await read('/api/v1/payments?sale_id=' + target.id)).json()
    const valid = await (await read('/api/v1/payments?sale_id=' + target.id + '&status=valid')).json()
    assert.equal(all.data.length, 3); assert.equal(valid.data.length, 1); assert.equal(valid.data[0].is_initial, true)
    assert.equal((await receivables()).summary.total_debt_kurus, before.summary.total_debt_kurus)
    const history = await (await read(`/api/v1/customers/${customer.id}/ledger?type=reversal`)).json()
    assert.equal(history.data[0].sale_id, target.id)
    assert.equal(history.data[0].sale_balance_after_kurus, 5000)
    assert.equal(history.data[0].balance_after_kurus, history.summary.total_debt_kurus)
  })
  test('finance: aggregate amounts beyond safe integer limits fail closed instead of rounding', async () => {
    const target = (await (await customerRequest(employee(), '', 'POST', { name: 'Üst sınır ' + randomUUID(), address: 'İzole adres' })).json()).data
    await newSale(Number.MAX_SAFE_INTEGER, 0, colleague, target); await newSale(1, 0, colleague, target)
    for (const path of [`/api/v1/customers/${target.id}/receivables`, `/api/v1/customers/${target.id}/ledger`, '/api/v1/receivables?q=' + encodeURIComponent(target.name)]) {
      const response = await read(path); assert.equal(response.status, 500); assert.ok(!('data' in await response.json()))
    }
  })
}
