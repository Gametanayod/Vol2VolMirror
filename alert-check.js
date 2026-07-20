// ตรวจจับ volume ผิดปกติ แล้วส่งแจ้งเตือนเข้า Telegram
// เกณฑ์ "สถิติใหม่" (running max):
//   - เริ่มต้นใช้ค่ากลาง (median) ของการเปลี่ยนแปลงในรอบนั้นเป็นเส้นฐาน
//   - ถ้า strike ไหนมีขนาดการเปลี่ยนแปลง "ใหญ่กว่าค่าสูงสุดที่เคยเห็น" ของสินทรัพย์นั้น → แจ้งเตือน และขยับค่าสูงสุดขึ้นเป็นขนาดใหม่
//   - เล็กกว่าหรือเท่าค่าสูงสุดเดิม → ไม่แจ้ง (ตัดการเตือนซ้ำๆ จากขนาดเดิมๆ)
//   - ค่าสูงสุดเก็บใน alert-state.json (commit ไว้ใน repo) และรีเซ็ตเมื่อขึ้นวันใหม่ (เวลาไทย)
//     หรือเมื่อตรวจพบ session reset (ผลรวม volume ถูกล้างกลับใกล้ 0 = เริ่มรอบซื้อขายใหม่)
// รันโดย GitHub Actions — ดู sync.yml
//
// ENV ที่ต้องมี:
//   TELEGRAM_BOT_TOKEN   โทเคนบอทจาก @BotFather
//   TELEGRAM_CHAT_ID     chat id ของคุณ

const fs = require('fs');

const ASSETS = [
  { key: 'gold', label: 'Gold (GC)', file: 'IntradayData.txt', near: 5 },
  { key: 'oil', label: 'Oil (CL)', file: 'Oil-IntradayData.txt', near: 0.5 },
  { key: 'es', label: 'ES (S&P 500)', file: 'ES-IntradayData.txt', near: 10 },
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
    if (s.day !== thDayKey(new Date())) return { day: thDayKey(new Date()), max: {}, near: {} };
    if (!s.near) s.near = {};
    return s;
  } catch (e) {
    return { day: thDayKey(new Date()), max: {}, near: {} };
  }
}

// ราคาจริงของ underlying อยู่ในบรรทัดหัว: "... vs 4137.2 (-20.2) - ..."
function parseUnderlying(text) {
  const head = text.split('\n')[0] || '';
  const m = head.match(/vs\s+([-\d.]+)/);
  return m ? parseFloat(m[1]) : null;
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
const proximityAlerts = []; // เตือนเมื่อราคาจริงเข้าใกล้ strike ที่มีขนาดสัญญาสะสมมากสุด
const summaries = []; // top Call/Put สะสมของทุกสินทรัพย์ — แนบท้ายข้อความเสมอเมื่อมี alert
for (const asset of ASSETS) {
  const oldPath = OLD_DIR + '/' + asset.file;
  const newPath = NEW_DIR + '/' + asset.file;
  if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) continue;
  const oldText = fs.readFileSync(oldPath, 'utf8');
  const newText = fs.readFileSync(newPath, 'utf8');
  const oldRows = parseRows(oldText);
  const newRows = parseRows(newText);
  const price = parseUnderlying(newText);
  const oldMap = {};
  oldRows.forEach((r) => { oldMap[r.strike] = r; });

  // ตรวจ session reset: intraday volume สะสมทั้งวัน ถ้าเริ่มรอบใหม่ค่าจะถูกล้างกลับใกล้ 0
  // เทียบผลรวม volume ใหม่กับรอบก่อน — ถ้าลดฮวบ (< ครึ่งของเดิม) ถือว่าเข้ารอบใหม่ → รีเซ็ตค่าสูงสุดของสินทรัพย์นั้น
  const oldSum = oldRows.reduce((s, r) => s + r.call + r.put, 0);
  const newSum = newRows.reduce((s, r) => s + r.call + r.put, 0);
  if (oldSum > 0 && newSum < oldSum * 0.5) {
    state.max[asset.key] = 0;
  }

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

  // ---- เงื่อนไข: ราคาจริงเข้าใกล้ strike ที่มีขนาดสัญญาสะสมมากสุด ----
  // เตือนครั้งเดียวต่อ strike (เก็บใน state.near) จนกว่าราคาจะออกจากโซนแล้วค่อยกลับเข้าใหม่
  if (price != null) {
    [{ side: 'Call', top: topCall, vol: topCall && topCall.call }, { side: 'Put', top: topPut, vol: topPut && topPut.put }].forEach((x) => {
      if (!x.top) return;
      const dist = Math.abs(price - x.top.strike);
      const stKey = asset.key + '_' + x.side;
      const wasNear = state.near[stKey];
      const key = x.top.strike;
      if (dist <= asset.near) {
        if (wasNear !== key) {
          proximityAlerts.push({ asset: asset.label, side: x.side, strike: x.top.strike, price, vol: x.vol, dist });
          state.near[stKey] = key; // เตือนแล้ว ไม่เตือนซ้ำสำหรับ strike เดิม
        }
      } else if (wasNear === key) {
        state.near[stKey] = null; // ออกจากโซนของ strike นี้แล้ว — พร้อมเตือนใหม่ถ้ากลับเข้ามา
      }
    });
  }

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

if (alerts.length === 0 && proximityAlerts.length === 0) {
  console.log('No alerts. Current max: ' + JSON.stringify(state.max));
  process.exit(0);
}

alerts.sort((a, b) => b.total - a.total);
const thTime = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let msg = '⚠️ Vol2Vol — ' + thTime + ' (เวลาไทย)\n';

// ---- กลุ่ม 1: ขนาดสัญญาทำลายสถิติ (new high) ----
if (alerts.length > 0) {
  msg += '\n🔺 ขนาดสัญญาเข้าใหม่ทำลายสถิติ\n';
  for (const a of alerts.slice(0, 10)) {
    msg += '• ' + a.asset + ' Strike ' + a.strike + '\n';
    msg += '  +' + fmt(a.total) + ' สัญญา/รอบ (Call +' + fmt(a.callDelta) + ', Put +' + fmt(a.putDelta) + ') ทำลายสถิติเดิม ' + fmt(a.prevMax) + '\n';
  }
  if (alerts.length > 10) msg += '…และอีก ' + (alerts.length - 10) + ' รายการ\n';
}

// ---- กลุ่ม 2: ราคาจริงเข้าใกล้ strike ที่มีขนาดสัญญาสะสมมากสุด ----
if (proximityAlerts.length > 0) {
  msg += '\n🎯 ราคาเข้าใกล้ strike ที่มีสัญญาสะสมมากสุด\n';
  for (const p of proximityAlerts) {
    msg += '• ' + p.asset + ': ราคา ' + p.price + ' ใกล้ ' + p.side + ' Strike ' + p.strike + ' (' + fmt(p.vol) + ' สัญญา, ห่าง ' + (Math.round(p.dist * 100) / 100) + ')\n';
  }
}

// ---- สรุป Call/Put สะสมมากสุดของทุกสินทรัพย์ ----
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
    console.log('Sent ' + alerts.length + ' new-high + ' + proximityAlerts.length + ' proximity alert(s).');
  })
  .catch((e) => { console.error(e); process.exit(1); });
