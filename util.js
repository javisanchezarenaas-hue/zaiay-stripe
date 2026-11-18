'use strict';
const crypto = require('crypto');
const httpErr = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});
const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const num = v => Number(v) || 0;
const eur = c => Math.round(num(c)) / 100;
const cents = e => Math.round(Number(e) * 100);
function slugify(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'producto'; }
function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, done = false;
    req.on('data', c => { if (done) return; n += c.length; if (n > limit) { done = true; reject(httpErr(413, 'Archivo o petición demasiado grande')); } else chunks.push(c); });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req, limit) { const b = await readBody(req, limit); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw httpErr(400, 'Datos no válidos'); } }
function send(res, status, obj, headers) { const body = JSON.stringify(obj); res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})); res.end(body); }
function allowedOrigins() {
  const site = (process.env.SITE_URL || 'https://zayai.netlify.app').replace(/\/+$/, '');
  return [site, ...(process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)];
}
function corsHeaders(req) {
  const origin = req.headers.origin; if (!origin) return {};
  const list = allowedOrigins();
  const ok = list.includes('*') || list.includes(origin) || (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  if (!ok) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
}
const hits = new Map();
function limited(req, key, max, windowMs = 60000) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = key + ':' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs); arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(kk);
  return arr.length > max;
}
const TZ = 'Europe/Madrid';
function offsetMs(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(d).find(x => x.type === 'timeZoneName');
  const m = p && p.value.match(/GMT([+-])(\d{2}):?(\d{2})?/); if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2]) * 60 + (+(m[3] || 0))) * 60000;
}
function madridMidnight(y, m, d) { let t = Date.UTC(y, m - 1, d) - offsetMs(new Date(Date.UTC(y, m - 1, d))); return new Date(Date.UTC(y, m - 1, d) - offsetMs(new Date(t))); }
function madridYMD(date) { const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).split('-').map(Number); return { y, m, d }; }
function periods(now = new Date()) { const { y, m, d } = madridYMD(now); return { today: [madridMidnight(y, m, d).toISOString(), madridMidnight(y, m, d + 1).toISOString()], month: [madridMidnight(y, m, 1).toISOString(), madridMidnight(y, m + 1, 1).toISOString()] }; }
const fmtDateEs = s => new Date(s).toLocaleString('es-ES', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
module.exports = { httpErr, iso, uid, num, eur, cents, slugify, readBody, readJson, send, corsHeaders, limited, periods, madridYMD, fmtDateEs };
