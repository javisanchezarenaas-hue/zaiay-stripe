'use strict';
const http = require('http');
const db = require('./lib/db');
const { migrate } = require('./lib/schema');
const seed = require('./lib/seed');
const shop = require('./lib/shop');
const orders = require('./lib/orders');
const admin = require('./lib/admin');
const { verifySignature, CFG } = require('./lib/stripe');
const { httpErr, send, readBody, readJson, corsHeaders, limited } = require('./lib/util');

async function webhook(req, res, cors) {
  const raw = await readBody(req, 1024 * 1024);
  const secret = CFG.webhookSecret();
  if (!secret) return send(res, 503, { error: 'Falta STRIPE_WEBHOOK_SECRET' }, cors);
  if (!verifySignature(raw, req.headers['stripe-signature'], secret)) return send(res, 400, { error: 'Firma no válida' }, cors);
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { error: 'JSON no válido' }, cors); }
  const o = ev.data && ev.data.object || {};
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') await orders.processPaidSession(o.id, 'webhook');
  else if (ev.type === 'charge.refunded') await orders.markRefunded(typeof o.payment_intent === 'string' ? o.payment_intent : '');
  return send(res, 200, { received: true }, cors);
}

async function route(req, res) {
  const cors = corsHeaders(req), url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/', m = req.method;
  if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (p === '/' || p === '/health') return send(res, 200, { ok: true, service: 'zaiay-api', db: db.driver() }, cors);
  if (m === 'POST' && (p === '/api/stripe-webhook' || p === '/webhook')) return webhook(req, res, cors);
  if (m === 'GET' && p === '/api/config') return send(res, 200, await shop.publicConfig(), cors);
  if (m === 'GET' && (p === '/api/products' || p === '/api/catalog')) return send(res, 200, await shop.catalog(req), cors);
  if (m === 'POST' && p === '/api/stock-alert') { if (limited(req, 'alert', 10)) throw httpErr(429, 'Demasiadas peticiones, espera un momento'); return send(res, 200, await shop.stockAlert(await readJson(req)), cors); }
  if (m === 'POST' && p === '/api/validate-code') { if (limited(req, 'code', 30)) throw httpErr(429, 'Demasiados intentos'); return send(res, 200, await shop.validateCode((await readJson(req)).code), cors); }
  if (m === 'POST' && (p === '/api/checkout' || p === '/create-checkout-session')) { if (limited(req, 'checkout', 20)) throw httpErr(429, 'Demasiadas peticiones, espera un momento'); return send(res, 200, await shop.checkout(req, await readJson(req)), cors); }
  if (m === 'GET' && p === '/api/checkout-session') return send(res, 200, await shop.checkoutInfo(url.searchParams.get('session_id')), cors);
  let g;
  if (m === 'GET' && (g = /^\/api\/images\/([\w-]+)$/.exec(p))) return shop.serveImage(req, res, g[1]);

  if (m === 'POST' && p === '/api/admin/login') { if (limited(req, 'login', 10, 600000)) throw httpErr(429, 'Demasiados intentos. Espera unos minutos.'); return send(res, 200, admin.login((await readJson(req)).password), cors); }
  if (p.startsWith('/api/admin/')) {
    admin.requireAdmin(req); const q = Object.fromEntries(url.searchParams);
    if (m === 'GET' && p === '/api/admin/stock-alerts') return send(res, 200, { alerts: await admin.listAlerts() }, cors);
    if (m === 'PATCH' && p === '/api/admin/stock-alerts') return send(res, 200, await admin.updateAlerts(await readJson(req)), cors);
    if (m === 'GET' && p === '/api/admin/settings') return send(res, 200, await shop.publicConfig(), cors);
    if (m === 'PUT' && p === '/api/admin/settings') return send(res, 200, await shop.saveShippingSettings(await readJson(req)), cors);
    if (m === 'GET' && p === '/api/admin/summary') return send(res, 200, await admin.summary(req), cors);
    if (m === 'GET' && p === '/api/admin/orders') return send(res, 200, await admin.listOrders(q), cors);
    if (m === 'PATCH' && (g = /^\/api\/admin\/orders\/([\w-]+)$/.exec(p))) return send(res, 200, await admin.updateOrder(g[1], await readJson(req)), cors);
    if (m === 'GET' && p === '/api/admin/customers') return send(res, 200, { customers: await admin.listCustomers() }, cors);
    if (m === 'GET' && p === '/api/admin/products') return send(res, 200, await shop.catalog(req, { includeInactive: true }), cors);
    if (m === 'POST' && p === '/api/admin/products') return send(res, 201, await admin.createProduct(req, await readJson(req)), cors);
    if (m === 'PUT' && (g = /^\/api\/admin\/products\/([\w-]+)$/.exec(p))) return send(res, 200, await admin.updateProduct(req, g[1], await readJson(req)), cors);
    if (m === 'DELETE' && (g = /^\/api\/admin\/products\/([\w-]+)$/.exec(p))) return send(res, 200, await admin.deleteProduct(g[1]), cors);
    if (m === 'PUT' && p === '/api/admin/stock') return send(res, 200, await admin.setStock(await readJson(req)), cors);
    if (m === 'POST' && p === '/api/admin/categories') return send(res, 201, await admin.createCategory(await readJson(req)), cors);
    if (m === 'PUT' && (g = /^\/api\/admin\/categories\/([\w-]+)$/.exec(p))) return send(res, 200, await admin.updateCategory(g[1], await readJson(req)), cors);
    if (m === 'DELETE' && (g = /^\/api\/admin\/categories\/([\w-]+)$/.exec(p))) return send(res, 200, await admin.deleteCategory(g[1]), cors);
    if (m === 'POST' && p === '/api/admin/images') return send(res, 201, await admin.uploadImage(req), cors);
    if (m === 'GET' && p === '/api/admin/export/orders.xlsx') return admin.exportOrders(req, res, q);
  }
  return send(res, 404, { error: 'No encontrado' }, cors);
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => {
    const status = e.status || 500; if (status >= 500) console.error('[error]', req.method, req.url, e);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !e.status ? 'Error del servidor' : e.message, code: e.code && typeof e.code === 'string' && e.status ? e.code : undefined }, corsHeaders(req));
  });
});
server.headersTimeout = 20000; server.requestTimeout = 60000;

(async () => {
  await db.init(); await migrate(); await seed.run(); await seed.syncImages(); await seed.ensureSizes();
  const port = process.env.PORT || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`ZAIAY API escuchando en :${port} (db: ${db.driver()})`));
})().catch(e => { console.error('Arranque fallido:', e.message); process.exit(1); });
module.exports = server;
