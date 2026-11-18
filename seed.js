'use strict';
const db = require('./db');
const { iso, uid, cents } = require('./util');
const SEED = require('./seed-data.json');
/** Carga catálogo e inventario inicial SOLO la primera vez. Después nunca pisa lo que edites en el panel. */
async function run() {
  if ((await db.query(`SELECT value FROM meta WHERE key = $1`, ['seeded'])).rows.length) return false;
  const now = iso();
  await db.tx(async q => {
    const catId = {};
    for (let i = 0; i < SEED.categories.length; i++) { const c = SEED.categories[i]; catId[c.slug] = uid(); await q(`INSERT INTO categories (id, slug, name, blurb, position) VALUES ($1,$2,$3,$4,$5)`, [catId[c.slug], c.slug, c.name, c.blurb, i]); }
    for (let i = 0; i < SEED.products.length; i++) {
      const p = SEED.products[i];
      await q(`INSERT INTO products (id, category_id, name, material, price_cents, note, active, position, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$8)`, [p.id, catId[p.category], p.name, p.material, cents(p.price), p.note || '', i, now]);
      for (let k = 0; k < p.sizes.length; k++) {
        const s = p.sizes[k];
        await q(`INSERT INTO product_sizes (product_id, size, stock, position) VALUES ($1,$2,$3,$4)`, [p.id, s.size, s.stock, k]);
        await q(`INSERT INTO stock_log (id, product_id, size, delta, stock_after, reason, ref, created_at) VALUES ($1,$2,$3,$4,$5,'inventario inicial','',$6)`, [uid(), p.id, s.size, s.stock, s.stock, now]);
      }
      for (let k = 0; k < p.images.length; k++) await q(`INSERT INTO product_images (id, product_id, url, position) VALUES ($1,$2,$3,$4)`, [uid(), p.id, p.images[k], k]);
    }
    await q(`INSERT INTO meta (key, value) VALUES ($1,$2)`, ['seeded', now]);
  });
  console.log(`[seed] ${SEED.products.length} productos cargados con su inventario inicial`);
  return true;
}
/** Si la base ya existía, sustituye las fotos de catálogo antiguas por las nuevas (no toca las subidas desde el panel). */
const IMAGES_VERSION = '2';
async function syncImages() {
  const v = (await db.query(`SELECT value FROM meta WHERE key = $1`, ['images_v'])).rows[0];
  if (v && v.value === IMAGES_VERSION) return false;
  await db.tx(async q => {
    for (const p of SEED.products) {
      if (!(await q(`SELECT 1 FROM products WHERE id = $1`, [p.id])).rows.length) continue;
      const cur = (await q(`SELECT url FROM product_images WHERE product_id = $1 ORDER BY position`, [p.id])).rows.map(r => r.url);
      const keep = cur.filter(u => !u.startsWith('images/'));
      await q(`DELETE FROM product_images WHERE product_id = $1`, [p.id]);
      const all = [...p.images, ...keep];
      for (let k = 0; k < all.length; k++) await q(`INSERT INTO product_images (id, product_id, url, position) VALUES ($1,$2,$3,$4)`, [uid(), p.id, all[k], k]);
    }
    await q(`DELETE FROM meta WHERE key = $1`, ['images_v']);
    await q(`INSERT INTO meta (key, value) VALUES ($1,$2)`, ['images_v', IMAGES_VERSION]);
  });
  console.log('[seed] fotos de catálogo actualizadas');
  return true;
}
/** Todas las prendas (no accesorios) tienen S, M y L; las que falten se crean con stock 0. Una sola vez. */
async function ensureSizes() {
  if ((await db.query(`SELECT value FROM meta WHERE key = $1`, ['sizes_v'])).rows.length) return false;
  const ORDER = ['S', 'M', 'L'];
  await db.tx(async q => {
    const prods = (await q(`SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug <> 'accesorios'`)).rows;
    for (const p of prods) {
      const have = (await q(`SELECT size FROM product_sizes WHERE product_id = $1`, [p.id])).rows.map(r => r.size);
      if (have.includes('Única')) continue;
      for (const z of ORDER) if (!have.includes(z)) await q(`INSERT INTO product_sizes (product_id, size, stock, position) VALUES ($1,$2,0,$3)`, [p.id, z, ORDER.indexOf(z)]);
      for (const z of ORDER) await q(`UPDATE product_sizes SET position = $1 WHERE product_id = $2 AND size = $3`, [ORDER.indexOf(z), p.id, z]);
    }
    await q(`INSERT INTO meta (key, value) VALUES ($1,$2)`, ['sizes_v', '1']);
  });
  return true;
}
module.exports = { run, syncImages, ensureSizes };
