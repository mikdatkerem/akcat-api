// Explicit local-only synthetic workload probe. Never uses akcat-db or remote bindings.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { reportEnvironment } from './report-environment.mjs'

const env = await reportEnvironment()
try {
  const admin = await env.fixture('admin'), workers = await Promise.all(Array.from({ length: 4 }, () => env.fixture()))
  const now = new Date().toISOString(), customers = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), name: 'İzole yük müşterisi ' + index }))
  const product = randomUUID(), sales = Array.from({ length: 2000 }, (_, index) => ({ id: randomUUID(), item: randomUUID(), payment: randomUUID(),
    customer: customers[index % customers.length].id, actor: workers[index % workers.length].data.user.id,
    time: new Date(Date.now() - (index % 28) * 86400000).toISOString(), method: ['cash','card','bank'][index % 3] }))
  await env.sql(`INSERT INTO customers(id,name,address,is_active,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),'İzole performans testi',1,?,? FROM json_each(?)`, [now, now, JSON.stringify(customers)])
  await env.sql('INSERT INTO products(id,name,current_price_kurus,is_active,created_at,updated_at) VALUES(?,?,50000,1,?,?)', [product, 'İzole yük ürünü', now, now])
  const input = JSON.stringify(sales)
  await env.sql(`INSERT INTO sales(id,customer_id,created_by,status,total_kurus,idempotency_key,created_at,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.customer'),json_extract(value,'$.actor'),'completed',50000,
      'isolated:'||json_extract(value,'$.id'),json_extract(value,'$.time'),json_extract(value,'$.time') FROM json_each(?)`, [input])
  await env.sql(`INSERT INTO sale_items(id,sale_id,product_id,product_name_snapshot,unit_price_kurus,quantity,line_total_kurus)
    SELECT json_extract(value,'$.item'),json_extract(value,'$.id'),?,'İzole yük ürünü',50000,1,50000 FROM json_each(?)`, [product, input])
  await env.sql(`INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,created_at)
    SELECT json_extract(value,'$.payment'),json_extract(value,'$.customer'),json_extract(value,'$.id'),20000,json_extract(value,'$.method'),
      json_extract(value,'$.actor'),'isolated:'||json_extract(value,'$.payment'),json_extract(value,'$.time') FROM json_each(?)`, [input])
  await env.sql(`INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,created_at)
    SELECT 'isolated:'||json_extract(value,'$.id'),json_extract(value,'$.actor'),'sale.created','sale',json_extract(value,'$.id'),json_extract(value,'$.time') FROM json_each(?)`, [input])
  async function measure(actor, path) {
    const start = performance.now(), response = await env.read(actor, path)
    assert.equal(response.status, 200); const data = await response.json()
    if (data.data) assert.ok(data.data.length <= 20)
    return Math.round(performance.now() - start)
  }
  const serial = {}
  for (const path of ['/api/v1/reports/summary', '/api/v1/reports/receivables', '/api/v1/reports/payments', '/api/v1/reports/employees', '/api/v1/customers/' + customers[0].id + '/ledger']) {
    await measure(admin, path)
    const samples = []; for (let index = 0; index < 3; index++) samples.push(await measure(admin, path))
    serial[path.includes('/customers/') ? 'customer_ledger' : path.split('/').at(-1)] = samples
  }
  const start = performance.now(), simultaneous = await Promise.all(workers.map(actor => measure(actor, '/api/v1/reports/summary')))
  const burstWall = Math.round(performance.now() - start)
  const summary = await (await env.read(admin, '/api/v1/reports/receivables')).json()
  assert.equal(summary.summary.total_debt_kurus, 60000000)
  const plan = await env.sql('EXPLAIN QUERY PLAN SELECT id FROM sales WHERE created_at>=? AND created_at<?', [sales[1999].time, now])
  console.log(JSON.stringify({ environment: 'Local Workers/workerd + isolated D1; synthetic fixtures only', sales: 2000, customers: 100, payments: 2000,
    serial_warm_wall_ms: serial, four_concurrent_summary_wall_ms: simultaneous, concurrent_burst_wall_ms: burstWall,
    sales_date_index_used: plan.some(row => String(row.detail).includes('idx_sales_date')),
    limitations: 'Three warm samples and one concurrent burst. Not edge CPU, network latency, long-term data growth or production capacity validation.' }, null, 2))
} finally { await env.close() }
