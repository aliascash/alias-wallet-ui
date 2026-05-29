// Convert Qt .ts translation files → JSON map { source: translated }.
// Run from alias-wallet-desktop/ with:
//   node scripts/convert-translations.js
// Reads from ../alias-modernized/src/qt/locale/*.ts and writes
// src/translations/<locale>.json.

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const srcDir = path.resolve(__dirname, '..', '..', 'alias-modernized', 'src', 'qt', 'locale');
const dstDir = path.resolve(__dirname, '..', 'src', 'translations');

// Some .ts files are very large; cap each file's size and message count.
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
});

if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.ts'));
let totalKeys = 0;
for (const f of files) {
  const locale = f.replace(/^alias_/, '').replace(/\.ts$/, '');
  const xml = fs.readFileSync(path.join(srcDir, f), 'utf8');
  let parsed;
  try { parsed = parser.parse(xml); }
  catch (e) { console.warn(`skip ${f}: ${e.message}`); continue; }
  const ctxList = parsed && parsed.TS && parsed.TS.context;
  const ctxArr = Array.isArray(ctxList) ? ctxList : ctxList ? [ctxList] : [];
  const map = {};
  for (const ctx of ctxArr) {
    const msgs = ctx && ctx.message;
    const msgArr = Array.isArray(msgs) ? msgs : msgs ? [msgs] : [];
    for (const m of msgArr) {
      const src = m && (typeof m.source === 'string' ? m.source : (m.source && m.source['#text']));
      const tr  = m && (typeof m.translation === 'string' ? m.translation : (m.translation && m.translation['#text']));
      if (src && tr && tr !== src) map[src] = tr;
    }
  }
  if (Object.keys(map).length > 0) {
    fs.writeFileSync(path.join(dstDir, `${locale}.json`), JSON.stringify(map));
    totalKeys += Object.keys(map).length;
    console.log(`${locale}: ${Object.keys(map).length} entries`);
  }
}
console.log(`Total: ${totalKeys} entries across ${files.length} files`);
