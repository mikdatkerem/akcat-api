import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'
import { migrationNames } from './migration-source.mjs'
import { legacyFinance } from './legacy-fixture.mjs'

let env, admin, employee, product, legacy
const saved = async (response, status = 201) => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()).data }
const read = async (path, actor = admin) => { const response = await env.read(actor, '/api/v1/' + path); assert.equal(response.status, 200, await response.clone().text()); return response.json() }
const body = (extra = {}) => ({ sale_type: 'walk_in', customer_id: null, walk_in_customer_name: null,
  items: [{ product_id: product.id, quantity: 1, expected_list_price_kurus: 15000 }], payment: { amount_kurus: 15000, method: 'cash' }, ...extra })
const rows = async () => Object.fromEntries(await Promise.all(['sales','sale_items','payments','financial_adjustments','correction_requests','audit_logs'].map(async table =>
  [table, await env.sql(`SELECT ${table === 'sales' ? 'id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at' : '*'} FROM ${table} ORDER BY id`)])))
before(async () => {
  env = await reportEnvironment({ migrations: (await migrationNames()).slice(0,4) }); admin = await env.fixture('admin'); employee = await env.fixture()
  legacy = await legacyFinance(env, employee, 10000)
  const now = new Date().toISOString(), request = randomUUID(), reversal = randomUUID()
  await env.sql("INSERT INTO correction_requests(id,target_type,target_id,requested_by,reason,status,reviewed_by,reviewed_at,created_at) VALUES(?,'payment',?,?,'İzole eski düzeltme','approved',?,?,?)", [request,legacy.sale.payments[0].id,employee.data.user.id,admin.data.user.id,now,now])
  await env.sql("INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,reversal_of_payment_id,created_at) VALUES(?,?,?,10000,'cash',?,?,?,?)", [reversal,legacy.customer.id,legacy.sale.id,admin.data.user.id,randomUUID(),legacy.sale.payments[0].id,now])
  await env.sql(`INSERT INTO financial_adjustments(id,correction_request_id,payment_id,reversal_payment_id,sale_id,customer_id,kind,amount_kurus,method,reason,requested_by,performed_by,approved_by,before_sale_remaining_kurus,after_sale_remaining_kurus,before_customer_debt_kurus,after_customer_debt_kurus,created_at)
    VALUES(?,?,?,?,?,?,'record_reversal',10000,'cash','İzole tarihsel kayıt',?,?,?,40000,50000,40000,50000,?)`, [randomUUID(),request,legacy.sale.payments[0].id,reversal,legacy.sale.id,legacy.customer.id,employee.data.user.id,admin.data.user.id,admin.data.user.id,now])
}, { timeout: 60000 })
after(async () => { await env?.close() })

