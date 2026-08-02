#!/usr/bin/env node
/**
 * A股每日选股引擎 (Node.js)
 * ==========================
 * 每天收盘后运行, 从全市场 A 股按多维指标综合评分, 选出次日可关注股票。
 *
 * 运行:  node screener.js
 * 输出:  daily_result.json
 *
 * 开发: 2026-08-02 (Ash)
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const TOP_N = 20;              // 输出前多少只
const KLINE_DAYS = 120;        // 每只拉取历史K线天数
const REQ_DELAY = 120;         // 每只之间延迟(ms), 防限流
const MAX_STOCKS = 0;          // 0=全市场; 测试时可设小(如200)
const SIZE = 200;              // 东财列表每页条数
const STOCK_GLOBE = 'm:0+t:6,m:0+t:80'; // 深A+沪A

// ============ HTTP 抓取 ============
function fetchRaw(url, timeout = 15000, retries = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const doReq = (attempt) => {
      const req = mod.get(url, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': '*/*',
        },
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', (e) => {
        if (attempt < retries - 1) setTimeout(() => doReq(attempt + 1), 800 * (attempt + 1));
        else reject(e);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
    };
    doReq(0);
  });
}

async function fetchJson(url, timeout) {
  const text = await fetchRaw(url, timeout);
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ 第一步: 拉全市场A股列表 ============
async function getAllStocks() {
  const stocks = [];
  let page = 1;
  let total = Infinity;
  let pagesRun = 0;
  while (page * SIZE < total) {
    const url = `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${SIZE}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=${STOCK_GLOBE}&fields=f12,f14,f2,f3,f6,f8,f9,f20,f23,f62`;
    try {
      const j = await fetchJson(url);
      const data = j.data || {};
      const diff = data.diff || [];
      total = data.total || 0;
      if (!diff.length) break;
      for (const x of diff) {
        const code = String(x.f12 || '');
        const name = String(x.f14 || '');
        if (!code || !name) continue;
        // 过滤 ST/退/新股标记
        if (/ST|退|N$|^C/.test(name)) continue;
        stocks.push({
          code, name,
          price: x.f2, pct: x.f3, turnover: x.f8, pe: x.f9,
          pb: x.f23, mktcap: x.f20, net_inflow: x.f62,
        });
      }
    } catch (e) {
      console.log(`  [warn] 第${page}页失败: ${e.message}`);
      break;
    }
    page++;
    pagesRun++;
    if (MAX_STOCKS > 0 && stocks.length >= MAX_STOCKS) break;
    await sleep(100);
  }
  return stocks.filter((s) => s.price && s.price > 0);
}

// ============ 第二步: 腾讯K线 ============
function toMarketCode(code) {
  if (/^[69]/.test(code)) return 'sh' + code;
  if (/^[03]/.test(code)) return 'sz' + code;
  if (/^[48]/.test(code)) return 'bj' + code;
  return 'sh' + code;
}

async function getKline(code, n = KLINE_DAYS) {
  const mc = toMarketCode(code);
  const url = `http://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mc},day,,,${n},qfq`;
  try {
    const j = await fetchJson(url, 10000);
    const data = j.data || {};
    const node = data[mc] || {};
    const rows = node.qfqday || node.day || [];
    if (rows.length < 30) return null;
    return {
      closes: rows.map((r) => parseFloat(r[2])),
      highs: rows.map((r) => parseFloat(r[3])),
      lows: rows.map((r) => parseFloat(r[4])),
      vols: rows.map((r) => parseFloat(r[5])),
      dates: rows.map((r) => r[0]),
    };
  } catch (e) {
    return null;
  }
}

// ============ 技术指标 ============
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

function ema(arr, period) {
  if (!arr.length) return null;
  const k = 2 / (period + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function macdBull(closes) {
  if (closes.length < 35) return { dif: null, bull: false, above0: false };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12 == null || ema26 == null) return { dif: null, bull: false, above0: false };
  const dif = ema12 - ema26;
  return { dif, bull: dif > 0, above0: dif > 0 };
}

function calcRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) gains += ch; else losses -= ch;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// ============ 第三步: 评分 ============
function scoreStock(s, k) {
  let score = 0;
  const reasons = [];
  const closes = k ? k.closes : [];
  const vols = k ? k.vols : [];
  let price = s.price;

  // 1. 主力资金 (25)
  let net = s.net_inflow;
  if (net != null && Number.isFinite(net)) {
    if (net > 0) {
      const adj = Math.min(25, net / 1e7);
      score += adj;
      reasons.push(`主力净流入${(net / 1e4).toFixed(0)}万`);
    } else {
      reasons.push('主力净流出');
    }
  } else {
    score += 8;
    reasons.push('资金数据缺失');
  }

  // 2. 量价 (15)
  if (vols.length >= 5 && closes.length >= 5) {
    const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avg20 = vols.length >= 20 ? vols.slice(-20).reduce((a, b) => a + b, 0) / 20 : avg5;
    const ratio = avg20 > 0 ? avg5 / avg20 : 0;
    const priceUp = closes.length >= 2 ? closes[closes.length - 1] >= closes[closes.length - 2] : true;
    if (ratio >= 1.2 && ratio <= 2.5 && priceUp) { score += 15; reasons.push(`温和放量${ratio.toFixed(1)}x`); }
    else if (ratio > 3) { score += 5; reasons.push('放量过大'); }
    else if (priceUp) { score += 10; }
    else { score += 3; }
  } else { score += 7; }

  // 3. 均线 (20)
  if (closes.length >= 60) {
    const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
    if (ma5 != null && ma10 != null && ma20 != null && ma60 != null) {
      const p = closes[closes.length - 1];
      if (ma5 > ma10 && ma10 > ma20 && p > ma20) { score += 20; reasons.push('均线多头'); }
      else if (p > ma20) { score += 12; reasons.push('站上20日线'); }
      else if (p > ma60) { score += 8; reasons.push('站上60日线'); }
      else { score += 3; }
    } else { score += 5; }
  } else { score += 5; }

  // 4. 技术 MACD/RSI (15)
  const { bull, above0 } = macdBull(closes);
  const rsi = calcRsi(closes);
  let tech = 0;
  if (bull) tech += 7;
  if (above0) tech += 3;
  if (rsi != null) {
    if (rsi >= 45 && rsi <= 70) { tech += 5; reasons.push(`RSI${rsi.toFixed(0)}`); }
    else if (rsi < 45) { tech += 2; }
    else { tech += 1; reasons.push(`RSI超买${rsi.toFixed(0)}`); }
  }
  score += Math.min(15, tech);

  // 5. 估值 (15)
  let val = 0;
  if (s.pe != null && s.pe > 0 && s.pe < 50) val += 8;
  else if (s.pe != null && s.pe === 0) val += 3;
  if (s.pb != null && s.pb > 0 && s.pb < 8) val += 7;
  score += Math.min(15, val);

  // 6. 涨幅过滤 (10)
  if (closes.length >= 5 && closes[closes.length - 5]) {
    const chg5 = (closes[closes.length - 1] - closes[closes.length - 5]) / closes[closes.length - 5] * 100;
    if (chg5 >= -3 && chg5 <= 8) { score += 10; reasons.push(`5日${chg5.toFixed(1)}%`); }
    else if (chg5 > 15) { score += 2; reasons.push('5日已暴涨'); }
    else { score += 5; }
  } else { score += 5; }

  // 当日涨幅过滤: 追高陷阱 (重要)
  const pct = s.pct || 0;
  // 涨停/大涨股次日追高风险极高, 大幅降权
  if (pct > 9.5) { score -= 20; reasons.push(`当日涨停`); }
  else if (pct > 6) { score -= 10; reasons.push(`当日大涨${pct.toFixed(1)}%`); }
  else if (pct > 3) { score -= 3; reasons.push(`当日涨${pct.toFixed(1)}%`); }
  else if (pct < -5) { score -= 8; reasons.push(`当日大跌${pct.toFixed(1)}%`); }

  if (closes.length) price = closes[closes.length - 1];
  return { score: Math.round(score * 10) / 10, reasons, price };
}

// ============ 主流程 ============
async function main() {
  console.log('='.repeat(50));
  console.log('A股每日选股引擎启动');
  console.log('时间:', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  console.log('='.repeat(50));

  console.log('\n[1/4] 拉取全市场A股列表...');
  let stocks = await getAllStocks();
  if (MAX_STOCKS > 0) stocks = stocks.slice(0, MAX_STOCKS);
  console.log(`  获取 ${stocks.length} 只候选股票${MAX_STOCKS ? ` (测试模式限制${MAX_STOCKS})` : ''}`);

  console.log('\n[2/4] 逐股计算技术指标...');
  const scored = [];
  for (let i = 0; i < stocks.length; i++) {
    const s = stocks[i];
    const k = await getKline(s.code);
    const r = scoreStock(s, k);
    scored.push({
      code: s.code, name: s.name,
      price: r.price, pct: s.pct, turnover: s.turnover, pe: s.pe, pb: s.pb,
      score: r.score, reasons: r.reasons.slice(0, 6).join('; '),
    });
    if ((i + 1) % 100 === 0) console.log(`  已处理 ${i + 1}/${stocks.length}`);
    await sleep(REQ_DELAY);
  }

  console.log(`\n[3/4] 按综合得分排序, 取前${TOP_N}...`);
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TOP_N).map((s, i) => ({ rank: i + 1, ...s }));

  const result = {
    generate_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    generated_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    note: '综合评分自动生成, 仅供参考, 不构成投资建议',
    total_scanned: stocks.length,
    top,
  };

  const outFile = path.join(__dirname, 'daily_result.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n[4/4] 选股完成! 结果已写入: ${outFile}`);
  console.log('='.repeat(50));
  console.log(`扫描 ${stocks.length} 只, 选出前 ${TOP_N} 只:`);
  for (const s of top) {
    console.log(`  ${String(s.rank).padStart(2)}. ${s.name}(${s.code}) 价${s.price} 涨${s.pct}% 得分${s.score} | ${s.reasons}`);
  }
  console.log('='.repeat(50));
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
