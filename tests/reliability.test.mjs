import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'
import { tokenHash } from '../src/security/tokens.ts'

let env, admin, employee
const data = async (response, status = 201) => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()).data }
const createProduct = () => env.write(admin, '/api/v1/products', { name: 'İzole güvenilirlik ürünü', current_price_kurus: 15000 }).then(data)
const createCustomer = () => env.write(employee, '/api/v1/customers', { name: 'İzole güvenilirlik müşterisi', address: 'Yalnızca izole test' }).then(data)
const saleBody = (customer, product, extra = {}) => ({ customer_id: customer.id, items: [{ product_id: product.id, expected_list_price_kurus: product.current_price_kurus, quantity: 2, ...extra }], payment: { amount_kurus: 0, method: null } })
before(async () => { env = await reportEnvironment(); admin = await env.fixture('admin'); employee = await env.fixture() }, { timeout: 60000 })
after(async () => { await env?.close() })

test('reliability: custom catalog/lower/higher prices and multi-item totals retain actual catalog snapshots', async () => {
  const customer = await createCustomer(), product = await createProduct(), second = await createProduct()
  for (const price of [undefined, 12000, 17000]) {
    const body = saleBody(customer, product, price === undefined ? {} : { unit_price_kurus: price })
    body.items.push({ product_id: second.id, quantity: 3, unit_price_kurus: 1999 })
    const sale = await data(await env.write(employee, '/api/v1/sales', body))
    assert.equal(sale.total_kurus, (price ?? 15000) * 2 + 5997)
    assert.ok(sale.items.every(item => item.list_unit_price_kurus === 15000))
  }
  for (const unit_price_kurus of [0, -1, 19.99, '15000', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await env.write(employee, '/api/v1/sales', saleBody(customer, product, { unit_price_kurus }))).status, 400)
})
test('reliability: unused products/customers delete idempotently despite creation/update audits; employee denied', async () => {
  for (const [resource, row] of [['products', await createProduct()], ['customers', await createCustomer()]]) {
    const path = '/api/v1/' + resource + '/' + row.id, key = randomUUID()
    await data(await env.write(admin, path, { name: 'İzole güncelleme' }, 'PATCH'), 200)
    assert.equal((await env.write(employee, path, undefined, 'DELETE')).status, 403)
    for (let i = 0; i < 2; i++) assert.equal((await env.write(admin, path, undefined, 'DELETE', { 'Idempotency-Key': key })).status, 200)
    assert.equal((await env.read(admin, path)).status, 404)
  }
})
test('reliability: stale catalog price is rejected atomically, explicit acceptance works; custom prices and replays remain stable', async () => {
  const customer = await createCustomer(), product = await createProduct(), body = saleBody(customer, product), key = randomUUID()
  const before = await env.sql('SELECT (SELECT count(*) FROM sales) AS sales,(SELECT count(*) FROM sale_items) AS items,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM audit_logs) AS audits')
  await env.sql('UPDATE products SET current_price_kurus=17000 WHERE id=?', [product.id])
  const stale = await env.write(employee, '/api/v1/sales', body, 'POST', { 'Idempotency-Key': key })
  assert.equal(stale.status, 409)
  const error = (await stale.json()).error
  assert.equal(error.code, 'PRICE_CHANGED'); assert.equal(error.details.products[0].current_price_kurus, 17000)
  assert.deepEqual(await env.sql('SELECT (SELECT count(*) FROM sales) AS sales,(SELECT count(*) FROM sale_items) AS items,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM audit_logs) AS audits'), before)
  const legacy = saleBody(customer, product); delete legacy.items[0].expected_list_price_kurus
  assert.equal((await env.write(employee, '/api/v1/sales', legacy)).status, 428)
  body.items[0].expected_list_price_kurus = 17000
  const saved = await data(await env.write(employee, '/api/v1/sales', body, 'POST', { 'Idempotency-Key': key }))
  assert.equal(saved.total_kurus, 34000)
  await env.sql('UPDATE products SET current_price_kurus=19000 WHERE id=?', [product.id])
  assert.equal((await data(await env.write(employee, '/api/v1/sales', body, 'POST', { 'Idempotency-Key': key }), 200)).id, saved.id)
  const custom = await data(await env.write(employee, '/api/v1/sales', saleBody(customer, product, { unit_price_kurus: 12000 })))
  assert.equal(custom.total_kurus, 24000); assert.equal(custom.items[0].list_unit_price_kurus, 19000)
  // Emulate a committed pre-upgrade request digest, without changing financial data.
  const oldBody = structuredClone(body); delete oldBody.items[0].expected_list_price_kurus
  await env.sql("UPDATE audit_logs SET metadata=json_set(metadata,'$.request_hash',?) WHERE id=?", [tokenHash(JSON.stringify([oldBody.customer_id, oldBody.items, oldBody.payment])), 'sale:create:' + tokenHash(employee.data.user.id + ':' + key)])
  const oldReplay = await data(await env.write(employee, '/api/v1/sales', oldBody, 'POST', { 'Idempotency-Key': key }), 200)
  assert.equal(oldReplay.id, saved.id); assert.equal(oldReplay.total_kurus, 34000)
})
test('reliability: product/customer CAS admits one writer; replays never overwrite later versions; old clients fail closed', async () => {
  for (const [resource, row] of [['products', await createProduct()], ['customers', await createCustomer()]]) {
    const path = '/api/v1/' + resource + '/' + row.id, key = randomUUID(), version = row.version
    assert.equal(version, 1)
    const body = { name: 'İzole ilk düzenleme', expected_version: version }
    const results = await Promise.all([
      env.write(admin, path, body, 'PATCH', { 'Idempotency-Key': key }),
      env.write(admin, path, { name: 'İzole rakip düzenleme', expected_version: version }, 'PATCH'),
    ])
    assert.deepEqual(results.map(row => row.status).sort(), [200, 409])
    const winner = (await (await env.read(admin, path)).json()).data
    assert.equal(winner.version, 2)
    // If the competing request won, the original request has no idempotency result.
    const winningKey = results[0].status === 200 ? key : null
    const secondKey = randomUUID(), secondBody = { name: 'İzole daha yeni değer', expected_version: 2 }
    await data(await env.write(admin, path, secondBody, 'PATCH', { 'Idempotency-Key': secondKey }), 200)
    if (winningKey) {
      const replay = await data(await env.write(admin, path, body, 'PATCH', { 'Idempotency-Key': key }), 200)
      assert.equal(replay.name, secondBody.name); assert.equal(replay.version, 3)
    }
    const replay = await data(await env.write(admin, path, secondBody, 'PATCH', { 'Idempotency-Key': secondKey }), 200)
    assert.equal(replay.version, 3)
    assert.equal((await env.write(admin, path, { ...secondBody, name: 'Farklı tekrar' }, 'PATCH', { 'Idempotency-Key': secondKey })).status, 409)
    const missing = await env.request(path, { method: 'PATCH', headers: { Cookie: admin.cookie, Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-CSRF-Token': admin.data.csrfToken, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ name: 'Eski istemci' }) })
    assert.equal(missing.status, 428)
    const audits = await env.sql("SELECT metadata FROM audit_logs WHERE entity_id=? AND action LIKE '%.updated'", [row.id])
    assert.equal(audits.length, 2)
  }
})
test('reliability: price history records DB prices once, excludes unknown legacy history, enforces admin and rolls back on failure', async () => {
  const product = await createProduct(), path = '/api/v1/products/' + product.id, history = path + '/price-history'
  assert.deepEqual((await (await env.read(admin, history)).json()).data, [])
  assert.equal((await env.read(employee, history)).status, 403)
  const key = randomUUID(), body = { current_price_kurus: 17000, expected_version: 1 }
  await data(await env.write(admin, path, body, 'PATCH', { 'Idempotency-Key': key }), 200)
  await data(await env.write(admin, path, body, 'PATCH', { 'Idempotency-Key': key }), 200)
  const first = (await (await env.read(admin, history)).json()).data
  assert.equal(first.length, 1); assert.equal(first[0].old_price_kurus, 15000); assert.equal(first[0].new_price_kurus, 17000)
  assert.equal(first[0].actor_user_id, admin.data.user.id); assert.equal(first[0].username, admin.data.user.username)
  await data(await env.write(admin, path, { name: 'Fiyat değişmeden ad değişti', expected_version: 2 }, 'PATCH'), 200)
  await env.sql("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,metadata,created_at) VALUES(?,?,'product.updated','product',?,'{\"fields\":[\"current_price_kurus\"]}',?)", [randomUUID(), admin.data.user.id, product.id, new Date().toISOString()])
  assert.equal((await (await env.read(admin, history)).json()).data.length, 1)
  await env.sql("CREATE TRIGGER test_price_write_failure BEFORE UPDATE ON products BEGIN SELECT RAISE(ABORT,'isolated price failure'); END")
  try { assert.equal((await env.write(admin, path, { current_price_kurus: 19000, expected_version: 3 }, 'PATCH')).status, 500) }
  finally { await env.sql('DROP TRIGGER test_price_write_failure') }
  assert.equal((await (await env.read(admin, history)).json()).data.length, 1)
  await data(await env.write(admin, path, { current_price_kurus: 12000, expected_version: 3 }, 'PATCH'), 200)
  const page = await (await env.read(admin, history + '?page=1&pageSize=1')).json()
  assert.equal(page.pagination.total, 2); assert.equal(page.data[0].old_price_kurus, 17000); assert.equal(page.data[0].new_price_kurus, 12000)
  assert.equal((await env.read(admin, history + '?pageSize=101')).status, 400)
})
test('reliability: all historical sales protect product/customer references, including after cancellation', async () => {
  const customer = await createCustomer(), product = await createProduct()
  const sale = await data(await env.write(employee, '/api/v1/sales', saleBody(customer, product)))
  await data(await env.write(admin, '/api/v1/sales/' + sale.id + '/cancel', { reason: 'İzole iptal gerekçesi' }), 200)
  for (const [resource, row] of [['products', product], ['customers', customer]]) {
    assert.equal((await env.write(admin, '/api/v1/' + resource + '/' + row.id, undefined, 'DELETE')).status, 409)
  }
  // Legacy standalone receipts must protect a customer even without a sale reference.
  const legacyCustomer = await createCustomer(), paymentId = randomUUID()
  await env.sql('INSERT INTO payments(id,customer_id,amount_kurus,method,created_by,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)',
    [paymentId, legacyCustomer.id, 1000, 'cash', admin.data.user.id, randomUUID(), new Date().toISOString()])
  assert.equal((await env.write(admin, '/api/v1/customers/' + legacyCustomer.id, undefined, 'DELETE')).status, 409)
  assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE id=?', [paymentId]))[0].n, 1)
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
})
test('reliability: user deletion blocks self, last active admin and financial history; removes technical sessions', async () => {
  const path = id => '/api/v1/users/' + id
  assert.equal((await env.sql("SELECT count(*) AS n FROM users WHERE role='admin' AND is_active=1"))[0].n, 1)
  assert.equal((await env.write(admin, path(admin.data.user.id), undefined, 'DELETE')).status, 409)
  const customer = await createCustomer(), product = await createProduct()
  await data(await env.write(employee, '/api/v1/sales', saleBody(customer, product)))
  assert.equal((await env.write(admin, path(employee.data.user.id), undefined, 'DELETE')).status, 409)
  const user = await data(await env.write(admin, '/api/v1/users', { username: 'delete_' + randomBytes(6).toString('hex'), password: randomBytes(24).toString('base64url'), role: 'employee' }))
  const raw = 'w1_' + randomBytes(32).toString('base64url'), now = new Date().toISOString()
  await env.sql('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', [tokenHash(raw), user.id, new Date(Date.now() + 3600000).toISOString(), now])
  const headers = { Cookie: 'akcat_session_dev=' + raw, Origin: 'http://localhost:5173' }
  assert.equal((await env.request('/api/v1/auth/me', { headers })).status, 200)
  assert.equal((await env.write(employee, path(user.id), undefined, 'DELETE')).status, 403)
  assert.equal((await env.write(admin, path(user.id), undefined, 'DELETE')).status, 200)
  assert.equal((await env.request('/api/v1/auth/me', { headers })).status, 401)
  assert.equal((await env.sql('SELECT count(*) AS n FROM sessions WHERE user_id=?', [user.id]))[0].n, 0)
})

test('reliability: authority revoked after middleware prevents sales, collections, cancellations and admin decisions atomically', async () => {
  for (const change of ['inactive','revoked','expired','demoted']) {
    const actor = await env.fixture('admin'), customer = await createCustomer(), product = await createProduct()
    const sale = await data(await env.write(actor, '/api/v1/sales', saleBody(customer, product)))
    const request = await data(await env.write(actor, '/api/v1/correction-requests', { target_type: 'sale', target_id: sale.id, correction_type: 'sale_cancel', reason: 'İzole yetki yarışı', requested_change: 'İptal' }))
    const paidSale = await data(await env.write(actor, '/api/v1/sales', { ...saleBody(customer, product), payment: { amount_kurus: 1000, method: 'cash' } }))
    const financial = await data(await env.write(actor, '/api/v1/correction-requests', { target_type: 'payment', target_id: paidSale.payments[0].id, correction_type: 'payment_reversal', reason: 'İzole finansal yetki yarışı', requested_change: 'Tam ters kayıt' }))
    const preview = financial.financial_preview
    const cases = [
      ['/api/v1/sales', saleBody(customer, product)],
      ['/api/v1/payments', { customer_id: customer.id, sale_id: sale.id, amount_kurus: 1000, method: 'cash' }],
      ['/api/v1/sales/' + sale.id + '/cancel', { reason: 'İzole iptal' }],
      ['/api/v1/correction-requests/' + request.id + '/approve', { reason: 'İzole onay' }],
      ['/api/v1/correction-requests/' + request.id + '/reject', { reason: 'İzole ret' }],
      ['/api/v1/products', { name: 'İzole yetkisiz', current_price_kurus: 1000 }],
      ['/api/v1/correction-requests/' + financial.id + '/approve', { reason: 'İzole finansal onay', expected_amount_kurus: preview.amount_kurus, expected_sale_remaining_kurus: preview.before_sale_remaining_kurus, expected_customer_debt_kurus: preview.before_customer_debt_kurus }],
    ]
    for (const [path, body] of cases) {
      await env.sql("UPDATE users SET is_active=1,role='admin' WHERE id=?", [actor.data.user.id])
      await env.sql('UPDATE sessions SET revoked_at=NULL,expires_at=? WHERE user_id=?', [new Date(Date.now()+3600000).toISOString(), actor.data.user.id])
      const before = await env.sql('SELECT (SELECT count(*) FROM sales) AS sales,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM audit_logs) AS audits')
      const response = await env.write(actor, path, body, 'POST', { 'X-Test-Authorization-Change': change })
      assert.equal(response.status, 403, path + ':' + change + ':' + await response.text())
      assert.deepEqual(await env.sql('SELECT (SELECT count(*) FROM sales) AS sales,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM audit_logs) AS audits'), before)
      assert.equal((await env.sql('SELECT status FROM sales WHERE id=?', [sale.id]))[0].status, 'completed')
    }
  }
})
