'use strict';
const db = require('./db');
const { stripe, ensureCoupon } = require('./stripe');
const { httpErr, num, eur, cents, send, corsHeaders } = require('./util');
const orders = require('./orders');

function cfg() {
  const pct = Math.min(90, Math.max(1, Number(process.env.DISCOUNT_PERCENT) || 10));
  return {
    site: (process.env.SITE_URL || 'https://zayai.netlify.app').replace(/\/+$/, ''),
    codes: (process.env.DISCOUNT_CODES || 'ZAIAY10').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    percent: pct,
  };
}
/** Envío: coste y umbral de envío gratis. Editables desde /admin (tabla meta); por defecto 4,95 € y gratis desde 70 €. */
async function shippingSettings() {
  const rows = (await db.query(`SELECT key, value FROM meta WHERE key IN ('shipping_cents','free_shipping_cents')`)).rows;
  const m = {}; rows.forEach(r => (m[r.key] = Number(r.value)));
  const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' && isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);
  return {
    shipping: Number.isFinite(m.shipping_cents) ? m.shipping_cents : Math.max(0, cents(env('SHIPPING_EUR', 4.95))),
    freeFrom: Number.isFinite(m.free_shipping_cents) ? m.free_shipping_cents : Math.max(0, cents(env('FREE_SHIPPING_FROM_EUR', 70))),
  };
}
async function saveShippingSettings(b) {
  const ship = Number(b.shippingEur), free = Number(b.freeShippingFromEur);
  if (!isFinite(ship) || ship < 0 || ship > 100) throw httpErr(400, 'Coste de envío no válido');
  if (!isFinite(free) || free < 0 || free > 10000) throw httpErr(400, 'Importe de envío gratis no válido');
  for (const [k, v] of [['shipping_cents', cents(ship)], ['free_shipping_cents', cents(free)]]) { await db.query(`DELETE FROM meta WHERE key = $1`, [k]); await db.query(`INSERT INTO meta (key, value) VALUES ($1,$2)`, [k, String(v)]); }
  return publicConfig();
}
/** Coste de envío para un importe de productos ya con descuento (céntimos). freeFrom = 0 desactiva el envío gratis. */
function shippingFor(netCents, s) { return s.freeFrom > 0 && netCents >= s.freeFrom ? 0 : s.shipping; }
function apiBase(req) {
  if (process.env.API_URL) return process.env.API_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
async function publicConfig() { const c = cfg(), s = await shippingSettings(); return { discountPercent: c.percent, shippingEur: eur(s.shipping), freeShippingFromEur: eur(s.freeFrom), shippingText: 'Envíos a toda España', currency: 'EUR' }; }

/** includeInactive = vista de admin (con cantidades). La vista pública solo dice si cada talla está disponible. */
async function catalog(req, { includeInactive = false } = {}) {
  const base = apiBase(req);
  const cats = (await db.query(`SELECT id, slug, name, blurb FROM categories ORDER BY position, name`)).rows;
  const prods = (await db.query(`SELECT p.id, p.category_id, p.name, p.material, p.price_cents, p.note, p.active, c.slug AS cat_slug FROM products p JOIN categories c ON c.id = p.category_id ${includeInactive ? '' : 'WHERE p.active = 1'} ORDER BY p.position, p.created_at`)).rows;
  const sizes = (await db.query(`SELECT product_id, size, stock FROM product_sizes ORDER BY position`)).rows;
  const imgs = (await db.query(`SELECT product_id, url FROM product_images ORDER BY position`)).rows;
  const sz = {}, im = {};
  sizes.forEach(s => (sz[s.product_id] = sz[s.product_id] || []).push({ size: s.size, stock: num(s.stock) }));
  imgs.forEach(i => (im[i.product_id] = im[i.product_id] || []).push(i.url.startsWith('/api/images/') ? base + i.url : i.url));
  const products = prods.map(p => {
    const s = sz[p.id] || [], total = s.reduce((a, x) => a + x.stock, 0);
    return { id: p.id, name: p.name, category: p.cat_slug, categoryId: p.category_id, material: p.material, price: eur(p.price_cents), priceCents: num(p.price_cents), note: p.note, active: !!num(p.active), sizes: s, images: im[p.id] || [], totalStock: total, soldOut: total <= 0 };
  });
  if (includeInactive) return { categories: cats, products };
  return { categories: cats, products: products.map(p => ({ ...p, sizes: p.sizes.map(s => ({ size: s.size, available: s.stock > 0 })), totalStock: undefined, low: !p.soldOut && p.totalStock <= 3 })) };
}

async function validateCode(code) {
  const c = cfg(), up = String(code || '').trim().toUpperCase();
  return c.codes.includes(up) ? { valid: true, code: up, percent: c.percent } : { valid: false, percent: 0 };
}

async function checkout(req, body) {
  const c = cfg();
  if (!process.env.STRIPE_SECRET_KEY) throw httpErr(503, 'Pagos no disponibles: falta configurar STRIPE_SECRET_KEY en el servidor.');
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length || raw.length > 40) throw httpErr(400, 'El carrito está vacío');
  const merged = new Map();
  for (const it of raw) {
    const id = String(it.id || ''), size = String(it.size || ''), qty = Math.floor(Number(it.qty));
    if (!id || !size || !(qty >= 1) || qty > 50) throw httpErr(400, 'Artículo no válido en el carrito');
    const k = id + '\u0000' + size; const m = merged.get(k);
    if (m) m.qty += qty; else merged.set(k, { id, size, qty });
  }
  const lines = [];
  for (const it of merged.values()) {
    const r = (await db.query(`SELECT p.id, p.name, p.price_cents, p.active, s.stock FROM products p JOIN product_sizes s ON s.product_id = p.id WHERE p.id = $1 AND s.size = $2`, [it.id, it.size])).rows[0];
    if (!r || !num(r.active)) throw httpErr(409, 'Un artículo de tu carrito ya no está disponible. Revisa el carrito.', { code: 'unavailable' });
    const stock = num(r.stock);
    if (stock <= 0) throw httpErr(409, `${r.name} (talla ${it.size}) está agotado.`, { code: 'sold_out' });
    if (it.qty > stock) throw httpErr(409, `No hay unidades suficientes de ${r.name} (talla ${it.size}). Prueba con menos cantidad.`, { code: 'low_stock' });
    const img = (await db.query(`SELECT url FROM product_images WHERE product_id = $1 ORDER BY position LIMIT 1`, [it.id])).rows[0];
    lines.push({ id: it.id, name: r.name, size: it.size, qty: it.qty, unit: num(r.price_cents), img: img ? img.url : '' });
  }
  const meta = {}; let n = 0;
  const lineItems = lines.map((l, i) => {
    meta['item_' + i] = `${l.id}|${l.size}|${l.qty}|${l.unit}`; n++;
    let image; if (l.img) image = /^https?:\/\//.test(l.img) ? l.img : l.img.startsWith('/') ? apiBase(req) + l.img : `${c.site}/${l.img}`;
    return { quantity: l.qty, price_data: { currency: 'eur', unit_amount: l.unit, product_data: { name: `${l.name} — Talla ${l.size}`, description: `ID ${l.id} · Talla ${l.size} · ${l.qty} x ${(l.unit / 100).toFixed(2)} € = ${(l.qty * l.unit / 100).toFixed(2)} €`, images: image ? [image] : undefined, metadata: { product_id: l.id, product_name: l.name, size: l.size, quantity: l.qty } } } };
  });
  meta.item_count = n;
  const params = {
    mode: 'payment', locale: 'es', line_items: lineItems,
    success_url: `${c.site}/success.html?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${c.site}/cancel.html`,
    shipping_address_collection: { allowed_countries: ['ES'] }, phone_number_collection: { enabled: true },
    metadata: meta, payment_intent_data: { metadata: { ...meta } },
  };
  const v = body.code ? await validateCode(body.code) : { valid: false };
  if (body.code && !v.valid) throw httpErr(400, 'Código de descuento no válido', { code: 'bad_code' });
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unit, 0);
  const net = subtotal - (v.valid ? Math.round(subtotal * v.percent / 100) : 0);
  const shipCents = shippingFor(net, await shippingSettings());
  params.shipping_options = [{ shipping_rate_data: { type: 'fixed_amount', display_name: shipCents ? 'Envío a toda España' : 'Envío gratis a toda España', fixed_amount: { amount: shipCents, currency: 'eur' } } }];
  if (v.valid) { params.discounts = [{ coupon: await ensureCoupon(v.percent) }]; params.metadata.discount_code = v.code; params.payment_intent_data.metadata.discount_code = v.code; }
  const s = await stripe('POST', '/v1/checkout/sessions', params);
  return { url: s.url, id: s.id };
}

