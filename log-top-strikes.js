// บันทึก strike ที่มีขนาดสัญญาสะสมมากสุด (Call/Put) ของแต่ละสินทรัพย์ ต่อท้ายลง CSV
// ใช้เป็นแหล่งข้อมูลให้ gen-pine.js สร้าง indicator สำหรับ TradingView
// รันโดย GitHub Actions — ดู sync.yml
//
// รูปแบบ CSV: timestamp_utc,asset,price,top_call_strike,top_call_vol,top_put_strike,top_put_vol

const fs = require('fs');

const ASSETS = [
  { key: 'gold', file: 'IntradayData.txt' },
  { key: 'oil', file: 'Oil-IntradayData.txt' },
  { key: 'es', file: 'ES-IntradayData.txt' },
];

const LOG_FILE = 'top-strikes.csv';
const NEW_DIR = process.argv[2] || '.';
const STAMP = process.argv[3] || new Date().toISOString();

function parseRows(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(3).map((l) => {
    const p = l.split(',');
    return { strike: parseFloat(p[0]), call: parseInt(p[1], 10) || 0, put: parseInt(p[2], 10) || 0 };
  }).filter((r) => !isNaN(r.strike));
}

function parseUnderlying(text) {
  const m = (text.split('\n')[0] || '').match(/vs\s+([-\d.]+)/);
  return m ? parseFloat(m[1]) : '';
}

if (!fs.existsSync(LOG_FILE)) {
  fs.writeFileSync(LOG_FILE, 'timestamp_utc,asset,price,top_call_strike,top_call_vol,top_put_strike,top_put_vol\n');
}

const existing = fs.readFileSync(LOG_FILE, 'utf8');
const lines = [];

for (const asset of ASSETS) {
  const p = NEW_DIR + '/' + asset.file;
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const rows = parseRows(text);
  if (rows.length === 0) continue;
  const price = parseUnderlying(text);
  let topCall = rows[0], topPut = rows[0];
  rows.forEach((r) => {
    if (r.call > topCall.call) topCall = r;
    if (r.put > topPut.put) topPut = r;
  });
  const line = [STAMP, asset.key, price, topCall.strike, topCall.call, topPut.strike, topPut.put].join(',');
  // กันบันทึกซ้ำ timestamp เดิม
  if (!existing.includes(STAMP + ',' + asset.key + ',')) lines.push(line);
}

if (lines.length === 0) {
  console.log('Nothing to log.');
  process.exit(0);
}

fs.appendFileSync(LOG_FILE, lines.join('\n') + '\n');

// เก็บย้อนหลังไม่เกิน 30 วัน กันไฟล์บวม
const all = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
const header = all[0];
const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
const kept = all.slice(1).filter((l) => {
  const t = Date.parse(l.split(',')[0]);
  return !isNaN(t) && t >= cutoff;
});
fs.writeFileSync(LOG_FILE, header + '\n' + kept.join('\n') + '\n');

console.log('Logged ' + lines.length + ' row(s). Total kept: ' + kept.length);
