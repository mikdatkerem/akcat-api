import { randomUUID } from 'node:crypto'

// Historical schema fixture: current API code must never be asked to operate against an old schema.
export async function legacyFinance(env, actor, paid = 0) {
  const now = new Date().toISOString(), customer = { id: randomUUID() }, product = { id: randomUUID() }, sale = { id: randomUUID(), payments: [] }
  await env.sql('INSERT INTO customers(id,name,address,created_at,updated_at) VALUES(?,?,?,?,?)', [customer.id, 'İzole eski müşteri', 'Yalnızca izole test', now, now])
  await env.sql('INSERT INTO products(id,name,current_price_kurus,created_at,updated_at) VALUES(?,?,?,?,?)', [product.id, 'Orijinal snapshot', 50000, now, now])
  await env.sql('INSERT INTO sales(id,customer_id,created_by,total_kurus,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [sale.id, customer.id, actor.data.user.id, 50000, randomUUID(), now, now])
  await env.sql('INSERT INTO sale_items(id,sale_id,product_id,product_name_snapshot,unit_price_kurus,quantity,line_total_kurus) VALUES(?,?,?,?,?,?,?)', [randomUUID(), sale.id, product.id, 'Orijinal snapshot', 50000, 1, 50000])
  if (paid) {
    const id = randomUUID()
    await env.sql('INSERT INTO payments(id,customer_id,sale_id,amount_kurus,method,created_by,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)', [id, customer.id, sale.id, paid, 'cash', actor.data.user.id, randomUUID(), now])
    sale.payments.push({ id })
  }
  return { customer, product, sale }
}
