'use strict';
/** Solicitudes de cambio y devolución: el cliente las pide desde la web y se gestionan en /admin → Devoluciones. */
const crypto = require('crypto');
const db = require('./db');
const orders = require('./orders');
const { httpErr, iso, uid, num, eur, cents } = require('./util');

const TYPES = ['devolucion', 'cambio'];
const REASONS = ['Talla incorrecta', 'No me queda bien', 'No es como esperaba', 'Llegó defectuosa', 'Me llegó otra prenda', 'Otro motivo'];
const STATUSES = ['pendiente', 'aceptada', 'rechazada', 'recibida', 'reembolsada', 'completada'];
const OPEN = ['pendiente', 'aceptada', 'recibida'];
const LIMIT_DAYS = () => Math.max(1, Number(process.env.RETURN_DAYS_LIMIT) || 30); // días desde la compra (15 de política + margen de envío)

const newId = () => 'RET-' + crypto.randomBytes(3).toString('hex').toUpperCase();

async function settings() {
  const r = (await db.query(`SELECT value FROM meta WHERE key = 'return_address'`)).rows[0];
  return { returnAddress: r ? r.value : '' };
}
async function saveSettings(b) {
  const a = String(b.returnAddress || '').trim().slice(0, 400);
  await db.query(`DELETE FROM meta WHERE key = 'return_address'`);
  if (a) await db.query(`INSERT INTO meta (key, value) VALUES ('return_address', $1)`, [a]);
  return settings();
}

function hydrate(r) {
  let items = []; try { items = JSON.parse(r.items); } catch (e) {}
  return { id: r.id, orderId: r.order_id, email: r.email, type: r.type, items, reason: r.reason, comments: r.comments, status: r.status, adminNote: r.admin_note, restocked: !!num(r.restocked), refundedAmount: eur(r.refunded_cents), date: r.created_at, updated: r.updated_at };
}
const publicView = q => ({ id: q.id, type: q.type, status: q.status, date: q.date, items: q.items.map(i => ({ name: i.name, size: i.size, quantity: i.quantity, exchangeSize: i.exchangeSize || '' })) });

/** Busca el pedido del cliente (número + email deben coincidir) y comprueba si se puede pedir cambio o devolución. */
async function findOrder(b) {
  const id = String(b.orderId || '').trim().toUpperCase().replace(/\s+/g, ''), email = String(b.email || '').trim().toLowerCase();
  if (!/^ZAIAY-[A-Z0-9]{4,16}$/.test(id) || !email) throw httpErr(400, 'Escribe tu número de pedido (empieza por ZAIAY-) y el email con el que compraste');
  const o = await orders.orderById(id);
  if (!o || String(o.customer.email || '').toLowerCase() !== email) throw httpErr(404, 'No encontramos ningún pedido con ese número y ese email. Revisa que estén bien escritos.');
  const reqs = (await db.query(`SELECT * FROM return_requests WHERE order_id = $1 ORDER BY created_at DESC`, [id])).rows.map(hydrate);
  let blocked = '';
  const days = (Date.now() - new Date(o.date).getTime()) / 86400000;
  if (['cancelado', 'reembolsado', 'sin_stock'].includes(o.status)) blocked = 'Este pedido ya está cancelado o reembolsado.';
  else if (days > LIMIT_DAYS()) blocked = 'Ha pasado el plazo para pedir un cambio o una devolución de este pedido. Si crees que es un error, escríbenos.';
  else if (reqs.some(r => OPEN.includes(r.status))) blocked = 'Ya tienes una solicitud abierta para este pedido. Te escribiremos en cuanto la revisemos.';
  return { o, reqs, blocked };
}
async function lookup(b) {
  const { o, reqs, blocked } = await findOrder(b);
  return { order: { id: o.id, date: o.date, status: o.status, items: o.items.map(i => ({ productId: i.productId, name: i.name, size: i.size, quantity: i.quantity, unitPrice: i.unitPrice })) }, requests: reqs.map(publicView), canRequest: !blocked, message: blocked, reasons: REASONS };
}
async function create(b) {
  const { o, blocked } = await findOrder(b);
  if (blocked) throw httpErr(409, blocked);
  const type = TYPES.includes(b.type) ? b.type : null; if (!type) throw httpErr(400, 'Elige si quieres un cambio o una devolución');
  const reason = REASONS.includes(b.reason) ? b.reason : null; if (!reason) throw httpErr(400, 'Elige el motivo');
  const want = Array.isArray(b.items) ? b.items : [];
  const items = [];
  for (const w of want) {
    const it = o.items.find(i => i.productId === w.productId && i.size === w.size); if (!it) continue;
    const qty = Math.floor(Number(w.quantity)); if (!(qty >= 1)) continue;
    if (qty > it.quantity) throw httpErr(400, `Solo compraste ${it.quantity} de ${it.name} (talla ${it.size})`);
    const ex = type === 'cambio' ? String(w.exchangeSize || '').trim().slice(0, 40) : '';
    if (type === 'cambio' && !ex) throw httpErr(400, `Indica por qué talla o prenda quieres cambiar ${it.name}`);
    items.push({ productId: it.productId, name: it.name, size: it.size, quantity: qty, unitPrice: it.unitPrice, exchangeSize: ex });
  }
  if (!items.length) throw httpErr(400, 'Marca al menos una prenda');
  const now = iso(), id = newId();
  await db.query(`INSERT INTO return_requests (id, order_id, email, type, items, reason, comments, status, admin_note, restocked, refunded_cents, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pendiente','',0,0,$8,$8)`,
    [id, o.id, String(o.customer.email).toLowerCase(), type, JSON.stringify(items), reason, String(b.comments || '').trim().slice(0, 1000), now]);
  return { id, status: 'pendiente', type, items: items.map(i => ({ name: i.name, size: i.size, quantity: i.quantity, exchangeSize: i.exchangeSize })) };
}

