'use strict';
const crypto = require('crypto');
const { httpErr } = require('./util');
const CFG = { key: () => process.env.STRIPE_SECRET_KEY || '', webhookSecret: () => process.env.STRIPE_WEBHOOK_SECRET || '', api: () => (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '') };
function enc(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === 'object') ? enc(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)]));
    else if (typeof v === 'object') enc(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(method, pathname, params) {
  const qs = params ? new URLSearchParams(enc(params)).toString() : '';
  const res = await fetch(CFG.api() + pathname + (method === 'GET' && qs ? '?' + qs : ''), { method, headers: { Authorization: 'Bearer ' + CFG.key(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : qs });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(res.status === 404 ? 404 : 502, (data.error && data.error.message) || 'Error de Stripe');
  return data;
}
const couponCache = new Map();
async function ensureCoupon(percent) {
  const id = `ZAIAY-${percent}OFF`; if (couponCache.has(id)) return id;
  try { await stripe('GET', '/v1/coupons/' + id); } catch (e) { if (e.status !== 404) throw e; await stripe('POST', '/v1/coupons', { id, percent_off: percent, duration: 'once', name: `Descuento ${percent}% (código)` }); }
  couponCache.set(id, true); return id;
}
function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  const p = {}; const v1 = [];
  header.split(',').forEach(kv => { const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (k === 'v1') v1.push(v); else p[k] = v; });
  if (!p.t || !v1.length || Math.abs(Date.now() / 1000 - Number(p.t)) > 600) return false;
  const exp = crypto.createHmac('sha256', secret).update(`${p.t}.`).update(raw).digest('hex');
  return v1.some(s => s.length === exp.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp)));
}
module.exports = { stripe, ensureCoupon, verifySignature, CFG };
