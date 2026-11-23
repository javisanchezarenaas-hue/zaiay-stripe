'use strict';
const db = require('./db');
const { stripe } = require('./stripe');
const { httpErr, iso, uid, num, eur } = require('./util');

const STATUSES = ['pagado', 'preparando', 'enviado', 'entregado', 'cancelado', 'reembolsado', 'sin_stock'];
const NOT_SALES = ['cancelado', 'reembolsado', 'sin_stock'];
const NOT_SALES_SQL = `('cancelado','reembolsado','sin_stock')`;

/** metadata.item_N = "id|talla|cantidad|precio_unitario_en_centimos" */
function parseItems(meta) {
  const keys = Object.keys(meta || {}).filter(k => /^item_\d+$/.test(k)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  const out = [];
  for (const k of keys) {
    const parts = String(meta[k]).split('|'); if (parts.length < 4) continue;
    const unit = Number(parts.pop()), qty = Number(parts.pop()), id = parts.shift(), size = parts.join('|');
    if (id && size && qty > 0 && unit >= 0) out.push({ id, size, qty, unit });
  }
  return out;
}

async function hydrate(row) {
  if (!row) return null;
  const items = (await db.query(`SELECT product_id, product_name, size, quantity, unit_price_cents, total_cents FROM order_items WHERE order_id = $1`, [row.id])).rows;
  return {
    id: row.id, date: row.created_at, status: row.status, paymentIntent: row.payment_intent, sessionId: row.stripe_session_id,
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone, address: row.shipping_address },
    items: items.map(i => ({ productId: i.product_id, name: i.product_name, size: i.size, quantity: num(i.quantity), unitPrice: eur(i.unit_price_cents), total: eur(i.total_cents) })),
    subtotal: eur(row.subtotal_cents), discount: eur(row.discount_cents), shipping: eur(row.shipping_cents), total: eur(row.total_cents),
    discountCode: row.discount_code, note: row.note, restocked: !!num(row.restocked), refunded: eur(row.refunded_cents), ambassador: row.ambassador_code || '', deliveredAt: row.delivered_at || null,
  };
}
const orderBySession = async sid => hydrate((await db.query(`SELECT * FROM orders WHERE stripe_session_id = $1`, [sid])).rows[0]);
const orderById = async id => hydrate((await db.query(`SELECT * FROM orders WHERE id = $1`, [id])).rows[0]);

async function persist(c, withStock) {
  const now = iso();
  await db.tx(async q => {
    let customerId = null;
    if (c.email) {
      const r = await q(`INSERT INTO customers (id,email,name,phone,address,created_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (email) DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE customers.name END,
        phone = CASE WHEN EXCLUDED.phone <> '' THEN EXCLUDED.phone ELSE customers.phone END,
        address = CASE WHEN EXCLUDED.address <> '' THEN EXCLUDED.address ELSE customers.address END RETURNING id`,
        [uid(), c.email, c.name, c.phone, c.address, now]);
      customerId = r.rows[0].id;
    }
    await q(`INSERT INTO orders (id,stripe_session_id,payment_intent,customer_id,customer_email,customer_name,customer_phone,shipping_address,status,subtotal_cents,discount_cents,shipping_cents,total_cents,discount_code,note,restocked,created_at,updated_at,ambassador_code,ambassador_percent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18,$19)`,
      [c.id, c.sessionId, c.pi, customerId, c.email, c.name, c.phone, c.address, withStock ? 'pagado' : 'sin_stock', c.subtotal, c.discount, c.shipping, c.total, c.code, withStock ? '' : 'Sin stock al confirmar el pago.', withStock ? 0 : 1, now, c.amb || '', c.ambPct || 0]);
    for (const it of c.items) {
      const pr = await q(`SELECT name FROM products WHERE id = $1`, [it.id]);
      await q(`INSERT INTO order_items (id,order_id,product_id,product_name,size,quantity,unit_price_cents,total_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uid(), c.id, it.id, pr.rows[0] ? pr.rows[0].name : it.id, it.size, it.qty, it.unit, it.qty * it.unit]);
      if (!withStock) continue;
      const u = await q(`UPDATE product_sizes SET stock = stock - $1 WHERE product_id = $2 AND size = $3 AND stock >= $1 RETURNING stock`, [it.qty, it.id, it.size]);
      if (!u.rows.length) throw Object.assign(new Error('Sin stock'), { oversell: it });
      await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,$5,'venta',$6,$7)`, [uid(), it.id, it.size, -it.qty, num(u.rows[0].stock), c.id, now]);
    }
  });
}

