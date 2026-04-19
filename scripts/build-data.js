import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'yachts_full.json');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const OUT_YACHTS = path.join(OUT_DIR, 'yachts');
const OUT_INDEX = path.join(OUT_DIR, 'index.json');

const UUID_RE = /vessel::([0-9a-f-]{36})$/;

function getLocation(y) {
  const bp = y.blueprint?.basePort;
  const zone = y.pricing?.pricingInfo?.[0]?.inclusionZones?.[0];
  const region = zone?.category?.[0] || zone?.category?.[1];
  const parts = [];
  if (bp?.name) parts.push(bp.name);
  if (bp?.country) parts.push(bp.country);
  if (region && !parts.includes(region)) parts.push(region);
  return parts.length ? parts.join(', ') : '';
}

function buildEntry(y) {
  const m = UUID_RE.exec(y.uri || '');
  if (!m) return null;
  const id = m[1];
  const name = y.blueprint?.name || 'Unnamed';
  const wp = y.pricing?.weekPricingFrom;
  const location = getLocation(y);
  return {
    id,
    name,
    price: typeof wp?.price === 'number' ? wp.price : null,
    currency: wp?.currency || null,
    length: typeof y.blueprint?.length === 'number' ? y.blueprint.length : null,
    sleeps: typeof y.blueprint?.sleeps === 'number' && y.blueprint.sleeps > 0 ? y.blueprint.sleeps : null,
    location,
    firstImage: y.blueprint?.images?.[0] || null,
    imageCount: y.blueprint?.images?.length || 0,
    searchBlob: `${name} ${location}`.toLowerCase(),
  };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Source not found: ${SRC}`);
    process.exit(1);
  }
  console.log(`Reading ${SRC}...`);
  const raw = fs.readFileSync(SRC, 'utf8');
  const yachts = JSON.parse(raw);
  console.log(`Loaded ${yachts.length} records.`);

  fs.mkdirSync(OUT_YACHTS, { recursive: true });

  const index = [];
  let skipped = 0;
  for (const y of yachts) {
    const entry = buildEntry(y);
    if (!entry) { skipped++; continue; }
    index.push(entry);
    fs.writeFileSync(path.join(OUT_YACHTS, `${entry.id}.json`), JSON.stringify(y));
  }

  fs.writeFileSync(OUT_INDEX, JSON.stringify(index));

  const indexSize = fs.statSync(OUT_INDEX).size;
  let totalDetailSize = 0;
  for (const f of fs.readdirSync(OUT_YACHTS)) {
    totalDetailSize += fs.statSync(path.join(OUT_YACHTS, f)).size;
  }

  console.log(`Wrote ${index.length} entries to ${OUT_INDEX} (${(indexSize / 1024).toFixed(1)} KB)`);
  console.log(`Wrote ${index.length} detail files to ${OUT_YACHTS} (${(totalDetailSize / 1024 / 1024).toFixed(1)} MB total)`);
  if (skipped) console.warn(`Skipped ${skipped} records missing UUID.`);
}

main();
