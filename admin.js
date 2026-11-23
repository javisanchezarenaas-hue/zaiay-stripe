'use strict';
const crypto = require('crypto');
const db = require('./db');
const orders = require('./orders');
const shop = require('./shop');
const { stripe } = require('./stripe');
const { buildXlsx } = require('./xlsx');
const { httpErr, iso, uid, num, eur, cents, slugify, readBody, send, corsHeaders, periods, madridYMD, fmtDateEs } = require('./util');
const { NOT_SALES_SQL, STATUSES } = orders;

const secret = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('zaiay:' + (process.env.ADMIN_PASSWORD || '')).digest('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sign = p => crypto.createHmac('sha256', secret()).update(p).digest('base64url');

function login(password) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw httpErr(503, 'Panel desactivado: falta la variable ADMIN_PASSWORD en el servidor.');
  if (!crypto.timingSafeEqual(sha(password || ''), sha(pw))) throw httpErr(401, 'Contraseña incorrecta');
  const p = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return { token: p + '.' + sign(p), expiresInHours: 12 };
}
function requireAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m || !process.env.ADMIN_PASSWORD) throw httpErr(401, 'No autorizado');
  const [p, s] = m[1].split('.'); if (!p || !s) throw httpErr(401, 'No autorizado');
  const exp = sign(p); if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) throw httpErr(401, 'No autorizado');
  let d; try { d = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { throw httpErr(401, 'No autorizado'); }
  if (!d.exp || d.exp < Date.now()) throw httpErr(401, 'Sesión caducada');
}

