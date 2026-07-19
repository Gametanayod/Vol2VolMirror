// ตรวจจับ volume ผิดปกติ แล้วส่งแจ้งเตือนเข้า Telegram
// เกณฑ์ "สถิติใหม่" (running max):
//   - เริ่มต้นใช้ค่ากลาง (median) ของการเปลี่ยนแปลงในรอบนั้นเป็นเส้นฐาน
//   - ถ้า strike ไหนมีขนาดการเปลี่ยนแปลง "ใหญ่กว่าค่าสูงสุดที่เคยเห็น" ของสินทรัพย์นั้น → แจ้งเตือน และขยับค่าสูงสุดขึ้นเป็นขนาดใหม่
//   - เล็กกว่าหรือเท่าค่าสูงสุดเดิม → ไม่แจ้ง (ตัดการเตือนซ้ำๆ จากขนาดเดิมๆ)
//   - ค่าสูงสุดเก็บใน alert-state.json (commit ไว้ใน repo) และรีเซ็ตเองเมื่อขึ้นวันใหม่ (เวลาไทย)
// รันโดย GitHub Actions — ดู sync.yml
//
// ENV ที่ต้องมี:
//   TELEGRAM_BOT_TOKEN   โทเคนบอทจาก @BotFather
//   TELEGRAM_CHAT_ID     chat id ของคุณ

const fs = require('fs');

const ASSETS = [
  { key: 'gold', label: 'Gold (GC)', file: 'IntradayData.txt' },
  { key: 'oil', label: 'Oil (CL)', file: 'Oil-IntradayData.txt' },
  { key: 'es', label: 'ES (S&P 500)', file: 'ES-IntradayData.txt' },
];

const OLD_DIR = process.argv[2] || '_old';
const NEW_DIR = process.argv[3] || '.';
const STATE_FILE = 'alert-state.json';

function thDayKey(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // ขึ้นวันใหม่ (เวลาไทย) → รีเซ็ตค่าสูงสุด
    if (s.day !== thDayKey(new Date())) return { day: thDayKey(new Date()), max: {} };
    return s;
  } catch (e) {
    return { day: thDayKey(new Date()), max: {} };
  }
}

function parseRows(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(3).map((l) => {
    const p = l.split(',');
    return { strike: parseFloat(p[0]), call: parseInt(p[1], 10) || 0, put: parseInt(p[2], 10) || 0 };
  }).filter((r) => !isNaN(r.strike));
}

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

const state = loadState();
const alerts = [];
const summaries = []; // top Call/Put สะสมของทุกสินทรัพย์ — แนบท้ายข้อความเสมอเมื่อมี alert
for (const asset of ASSETS) {
  const oldPath = OLD_DIR + '/' + asset.file;
  const newPath = NEW_DIR + '/' + asset.file;
  if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) continue;
  const oldRows = parseRows(fs.readFileSync(oldPath, 'utf8'));
  const newRows = parseRows(fs.readFileSync(newPath, 'utf8'));
  const oldMap = {};
  oldRows.forEach((r) => { oldMap[r.strike] = r; });

  const deltas = newRows.map((r) => {
    const p = oldMap[r.strike];
    const callDelta = Math.max(0, r.call - (p ? p.call : 0));
    const putDelta = Math.max(0, r.put - (p ? p.put : 0));
    return { strike: r.strike, callDelta, putDelta, total: callDelta + putDelta };
  });

  // strike ที่มีขนาดสัญญาสะสม (ไม่ใช่ค่าเปลี่ยนแปลง) สูงสุดของแต่ละฝั่ง
  let topCall = null, topPut = null;
  newRows.forEach((r) => {
    if (!topCall || r.call > topCall.call) topCall = r;
    if (!topPut || r.put > topPut.put) topPut = r;
  });
  summaries.push({ asset: asset.label, topCall, topPut });

  // เส้นฐานเริ่มต้น = ค่ากลาง (median) ของการเปลี่ยนแปลงในรอบนี้
  const totals = deltas.map((d) => d.total).filter((v) => v > 0).sort((a, b) => a - b);
  if (totals.length === 0) continue;
  const median = Math.max(totals[Math.floor(totals.length / 2)], 1);

  // ค่าสูงสุดที่เคยเห็นของวันนี้ (เริ่มที่ median)
  let currentMax = Math.max(state.max[asset.key] || 0, median);

  // เรียงจากมากไปน้อย — แจ้งเฉพาะตัวที่ทำ new high เทียบค่าสูงสุดขณะนั้น
  deltas.sort((a, b) => b.total - a.total);
  for (const d of deltas) {
    if (d.total > currentMax) {
      alerts.push({ asset: asset.label, ...d, prevMax: currentMax });
      currentMax = d.total; // ขยับเพดานขึ้น — ขนาดเท่าเดิมจะไม่เตือนซ้ำอีก
    }
  }
  state.max[asset.key] = currentMax;
}

// บันทึกค่าสูงสุดล่าสุดไว้เสมอ (แม้ไม่มี alert) — sync.yml จะ commit ไฟล์นี้ไปด้วย
fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

if (alerts.length === 0) {
  console.log('No new-high alerts. Current max: ' + JSON.stringify(state.max));
  process.exit(0);
}

alerts.sort((a, b) => b.total - a.total);
const thTime = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let msg = '⚠️ Vol2Vol New High — ' + thTime + ' (เวลาไทย)\n\n';
for (const a of alerts.slice(0, 10)) {
  msg += '• ' + a.asset + ' Strike ' + a.strike + '\n';
  msg += '  +' + fmt(a.total) + ' สัญญา/รอบ (Call +' + fmt(a.callDelta) + ', Put +' + fmt(a.putDelta) + ') ทำลายสถิติเดิม ' + fmt(a.prevMax) + '\n';
}
if (alerts.length > 10) msg += '…และอีก ' + (alerts.length - 10) + ' รายการ\n';

// สรุป Call/Put สะสมมากสุดของ "ทุกสินทรัพย์" — แสดงเสมอแม้สินทรัพย์นั้นไม่เข้าเงื่อนไข new high
msg += '\n📊 สรุปขนาดสัญญาสะสมทุกสินทรัพย์\n';
for (const s of summaries) {
  msg += '• ' + s.asset + '\n';
  if (s.topCall) msg += '  Call มากสุด: Strike ' + s.topCall.strike + ' (' + fmt(s.topCall.call) + ' สัญญา)\n';
  if (s.topPut) msg += '  Put มากสุด: Strike ' + s.topPut.strike + ' (' + fmt(s.topPut.put) + ' สัญญา)\n';
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  process.exit(1);
}

fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text: msg }),
})
  .then((r) => r.json())
  .then((j) => {
    if (!j.ok) { console.error('Telegram error:', JSON.stringify(j)); process.exit(1); }
    console.log('Sent ' + alerts.length + ' alert(s) to Telegram.');
  })
  .catch((e) => { console.error(e); process.exit(1); });