test('walk-in migration: populated 0004 with reversal/self-FK/adjustment survives rollback and upgrade byte-for-byte', async () => {
  const before = await rows(), schema = await env.sql("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
  const sql = await readFile(new URL('../migrations/0005_walk_in_sales.sql', import.meta.url), 'utf8')
  const apply = sql => env.request('/__test/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) })
  assert.equal((await apply(sql + "SELECT json('isolated runtime migration failure');")).status, 500)
  assert.deepEqual(await rows(), before); assert.deepEqual(await env.sql("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"), schema)
  assert.equal((await apply(sql)).status, 200)
  assert.deepEqual(await rows(), before); assert.deepEqual(await env.sql('PRAGMA foreign_key_check'), [])
  const oldSale = (await read('sales/' + legacy.sale.id)).data
  assert.equal(oldSale.sale_type, 'normal'); assert.equal(oldSale.walk_in_customer_name, null); assert.equal(oldSale.total_kurus, 50000)
  assert.equal((await read('financial-adjustments')).data.length, 1)
  product = await saved(await env.write(admin, '/api/v1/products', { name: 'İzole tezgâh ürünü', current_price_kurus: 15000 }))
})
test('walk-in: admin/employee unnamed, named, whitespace, cash/card sales create no customers and pay in full', async () => {
  const customers = await env.sql('SELECT * FROM customers ORDER BY id')
  for (const [actor, name, method] of [[admin,null,'cash'],[employee,'  Ayşe Şen & <script>  ','card'],[employee,'   ','cash'],[admin,'Ş'.repeat(160),'card']]) {
    const sale = await saved(await env.write(actor, '/api/v1/sales', body({ walk_in_customer_name: name, payment: { amount_kurus:15000,method } })))
    assert.equal(sale.customer_id, null); assert.equal(sale.customer, null); assert.equal(sale.remaining_kurus, 0); assert.equal(sale.paid_kurus, 15000)
    assert.equal(sale.customer_name, name?.trim() || 'Misafir Müşteri'); assert.equal(sale.walk_in_customer_name, name?.trim() || null)
    assert.equal(sale.payments.length, 1); assert.equal(sale.payments[0].method, method); assert.equal(sale.created_by, actor.data.user.id)
  }
  assert.deepEqual(await env.sql('SELECT * FROM customers ORDER BY id'), customers)
  assert.equal((await env.write(admin,'/api/v1/products/'+product.id,undefined,'DELETE')).status,409)
})
test('walk-in: partial/overpayment/zero/bank/customer links/invalid type or name reject without any partial writes', async () => {
  for (const value of [body({ customer_id: legacy.customer.id }),body({ sale_type:'invalid' }),body({ walk_in_customer_name:'x'.repeat(161) }),body({ walk_in_customer_name:'A\u0000B' }),
    ...[0,14999,15001].map(amount_kurus => body({ payment:{amount_kurus,method:'cash'} })),body({ payment:{amount_kurus:15000,method:'bank'} }),body({ payment:{amount_kurus:15000,method:null} })]) {
    const before = await rows(), response = await env.write(employee, '/api/v1/sales', value)
    assert.ok([400,422].includes(response.status), await response.text()); assert.deepEqual(await rows(), before)
  }
  assert.equal((await env.write(employee, '/api/v1/sales', { ...body(),sale_type:'normal' })).status, 400)
})
test('walk-in: multiple products and custom price retain sale-time catalog snapshots; concurrent idempotency commits once', async () => {
  const other = await saved(await env.write(admin,'/api/v1/products',{name:'İzole ikinci ürün',current_price_kurus:1999}))
  const value = body({items:[{product_id:product.id,quantity:2,unit_price_kurus:12000},{product_id:other.id,quantity:3,expected_list_price_kurus:1999}],payment:{amount_kurus:29997,method:'card'}}), key=randomUUID()
  const send = value => env.write(employee,'/api/v1/sales',value,'POST',{'Idempotency-Key':key})
  const responses=await Promise.all([send(value),send(value),send(value)])
  assert.deepEqual(responses.map(row=>row.status).sort(),[200,200,201])
  const sale=(await responses[0].json()).data
  assert.equal(sale.total_kurus,29997); assert.equal(sale.items.find(row=>row.product_id===product.id).list_unit_price_kurus,15000)
  assert.equal((await send({...value,walk_in_customer_name:'Başka isim'})).status,409)
  assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE sale_id=?',[sale.id]))[0].n,1)
})
test('walk-in: changed price and payment/audit failures roll back the complete transaction', async () => {
  const stale=body(); await env.sql('UPDATE products SET current_price_kurus=17000 WHERE id=?',[product.id])
  const before=await rows(), conflict=await env.write(employee,'/api/v1/sales',stale)
  assert.equal(conflict.status,409); assert.equal((await conflict.json()).error.code,'PRICE_CHANGED'); assert.deepEqual(await rows(),before)
  await env.sql('UPDATE products SET current_price_kurus=15000 WHERE id=?',[product.id])
  for(const table of ['payments','audit_logs']) {
    const original=await rows()
    await env.sql(`CREATE TRIGGER isolated_walk_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'isolated failure'); END`)
    try { assert.equal((await env.write(employee,'/api/v1/sales',body())).status,500) } finally { await env.sql('DROP TRIGGER isolated_walk_failure') }
    assert.deepEqual(await rows(),original)
  }
})
test('walk-in: dashboard, sale/item/product/payment reports retain customerless rows without affecting debt', async () => {
  const before=await read('reports/summary'), sale=await saved(await env.write(employee,'/api/v1/sales',body()))
  const after=await read('reports/summary')
  assert.equal(after.sales.sales_total_kurus,before.sales.sales_total_kurus+15000)
  assert.equal(after.sales.sales_count,before.sales.sales_count+1); assert.equal(after.payments.payments_total_kurus,before.payments.payments_total_kurus+15000)
  assert.deepEqual(after.receivables,before.receivables)
  for(const path of ['sales','reports/sales','payments','reports/payments']) {
    const rows=(await read(path+'?pageSize=100')).data
    assert.ok(rows.some(row=>row.id===sale.id || row.sale_id===sale.id),path)
  }
  assert.ok((await read('reports/sales?view=items&pageSize=100')).data.some(row=>row.sale_id===sale.id))
  assert.ok((await read('reports/sales?view=products')).data.length>0)
  assert.equal((await read('receivables')).data.some(row=>row.id===null),false)
  assert.equal((await env.write(employee,'/api/v1/payments',{customer_id:legacy.customer.id,sale_id:sale.id,amount_kurus:1,method:'cash'})).status,422)
})
test('walk-in: full reversal/refund atomically cancels sale, never opens debt; duplicate approval is safe', async () => {
  for(const type of ['payment_reversal','payment_refund']) {
    const sale=await saved(await env.write(employee,'/api/v1/sales',body()))
    assert.equal((await env.write(admin,'/api/v1/sales/'+sale.id+'/cancel',{reason:'İzole doğrudan iptal'})).status,409)
    const request=await saved(await env.write(employee,'/api/v1/correction-requests',{target_type:'payment',target_id:sale.payments[0].id,correction_type:type,reason:'İzole tezgâh düzeltmesi',requested_change:'Tam düzeltme ve satış iptali'}))
    assert.equal(request.can_approve,true); assert.equal(request.financial_preview.after_sale_remaining_kurus,0)
    const value={reason:'İzole admin onayı',expected_amount_kurus:15000,expected_sale_remaining_kurus:0,expected_customer_debt_kurus:0,...(type==='payment_refund'?{refund_confirmation:{confirmed:true,reference:randomUUID()}}:{})}, key=randomUUID(), path='/api/v1/correction-requests/'+request.id+'/approve'
    assert.equal((await env.write(employee,path,value)).status,403)
    const before=await read('reports/receivables')
    if(type==='payment_reversal') {
      const original=await rows()
      await env.sql("CREATE TRIGGER isolated_walk_cancel_failure BEFORE UPDATE ON sales WHEN NEW.sale_type='walk_in' AND NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'isolated cancel failure'); END")
      try { assert.equal((await env.write(admin,path,value,'POST',{'Idempotency-Key':key})).status,500) }
      finally { await env.sql('DROP TRIGGER isolated_walk_cancel_failure') }
      assert.deepEqual(await rows(),original)
    }
    for(let i=0;i<2;i++) await saved(await env.write(admin,path,value,'POST',{'Idempotency-Key':key}),200)
    const result=(await read('sales/'+sale.id)).data
    assert.equal(result.status,'cancelled');assert.equal(result.remaining_kurus,0);assert.equal(result.payments.length,0)
    assert.equal(result.cancellation_history.length,1)
    assert.equal((await read('reports/receivables')).summary.total_debt_kurus,before.summary.total_debt_kurus)
    const adjustment=(await read('financial-adjustments?sale_id='+sale.id)).data[0]
    assert.equal(adjustment.customer_id,null);assert.equal(adjustment.after_customer_debt_kurus,0);assert.equal(adjustment.after_sale_remaining_kurus,0)
    assert.equal((await env.sql('SELECT count(*) AS n FROM payments WHERE sale_id=?',[sale.id]))[0].n,2)
  }
  assert.deepEqual(await env.sql('PRAGMA foreign_key_check'),[])
})