async function agg(from, to) {
  const r = (await db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(total_cents - refunded_cents),0) AS t FROM orders WHERE status NOT IN ${NOT_SALES_SQL}` + (from ? ' AND created_at >= $1 AND created_at < $2' : ''), from ? [from, to] : [])).rows[0];
  return { count: num(r.n), total: eur(r.t) };
}
async function top(from, to) {
  const rows = (await db.query(`SELECT i.product_id, i.product_name, SUM(i.quantity) AS qty, SUM(i.total_cents) AS rev FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status NOT IN ${NOT_SALES_SQL}` + (from ? ' AND o.created_at >= $1 AND o.created_at < $2' : '') + ` GROUP BY i.product_id, i.product_name ORDER BY qty DESC, rev DESC LIMIT 10`, from ? [from, to] : [])).rows;
  return rows.map(r => ({ productId: r.product_id, name: r.product_name, quantity: num(r.qty), revenue: eur(r.rev) }));
}
async function summary(req) {
  const P = periods(), cat = await shop.catalog(req, { includeInactive: true });
  const since = new Date(Date.now() - 16 * 86400000).toISOString();
  const recent = (await db.query(`SELECT created_at, total_cents FROM orders WHERE status NOT IN ${NOT_SALES_SQL} AND created_at >= $1`, [since])).rows;
  const byDayMap = {}; recent.forEach(o => { const { y, m, d } = madridYMD(new Date(o.created_at)); const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; (byDayMap[k] = byDayMap[k] || { count: 0, total: 0 }); byDayMap[k].count++; byDayMap[k].total += num(o.total_cents) / 100; });
  const byDay = []; for (let i = 13; i >= 0; i--) { const { y, m, d } = madridYMD(new Date(Date.now() - i * 86400000)); const k = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; byDay.push({ day: k, count: (byDayMap[k] || {}).count || 0, total: Math.round(((byDayMap[k] || {}).total || 0) * 100) / 100 }); }
  const lowStock = []; cat.products.forEach(p => p.sizes.forEach(s => { if (s.stock > 0 && s.stock <= 2) lowStock.push({ productId: p.id, name: p.name, size: s.size, stock: s.stock }); }));
  const recentOrders = (await db.query(`SELECT id FROM orders ORDER BY created_at DESC LIMIT 8`)).rows;
  const alerts = await listAlerts();
  return {
    returnsPending: await require('./returns').pendingCount(),
    alertsPending: alerts.filter(a => !a.notified).length, alertsReady: alerts.filter(a => !a.notified && a.stock > 0).length,
    today: await agg(...P.today), month: await agg(...P.month), all: await agg(),
    customers: num((await db.query(`SELECT COUNT(*) AS n FROM customers`)).rows[0].n),
    soldOut: cat.products.filter(p => p.active && p.soldOut).map(p => ({ id: p.id, name: p.name })), lowStock,
    topProducts: await top(), topProductsMonth: await top(...P.month), byDay,
    recentOrders: await Promise.all(recentOrders.map(r => orders.orderById(r.id))),
  };
}

async function listOrders(query) {
  const where = [], params = [];
  const q = String(query.q || '').trim().toLowerCase();
  if (q) { params.push('%' + q + '%'); const n = params.length; where.push(`(LOWER(o.id) LIKE $${n} OR LOWER(o.customer_email) LIKE $${n} OR LOWER(o.customer_name) LIKE $${n} OR LOWER(o.payment_intent) LIKE $${n} OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND LOWER(i.product_name) LIKE $${n}))`); }
  if (query.status && STATUSES.includes(query.status)) { params.push(query.status); where.push(`o.status = $${params.length}`); }
  if (query.code === '1') where.push(`o.discount_code <> ''`);
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 25)), page = Math.max(1, parseInt(query.page) || 1);
  const total = num((await db.query(`SELECT COUNT(*) AS n FROM orders o ${W}`, params)).rows[0].n);
  const rows = (await db.query(`SELECT o.id FROM orders o ${W} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit])).rows;
  return { total, page, limit, orders: await Promise.all(rows.map(r => orders.orderById(r.id))) };
}
async function updateOrder(id, b) {
  const o = await orders.orderById(id); if (!o) throw httpErr(404, 'Pedido no encontrado');
  if (b.status === 'entregado') await db.query(`UPDATE orders SET delivered_at = $1 WHERE id = $2 AND delivered_at IS NULL`, [iso(), id]);
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw httpErr(400, 'Estado no válido'); await db.query(`UPDATE orders SET status = $1, updated_at = $2 WHERE id = $3`, [b.status, iso(), id]); }
  if (b.note !== undefined) await db.query(`UPDATE orders SET note = $1, updated_at = $2 WHERE id = $3`, [String(b.note).slice(0, 1000), iso(), id]);
  if (b.restock) await orders.restockOrder(id);
  return orders.orderById(id);
}
async function listCustomers() {
  const rows = (await db.query(`SELECT c.id, c.email, c.name, c.phone, c.address, c.created_at, COUNT(o.id) AS n, COALESCE(SUM(o.total_cents),0) AS t, MAX(o.created_at) AS last FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status NOT IN ${NOT_SALES_SQL} GROUP BY c.id, c.email, c.name, c.phone, c.address, c.created_at ORDER BY t DESC, c.created_at DESC`)).rows;
  return rows.map(r => ({ id: r.id, email: r.email, name: r.name, phone: r.phone, address: r.address, since: r.created_at, orders: num(r.n), spent: eur(r.t), lastOrder: r.last }));
}

