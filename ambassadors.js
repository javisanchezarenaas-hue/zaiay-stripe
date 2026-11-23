'use strict';
/** Embajadoras: enlace propio (?ref=CODIGO) sin descuento para la clienta; comisión sobre las prendas (sin envío), pagadera pasado el plazo de devolución. */
const db = require('./db');
const { httpErr, iso, uid, num, eur, slugify } = require('./util');

const WAIT_DAYS = () => (process.env.COMMISSION_WAIT_DAYS !== undefined ? Math.max(0, Number(process.env.COMMISSION_WAIT_DAYS) || 0) : 15); // días tras «entregado»
const MAX_DAYS = () => (process.env.COMMISSION_MAX_DAYS !== undefined ? Math.max(0, Number(process.env.COMMISSION_MAX_DAYS) || 0) : 30);  // días tras la compra si no se marca «entregado»
const VOID = ['cancelado', 'reembolsado', 'sin_stock'];
const DAY = 86400000;

const cleanCode = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 30);

/** Para el checkout: devuelve {code, percent} si la embajadora existe y está activa. */
async function forCheckout(ref) {
  const code = cleanCode(ref); if (code.length < 2) return null;
  const a = (await db.query(`SELECT code, percent FROM ambassadors WHERE code = $1 AND active = 1`, [code])).rows[0];
  return a ? { code: a.code, percent: num(a.percent) } : null;
}

/** Comisión y estado de un pedido. */
function commission(o, now = Date.now()) {
  const base = Math.max(0, num(o.subtotal_cents) - num(o.discount_cents) - num(o.refunded_cents));
  const amount = VOID.includes(o.status) ? 0 : Math.round(base * num(o.ambassador_percent) / 100);
  let state, payableFrom;
  if (o.commission_payout_id) state = 'pagada';
  else if (!amount) state = 'anulada';
  else {
    payableFrom = o.delivered_at ? new Date(o.delivered_at).getTime() + WAIT_DAYS() * DAY : new Date(o.created_at).getTime() + MAX_DAYS() * DAY;
    state = now >= payableFrom ? 'a_pagar' : 'en_plazo';
  }
  return { base: eur(base), amount: eur(amount), amountCents: amount, state, payableFrom: payableFrom ? new Date(payableFrom).toISOString() : null };
}

