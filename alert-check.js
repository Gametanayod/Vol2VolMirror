// ตรวจจับ volume ผิดปกติ แล้วส่งแจ้งเตือนเข้า Telegram
// ใช้สูตรเดียวกับ dashboard: strike ที่ volume โต >= SENSITIVITY เท่าของค่ากลาง (median)
// รันโดย GitHub Actions — ดู sync.yml
//
// ENV ที่ต้องมี:
//   TELEGRAM_BOT_TOKEN  โทเคนบอทจาก @BotFather
//   TELEGRAM_CHAT_ID    chat id ของคุณ
//   ALERT_SENSITIVITY   (ไม่บังคับ) ค่าความไว default 4
//   ALERT_MIN_DELTA     (ไม่บังคับ) ขั้นต่ำสัญญาที่เพิ่ม default 20

const fs = require('fs');

const ASSETS = [
  { label: 'Gold (GC)', file: 'IntradayData.txt' },
  { label: 'Oil (CL)', file: 'Oil-IntradayData.txt' },
  { label: 'ES (S&P 500)', file: 'ES-IntradayData.txt' },
];

const SENSITIVITY = parseFloat(process.env.ALERT_SENSITIVITY || '4');
const MIN_DELTA = parseInt(process.env.ALERT_MIN_DELTA || '20', 10);
const OLD_DIR = process.argv[2] || '_old';
const NEW_DIR = process.argv[3] || '.';

function parseRows(text) {
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(3).map((l) => {
    const p = l.split(',');
    return { strike: parseFloat(p[0]), call: parseInt(p[1], 10) || 0, put: parseInt(p[2], 10) || 0 };
  }).filter((r) => !isNaN(r.strike));
}

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

const alerts = [];
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

  const totals = deltas.map((d) => d.total).filter((v) => v > 0).sort((a, b) => a - b);
  if (totals.length === 0) continue;
  const baseline = Math.max(totals[Math.floor(totals.length / 2)], 1);

  deltas.forEach((d) => {
    const score = d.total / baseline;
    if (score >= SENSITIVITY && d.total >= MIN_DELTA) {
      alerts.push({ asset: asset.label, ...d, score });
    }
  });
}

if (alerts.length === 0) {
  console.log('No alerts.');
  process.exit(0);
}

alerts.sort((a, b) => b.score - a.score);
const thTime = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

let msg = '⚠️ Vol2Vol Alert — ' + thTime + ' (เวลาไทย)\n\n';
for (const a of alerts.slice(0, 10)) {
  msg += '• ' + a.asset + ' Strike ' + a.strike + '\n';
  msg += '  +' + fmt(a.total) + ' สัญญา/5นาที (Call +' + fmt(a.callDelta) + ', Put +' + fmt(a.putDelta) + ') [' + a.score.toFixed(1) + '×]\n';
}
if (alerts.length > 10) msg += '\n…และอีก ' + (alerts.length - 10) + ' รายการ';

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
