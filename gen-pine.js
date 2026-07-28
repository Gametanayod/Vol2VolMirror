// สร้างไฟล์ Pine Script (TradingView) จาก top-strikes.csv
// Pine ไม่สามารถ fetch ข้อมูลภายนอกได้ จึงต้องฝังข้อมูลลงในสคริปต์โดยตรง
// ไฟล์ผลลัพธ์: pine/gold.pine, pine/oil.pine, pine/es.pine
// รันโดย GitHub Actions — ดู sync.yml

const fs = require('fs');

const LOG_FILE = 'top-strikes.csv';
const OUT_DIR = 'pine';
const MAX_SEGMENTS = 500; // ขีดจำกัดจำนวนเส้นของ TradingView

const ASSETS = {
  gold: { label: 'Gold (GC)', title: 'Vol2Vol Top Strikes — Gold' },
  oil: { label: 'Oil (CL)', title: 'Vol2Vol Top Strikes — Oil' },
  es: { label: 'ES (S&P 500)', title: 'Vol2Vol Top Strikes — ES' },
};

if (!fs.existsSync(LOG_FILE)) {
  console.log('No log file yet.');
  process.exit(0);
}

const rows = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(1)
  .map((l) => {
    const [ts, asset, price, tcS, tcV, tpS, tpV] = l.split(',');
    return { t: Date.parse(ts), asset, callStrike: parseFloat(tcS), callVol: parseInt(tcV, 10), putStrike: parseFloat(tpS), putVol: parseInt(tpV, 10) };
  })
  .filter((r) => !isNaN(r.t) && !isNaN(r.callStrike));

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// รวม snapshot ที่ strike เท่ากันติดกันเป็น "ช่วงเวลาเดียว" → ได้เส้นตรงจากเวลาหนึ่งไปอีกเวลาหนึ่ง
function toSegments(list, strikeKey, volKey) {
  const segs = [];
  let cur = null;
  for (const r of list) {
    const s = r[strikeKey];
    if (cur && cur.strike === s) {
      cur.end = r.t;
      cur.vol = Math.max(cur.vol, r[volKey]);
    } else {
      if (cur) segs.push(cur);
      cur = { strike: s, start: r.t, end: r.t, vol: r[volKey] };
    }
  }
  if (cur) segs.push(cur);
  // ต่อปลายเส้นให้ชนจุดเริ่มของช่วงถัดไป เพื่อให้เส้นต่อเนื่องไม่ขาดช่วง
  for (let i = 0; i < segs.length - 1; i++) segs[i].end = segs[i + 1].start;
  return segs.slice(-MAX_SEGMENTS);
}

for (const [key, meta] of Object.entries(ASSETS)) {
  const list = rows.filter((r) => r.asset === key).sort((a, b) => a.t - b.t);
  if (list.length === 0) continue;

  const callSegs = toSegments(list, 'callStrike', 'callVol');
  const putSegs = toSegments(list, 'putStrike', 'putVol');
  const arr = (v) => '[' + v.join(', ') + ']';

  const pine = `// © Vol2Vol Dashboard — auto-generated ${new Date().toISOString()}
// ข้อมูล: strike ที่มีขนาดสัญญาสะสมมากสุด (Call/Put) ของ ${meta.label}
// อัปเดตอัตโนมัติทุกครั้งที่ mirror repo sync ข้อมูล — คัดลอกไฟล์นี้ไปวางใน Pine Editor แล้วกด Save + Add to chart
//@version=5
indicator("${meta.title}", overlay = true, max_lines_count = 500, max_labels_count = 500)

showCall  = input.bool(true,  "แสดงเส้น Call มากสุด")
showPut   = input.bool(true,  "แสดงเส้น Put มากสุด")
showLabel = input.bool(true,  "แสดงป้ายขนาดสัญญา")
callColor = input.color(color.new(#1c8a52, 0), "สี Call")
putColor  = input.color(color.new(#c0392b, 0), "สี Put")
lineWidth = input.int(2, "ความหนาเส้น", minval = 1, maxval = 5)

// ---- ข้อมูลฝังจาก vol2vol (เวลาเป็น unix ms) ----
var int[]   cStart  = array.from(${callSegs.map((s) => s.start).join(', ')})
var int[]   cEnd    = array.from(${callSegs.map((s) => s.end).join(', ')})
var float[] cStrike = array.from(${callSegs.map((s) => s.strike).join(', ')})
var int[]   cVol    = array.from(${callSegs.map((s) => s.vol).join(', ')})

var int[]   pStart  = array.from(${putSegs.map((s) => s.start).join(', ')})
var int[]   pEnd    = array.from(${putSegs.map((s) => s.end).join(', ')})
var float[] pStrike = array.from(${putSegs.map((s) => s.strike).join(', ')})
var int[]   pVol    = array.from(${putSegs.map((s) => s.vol).join(', ')})

drawSet(int[] st, int[] en, float[] sk, int[] vl, color col, string side, bool show) =>
    if show
        for i = 0 to array.size(st) - 1
            line.new(array.get(st, i), array.get(sk, i), array.get(en, i), array.get(sk, i),
                     xloc = xloc.bar_time, extend = extend.none, color = col, width = lineWidth)
            if showLabel
                label.new(array.get(en, i), array.get(sk, i),
                          side + " " + str.tostring(array.get(vl, i)),
                          xloc = xloc.bar_time, style = label.style_label_left,
                          color = color.new(col, 85), textcolor = col, size = size.tiny)

if barstate.islastconfirmedhistory
    drawSet(cStart, cEnd, cStrike, cVol, callColor, "C", showCall)
    drawSet(pStart, pEnd, pStrike, pVol, putColor,  "P", showPut)
`;

  fs.writeFileSync(OUT_DIR + '/' + key + '.pine', pine);
  console.log('Wrote ' + OUT_DIR + '/' + key + '.pine (' + callSegs.length + ' call segs, ' + putSegs.length + ' put segs)');
}