async function cleanProduct(b) {
  const name = String(b.name || '').trim(); if (!name || name.length > 120) throw httpErr(400, 'El nombre es obligatorio (máx. 120 caracteres)');
  const price = Number(b.price); if (!isFinite(price) || price < 0 || price > 10000) throw httpErr(400, 'Precio no válido');
  const ref = String(b.categoryId || b.category || '');
  const cat = (await db.query(`SELECT id FROM categories WHERE id = $1 OR slug = $1`, [ref])).rows[0]; if (!cat) throw httpErr(400, 'Categoría no válida');
  if (!Array.isArray(b.sizes) || !b.sizes.length || b.sizes.length > 12) throw httpErr(400, 'Añade al menos una talla');
  const seen = new Set(), sizes = b.sizes.map(s => {
    const size = String(s.size || '').trim(), stock = Number(s.stock);
    if (!size || size.length > 12 || size.includes('|')) throw httpErr(400, 'Talla no válida');
    if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw httpErr(400, `Stock no válido en la talla ${size}`);
    if (seen.has(size.toLowerCase())) throw httpErr(400, `Talla repetida: ${size}`); seen.add(size.toLowerCase());
    return { size, stock };
  });
  const images = (Array.isArray(b.images) ? b.images : []).map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  if (images.some(x => x.length > 2048 || !/^(https?:\/\/|\/api\/images\/|images\/)/.test(x))) throw httpErr(400, 'Imagen no válida');
  return { name, price_cents: cents(price), category_id: cat.id, material: String(b.material || '').slice(0, 200), note: String(b.note || '').slice(0, 200), active: b.active === false || b.active === 0 ? 0 : 1, sizes, images };
}
async function writeProduct(q, id, p, now) {
  const old = {}; (await q(`SELECT size, stock FROM product_sizes WHERE product_id = $1`, [id])).rows.forEach(r => (old[r.size] = num(r.stock)));
  await q(`UPDATE products SET category_id=$1, name=$2, material=$3, price_cents=$4, note=$5, active=$6, updated_at=$7 WHERE id=$8`, [p.category_id, p.name, p.material, p.price_cents, p.note, p.active, now, id]);
  await q(`DELETE FROM product_sizes WHERE product_id = $1`, [id]);
  for (let i = 0; i < p.sizes.length; i++) {
    const s = p.sizes[i]; await q(`INSERT INTO product_sizes (product_id, size, stock, position) VALUES ($1,$2,$3,$4)`, [id, s.size, s.stock, i]);
    const d = s.stock - (old[s.size] || 0); if (d !== 0) await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,$5,'edición admin','',$6)`, [uid(), id, s.size, d, s.stock, now]);
  }
  for (const sz of Object.keys(old)) if (!p.sizes.some(s => s.size === sz)) await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,0,'talla eliminada','',$5)`, [uid(), id, sz, -old[sz], now]);
  await q(`DELETE FROM product_images WHERE product_id = $1`, [id]);
  for (let i = 0; i < p.images.length; i++) await q(`INSERT INTO product_images (id, product_id, url, position) VALUES ($1,$2,$3,$4)`, [uid(), id, p.images[i], i]);
}
async function createProduct(req, b) {
  const p = await cleanProduct(b), now = iso(); let id = slugify(p.name), n = 2;
  while ((await db.query(`SELECT 1 FROM products WHERE id = $1`, [id])).rows.length) id = slugify(p.name) + '-' + n++;
  const pos = num((await db.query(`SELECT COALESCE(MAX(position),0) AS m FROM products`)).rows[0].m) + 1;
  await db.tx(async q => { await q(`INSERT INTO products (id, category_id, name, material, price_cents, note, active, position, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [id, p.category_id, p.name, p.material, p.price_cents, p.note, p.active, pos, now]); await writeProduct(q, id, p, now); });
  return (await shop.catalog(req, { includeInactive: true })).products.find(x => x.id === id);
}
async function updateProduct(req, id, b) {
  if (!(await db.query(`SELECT 1 FROM products WHERE id = $1`, [id])).rows.length) throw httpErr(404, 'Producto no encontrado');
  const p = await cleanProduct(b); await db.tx(q => writeProduct(q, id, p, iso()));
  return (await shop.catalog(req, { includeInactive: true })).products.find(x => x.id === id);
}
async function deleteProduct(id) {
  if (!(await db.query(`SELECT 1 FROM products WHERE id = $1`, [id])).rows.length) throw httpErr(404, 'Producto no encontrado');
  await db.tx(async q => { for (const t of ['product_sizes', 'product_images']) await q(`DELETE FROM ${t} WHERE product_id = $1`, [id]); await q(`DELETE FROM products WHERE id = $1`, [id]); });
  return { ok: true };
}
async function setStock(b) {
  const stock = Number(b.stock); if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw httpErr(400, 'Stock no válido');
  return db.tx(async q => {
    const o = (await q(`SELECT stock FROM product_sizes WHERE product_id = $1 AND size = $2`, [b.productId, b.size])).rows[0]; if (!o) throw httpErr(404, 'Talla no encontrada');
    await q(`UPDATE product_sizes SET stock = $1 WHERE product_id = $2 AND size = $3`, [stock, b.productId, b.size]);
    if (stock !== num(o.stock)) await q(`INSERT INTO stock_log (id,product_id,size,delta,stock_after,reason,ref,created_at) VALUES ($1,$2,$3,$4,$5,'ajuste admin','',$6)`, [uid(), b.productId, b.size, stock - num(o.stock), stock, iso()]);
    return { ok: true, stock };
  });
}

async function createCategory(b) {
  const name = String(b.name || '').trim(); if (!name || name.length > 80) throw httpErr(400, 'Nombre obligatorio');
  let slug = slugify(name), n = 2; while ((await db.query(`SELECT 1 FROM categories WHERE slug = $1`, [slug])).rows.length) slug = slugify(name) + '-' + n++;
  const pos = num((await db.query(`SELECT COALESCE(MAX(position),0) AS m FROM categories`)).rows[0].m) + 1, id = uid();
  await db.query(`INSERT INTO categories (id, slug, name, blurb, position) VALUES ($1,$2,$3,$4,$5)`, [id, slug, name, String(b.blurb || '').slice(0, 300), pos]);
  return { id, slug, name, blurb: b.blurb || '' };
}
async function updateCategory(id, b) {
  const name = String(b.name || '').trim(); if (!name) throw httpErr(400, 'Nombre obligatorio');
  const r = await db.query(`UPDATE categories SET name = $1, blurb = $2 WHERE id = $3`, [name, String(b.blurb || '').slice(0, 300), id]);
  if (!r.rowCount) throw httpErr(404, 'Categoría no encontrada'); return { ok: true };
}
async function deleteCategory(id) {
  if (num((await db.query(`SELECT COUNT(*) AS n FROM products WHERE category_id = $1`, [id])).rows[0].n)) throw httpErr(409, 'No se puede borrar: la categoría tiene productos');
  const r = await db.query(`DELETE FROM categories WHERE id = $1`, [id]); if (!r.rowCount) throw httpErr(404, 'Categoría no encontrada'); return { ok: true };
}

async function uploadImage(req) {
  const buf = await readBody(req, 6 * 1024 * 1024 + 1024);
  if (buf.length < 12) throw httpErr(400, 'Archivo vacío');
  let mime = null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) mime = 'image/jpeg';
  else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) mime = 'image/png';
  else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') mime = 'image/webp';
  if (!mime) throw httpErr(400, 'Formato no válido: usa JPG, PNG o WEBP');
  const id = uid(); await db.query(`INSERT INTO images (id, mime, data, created_at) VALUES ($1,$2,$3,$4)`, [id, mime, buf, iso()]);
  return { id, path: '/api/images/' + id, url: shop.apiBase(req) + '/api/images/' + id };
}

async function exportOrders(req, res, query) {
  const all = (await listOrders({ ...query, limit: 100, page: 1 })), list = [];
  for (let p = 1; p <= Math.ceil(all.total / 100); p++) list.push(...(await listOrders({ ...query, limit: 100, page: p })).orders);
  const rows = list.map(o => [o.id, fmtDateEs(o.date), o.status, o.customer.name, o.customer.email, o.customer.phone, o.customer.address, o.items.map(i => `${i.quantity} x ${i.name} (talla ${i.size})`).join('\n'), o.subtotal, o.discount, o.shipping, o.total, o.discountCode, o.paymentIntent, o.note, o.ambassador]);
  const cols = [['Pedido', 16], ['Fecha', 17], ['Estado', 13], ['Cliente', 22], ['Email', 28], ['Teléfono', 15], ['Dirección', 38], ['Productos', 42], ['Subtotal', 12, 1], ['Descuento', 12, 1], ['Envío', 10, 1], ['Total', 12, 1], ['Código', 12], ['Payment Intent', 30], ['Nota', 30], ['Embajadora', 14]].map(([title, width, money]) => ({ title, width, money: !!money }));
  const buf = buildXlsx({ sheetName: query.code === '1' ? 'Pedidos con código' : 'Pedidos', columns: cols, rows });
  res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="zaiay-${query.code === '1' ? 'pedidos-codigo' : 'pedidos'}.xlsx"`, 'Cache-Control': 'no-store', ...corsHeaders(req) });
  res.end(buf);
}
async function listAlerts() {
  const rows = (await db.query(`SELECT a.id, a.product_id, a.size, a.email, a.created_at, a.notified_at, p.name, s.stock FROM stock_alerts a LEFT JOIN products p ON p.id = a.product_id LEFT JOIN product_sizes s ON s.product_id = a.product_id AND s.size = a.size ORDER BY a.created_at DESC`)).rows;
  return rows.map(r => ({ id: r.id, productId: r.product_id, name: r.name || r.product_id, size: r.size, email: r.email, date: r.created_at, notified: !!r.notified_at, notifiedAt: r.notified_at, stock: num(r.stock) }));
}
async function updateAlerts(b) {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 500);
  for (const id of ids) {
    if (b.action === 'delete') await db.query(`DELETE FROM stock_alerts WHERE id = $1`, [id]);
    else await db.query(`UPDATE stock_alerts SET notified_at = $1 WHERE id = $2`, [b.action === 'pending' ? null : iso(), id]);
  }
  return { ok: true, alerts: await listAlerts() };
}
/** Reembolso desde /admin: total o parcial (importe en euros). Opcionalmente devuelve el stock. */
async function refundOrder(id, b) {
  const row = (await db.query(`SELECT id, payment_intent, total_cents, refunded_cents, status, note FROM orders WHERE id = $1`, [id])).rows[0];
  if (!row) throw httpErr(404, 'Pedido no encontrado');
  if (!row.payment_intent) throw httpErr(400, 'Este pedido no tiene pago de Stripe asociado');
  const left = num(row.total_cents) - num(row.refunded_cents);
  if (left <= 0) throw httpErr(409, 'Este pedido ya está reembolsado del todo');
  const amount = b.amount === undefined || b.amount === '' || b.amount === null ? left : cents(b.amount);
  if (!(amount > 0) || amount > left) throw httpErr(400, `Importe no válido: puedes reembolsar como máximo ${(left / 100).toFixed(2).replace('.', ',')} €`);
  try { await stripe('POST', '/v1/refunds', { payment_intent: row.payment_intent, amount, reason: 'requested_by_customer', metadata: { order_id: id } }); }
  catch (e) { throw httpErr(502, 'Stripe no ha podido hacer el reembolso: ' + e.message); }
  const total = num(row.refunded_cents) + amount, full = total >= num(row.total_cents), now = iso();
  const line = `${new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })}: reembolso ${full && amount === left && num(row.refunded_cents) === 0 ? 'total' : 'parcial'} de ${(amount / 100).toFixed(2).replace('.', ',')} € desde el panel.`;
  await db.query(`UPDATE orders SET refunded_cents = $1, status = CASE WHEN $2 = 1 THEN 'reembolsado' ELSE status END, note = $3, updated_at = $4 WHERE id = $5`, [total, full ? 1 : 0, (row.note ? row.note + '\n' : '') + line, now, id]);
  if (b.restock) await orders.restockOrder(id);
  return orders.orderById(id);
}
module.exports = { refundOrder, listAlerts, updateAlerts, login, requireAdmin, summary, listOrders, updateOrder, listCustomers, createProduct, updateProduct, deleteProduct, setStock, createCategory, updateCategory, deleteCategory, uploadImage, exportOrders };