async function ordersOf(code) {
  const rows = (await db.query(`SELECT id, created_at, status, subtotal_cents, discount_cents, refunded_cents, total_cents, ambassador_percent, delivered_at, commission_payout_id, customer_name FROM orders WHERE ambassador_code = $1 ORDER BY created_at DESC`, [code])).rows;
  const items = rows.length ? (await db.query(`SELECT order_id, product_name, size, quantity FROM order_items WHERE order_id IN (${rows.map((_, i) => '$' + (i + 1)).join(',')})`, rows.map(r => r.id))).rows : [];
  return rows.map(r => ({ id: r.id, date: r.created_at, status: r.status, customer: r.customer_name, percent: num(r.ambassador_percent), deliveredAt: r.delivered_at, items: items.filter(i => i.order_id === r.id).map(i => `${num(i.quantity)} × ${i.product_name} (${i.size})`), ...commission(r) }));
}
function totals(list) {
  const t = { orders: 0, sold: 0, pending: 0, payable: 0, paid: 0 };
  list.forEach(o => { if (o.state === 'anulada') return; t.orders++; t.sold += o.base; if (o.state === 'en_plazo') t.pending += o.amount; if (o.state === 'a_pagar') t.payable += o.amount; if (o.state === 'pagada') t.paid += o.amount; });
  for (const k of ['sold', 'pending', 'payable', 'paid']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}
const view = a => ({ id: a.id, code: a.code, name: a.name, email: a.email, phone: a.phone, percent: num(a.percent), active: !!num(a.active), notes: a.notes, since: a.created_at });

async function list() {
  const rows = (await db.query(`SELECT * FROM ambassadors ORDER BY active DESC, name`)).rows;
  const out = [];
  for (const a of rows) out.push({ ...view(a), stats: totals(await ordersOf(a.code)) });
  return { ambassadors: out, rules: { waitDays: WAIT_DAYS(), maxDays: MAX_DAYS() } };
}
async function detail(id) {
  const a = (await db.query(`SELECT * FROM ambassadors WHERE id = $1`, [id])).rows[0]; if (!a) throw httpErr(404, 'Embajadora no encontrada');
  const orders = await ordersOf(a.code);
  const payouts = (await db.query(`SELECT id, amount_cents, orders, note, created_at FROM ambassador_payouts WHERE ambassador_id = $1 ORDER BY created_at DESC`, [id])).rows
    .map(p => ({ id: p.id, amount: eur(p.amount_cents), orders: JSON.parse(p.orders || '[]'), note: p.note, date: p.created_at }));
  return { ...view(a), stats: totals(orders), orders, payouts };
}
function clean(b, partial) {
  const name = String(b.name || '').trim().slice(0, 80); if (!partial && !name) throw httpErr(400, 'Escribe el nombre');
  const percent = b.percent === undefined || b.percent === '' ? 10 : Number(b.percent);
  if (!isFinite(percent) || percent < 0 || percent > 50) throw httpErr(400, 'Porcentaje no válido (0–50)');
  return { name, email: String(b.email || '').trim().slice(0, 120), phone: String(b.phone || '').trim().slice(0, 40), notes: String(b.notes || '').trim().slice(0, 500), percent: Math.round(percent * 100) / 100 };
}
async function create(b) {
  const c = clean(b);
  let code = cleanCode(b.code) || cleanCode(slugify(c.name).split('-')[0]);
  if (code.length < 2) throw httpErr(400, 'El código debe tener al menos 2 letras o números');
  if ((await db.query(`SELECT 1 FROM ambassadors WHERE code = $1`, [code])).rows.length) {
    if (b.code) throw httpErr(409, 'Ese código ya lo tiene otra embajadora');
    let n = 2; while ((await db.query(`SELECT 1 FROM ambassadors WHERE code = $1`, [code + n])).rows.length) n++; code = code + n;
  }
  const id = uid();
  await db.query(`INSERT INTO ambassadors (id, code, name, email, phone, percent, active, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)`, [id, code, c.name, c.email, c.phone, c.percent, c.notes, iso()]);
  return detail(id);
}
async function update(id, b) {
  const a = (await db.query(`SELECT * FROM ambassadors WHERE id = $1`, [id])).rows[0]; if (!a) throw httpErr(404, 'Embajadora no encontrada');
  const c = clean({ ...view(a), ...b });
  await db.query(`UPDATE ambassadors SET name = $1, email = $2, phone = $3, notes = $4, percent = $5, active = $6 WHERE id = $7`, [c.name, c.email, c.phone, c.notes, c.percent, b.active === undefined ? num(a.active) : (b.active ? 1 : 0), id]);
  return detail(id);
}
/** Marca como pagadas todas las comisiones «a pagar» de la embajadora y guarda el pago. */
async function payout(id, b) {
  const d = await detail(id);
  const due = d.orders.filter(o => o.state === 'a_pagar');
  if (!due.length) throw httpErr(409, 'No hay comisiones pendientes de pago para esta embajadora');
  const amount = due.reduce((s, o) => s + o.amountCents, 0), pid = uid(), now = iso();
  await db.tx(async q => {
    await q(`INSERT INTO ambassador_payouts (id, ambassador_id, amount_cents, orders, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [pid, id, amount, JSON.stringify(due.map(o => o.id)), String(b.note || '').slice(0, 300), now]);
    for (const o of due) await q(`UPDATE orders SET commission_payout_id = $1 WHERE id = $2 AND commission_payout_id = ''`, [pid, o.id]);
  });
  return detail(id);
}
module.exports = { forCheckout, list, detail, create, update, payout, commission, cleanCode };