async function processPaidSession(sessionId, source = 'webhook') {
  const existing = await orderBySession(sessionId);
  if (existing) return { order: existing, created: false };
  const s = await stripe('GET', '/v1/checkout/sessions/' + encodeURIComponent(sessionId), { expand: ['payment_intent'] });
  if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { pending: true, status: s.payment_status };
  const items = parseItems(s.metadata);
  if (!items.length) throw httpErr(422, 'La sesión de Stripe no contiene artículos');
  const cd = s.customer_details || {};
  const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const a = ship.address || cd.address || {};
  const td = s.total_details || {};
  const c = {
    id: 'ZAIAY-' + s.id.slice(-8).toUpperCase(), sessionId: s.id,
    pi: s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent.id : (s.payment_intent || ''),
    email: String(cd.email || s.customer_email || '').trim().toLowerCase(), name: cd.name || ship.name || '', phone: cd.phone || '',
    address: [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.state, a.country].filter(Boolean).join(', '),
    subtotal: num(s.amount_subtotal), discount: num(td.amount_discount), shipping: num(td.amount_shipping), total: num(s.amount_total),
    code: (s.metadata && s.metadata.discount_code) || '', items,
    amb: (s.metadata && s.metadata.ambassador) || '', ambPct: Number(s.metadata && s.metadata.ambassador_percent) || 0,
  };
  try { await persist(c, true); }
  catch (e) {
    if (db.isUnique(e)) return { order: await orderBySession(sessionId), created: false };
    if (!e.oversell) throw e;
    try { await persist(c, false); } catch (e2) { if (db.isUnique(e2)) return { order: await orderBySession(sessionId), created: false }; throw e2; }
    let note;
    try { await stripe('POST', '/v1/refunds', { payment_intent: c.pi, reason: 'requested_by_customer' }); note = 'Sin stock al confirmar el pago. Reembolsado automáticamente en Stripe.'; }
    catch (re) { note = 'REEMBOLSO PENDIENTE (hazlo en Stripe): ' + re.message; console.error('[refund]', c.id, re.message); }
    await db.query(`UPDATE orders SET note = $1 WHERE id = $2`, [note, c.id]);
  }
  console.log(`[order] ${c.id} registrado (${source})`);
  return { order: await orderBySession(sessionId), created: true };
}

/** Devuelve el stock de un pedido (cancelación / devolución). Una sola vez por pedido. */
async function restockOrder(orderId) {
  const now = iso();
  return db.tx(async q => {
    const o = (await q(`SELECT id, restocked FROM orders WHERE id = $1`, [orderId])).rows[0];
    if (!o) throw httpErr(404, 'Pedido no encontrado');
    if (num(o.restocked)) return false;
    const items = (await q(`SELECT product_id, size, quantity FROM order_items WHERE order_id = $1`, [orderId])).rows;
    for (const it of items) {
      const u = await q(`UPDATE product_sizes SET stock = stock + $1 WHERE product_id = $2 AND size = $3 RETURNING stock`, [num(it.quantity), it.product_id, it.size]);
      if (u.rows.length) await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,$5,'devolución de stock',$6,$7)`, [uid(), it.product_id, it.size, num(it.quantity), num(u.rows[0].stock), orderId, now]);
    }
    await q(`UPDATE orders SET restocked = 1, updated_at = $1 WHERE id = $2`, [now, orderId]);
    return true;
  });
}

/** charge.refunded: guarda lo devuelto; solo marca «reembolsado» si se ha devuelto todo. */
async function markRefunded(charge) {
  const pi = charge && typeof charge.payment_intent === 'string' ? charge.payment_intent : '';
  if (!pi) return;
  const refunded = num(charge.amount_refunded), full = charge.refunded === true || (num(charge.amount) > 0 && refunded >= num(charge.amount));
  await db.query(`UPDATE orders SET refunded_cents = CASE WHEN $1 > refunded_cents THEN $1 ELSE refunded_cents END, updated_at = $2 WHERE payment_intent = $3`, [refunded, iso(), pi]);
  if (full) await db.query(`UPDATE orders SET status = 'reembolsado', updated_at = $1 WHERE payment_intent = $2 AND status NOT IN ('reembolsado','sin_stock')`, [iso(), pi]);
}

module.exports = { processPaidSession, restockOrder, markRefunded, orderBySession, orderById, parseItems, hydrate, NOT_SALES, NOT_SALES_SQL, STATUSES };