async function checkoutInfo(sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId || '')) throw httpErr(400, 'Sesión no válida');
  let order = await orders.orderBySession(sessionId);
  if (!order) {
    const r = await orders.processPaidSession(sessionId, 'success-page');
    if (!r.order) return { status: r.status === 'unpaid' ? 'unpaid' : 'pending' };
    order = r.order;
  }
  return { status: order.status === 'sin_stock' ? 'sin_stock' : 'paid', order: { id: order.id, total: order.total, email: order.customer.email, items: order.items } };
}

/** Aviso de reposición: guarda el email para avisar cuando vuelva una talla agotada. */
async function stockAlert(b) {
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw httpErr(400, 'Escribe un email válido');
  const r = (await db.query(`SELECT stock FROM product_sizes WHERE product_id = $1 AND size = $2`, [String(b.productId || ''), String(b.size || '')])).rows[0];
  if (!r) throw httpErr(400, 'Talla no válida');
  if (num(r.stock) > 0) return { ok: true, inStock: true };
  try { await db.query(`INSERT INTO stock_alerts (id, product_id, size, email, created_at) VALUES ($1,$2,$3,$4,$5)`, [require('./util').uid(), b.productId, b.size, email, require('./util').iso()]); }
  catch (e) { if (!db.isUnique(e)) throw e; await db.query(`UPDATE stock_alerts SET notified_at = NULL WHERE product_id = $1 AND size = $2 AND email = $3`, [b.productId, b.size, email]); }
  return { ok: true };
}

async function serveImage(req, res, id) {
  const r = (await db.query(`SELECT mime, data FROM images WHERE id = $1`, [id])).rows[0];
  if (!r) return send(res, 404, { error: 'Imagen no encontrada' }, corsHeaders(req));
  res.writeHead(200, { 'Content-Type': r.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', ...corsHeaders(req) });
  res.end(Buffer.from(r.data));
}
module.exports = { cfg, apiBase, publicConfig, shippingSettings, saveShippingSettings, shippingFor, catalog, validateCode, checkout, checkoutInfo, serveImage, stockAlert };