// ---------- admin ----------
async function list(query) {
  const st = STATUSES.includes(query.status) ? query.status : '';
  const rows = (await db.query(`SELECT r.*, o.customer_name, o.total_cents, o.refunded_cents AS order_refunded FROM return_requests r LEFT JOIN orders o ON o.id = r.order_id ${st ? 'WHERE r.status = $1' : ''} ORDER BY CASE WHEN r.status IN ('pendiente','aceptada','recibida') THEN 0 ELSE 1 END, r.created_at DESC`, st ? [st] : [])).rows;
  return { returns: rows.map(r => ({ ...hydrate(r), customerName: r.customer_name || '', orderTotal: eur(r.total_cents), orderRefunded: eur(r.order_refunded), itemsValue: Math.round(hydrate(r).items.reduce((a, i) => a + i.unitPrice * i.quantity, 0) * 100) / 100 })), settings: await settings() };
}
async function pendingCount() { return num((await db.query(`SELECT COUNT(*) AS n FROM return_requests WHERE status = 'pendiente'`)).rows[0].n); }
async function byId(id) { const r = (await db.query(`SELECT * FROM return_requests WHERE id = $1`, [id])).rows[0]; if (!r) throw httpErr(404, 'Solicitud no encontrada'); return hydrate(r); }

/** Devuelve al stock solo las prendas de la solicitud (una vez). */
async function restockItems(id) {
  const q0 = await byId(id); if (q0.restocked) return false;
  const now = iso();
  await db.tx(async q => {
    for (const it of q0.items) {
      const u = await q(`UPDATE product_sizes SET stock = stock + $1 WHERE product_id = $2 AND size = $3 RETURNING stock`, [it.quantity, it.productId, it.size]);
      if (u.rows.length) await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,$5,'devolución cliente',$6,$7)`, [uid(), it.productId, it.size, it.quantity, num(u.rows[0].stock), id, now]);
    }
    await q(`UPDATE return_requests SET restocked = 1, updated_at = $1 WHERE id = $2`, [now, id]);
  });
  return true;
}
async function update(id, b, refundOrder) {
  const r = await byId(id), now = iso();
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw httpErr(400, 'Estado no válido'); await db.query(`UPDATE return_requests SET status = $1, updated_at = $2 WHERE id = $3`, [b.status, now, id]); }
  if (b.adminNote !== undefined) await db.query(`UPDATE return_requests SET admin_note = $1, updated_at = $2 WHERE id = $3`, [String(b.adminNote).slice(0, 1000), now, id]);
  if (b.restock) await restockItems(id);
  if (b.refund) {
    const amount = b.amount === undefined || b.amount === '' || b.amount === null ? Math.round(r.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0) * 100) / 100 : Number(b.amount);
    await refundOrder(r.orderId, { amount });
    await db.query(`UPDATE return_requests SET refunded_cents = refunded_cents + $1, status = 'reembolsada', updated_at = $2 WHERE id = $3`, [cents(amount), now, id]);
  }
  return byId(id);
}
module.exports = { lookup, create, list, update, pendingCount, settings, saveSettings, REASONS, STATUSES };
