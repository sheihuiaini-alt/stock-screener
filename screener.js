#!/usr/bin/env node
/**
 * A股每日选股引擎 (Node.js) - v2.0 "底部企稳+放量+主力连续净流入"策略
 * ==============================================================
 * 针对用户要求改版 (2026-08-03, Ash):
 *   不再"追当日大涨", 改为"顺势低吸"型:
 *   - 大盘自动判断: 上证站上20日线才启动选股, 否则提示观望
 *   - 个股企稳: 收盘价站上 5日/10日/20日均线 (三线之上)
 *   - 放量: 近5日均量 > 前20日均量 × 1.5
 *   - 主力资金连续3天净流入
 * 满足以上硬条件才入选, 再按资金/量能强度排序取 TOP_N。
 *
 * 运行:  node screener.js
 * 输出:  daily_result.json
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const TOP_N = 10;              // 精选输出前多少只(用户要求10只)
const KLINE_DAYS = 120;        // 每只拉取历史K线天数
const REQ_DELAY = 80;          // 每只之间延迟(ms), 防限流
const MAX_STOCKS = 0;          // 0=全市场; 测试时可设小(如300)
const SIZE = 200;              // 东财列表每页条数
const STOCK_GLOBE = 'm:0+t:6,m:0+t:80'; // 深A+沪A

// ===== 策略硬条件参数 =====
const VOL_RATIO = 1.5;         // 放量倍数: 近5日均量 > 前20日均量 × 1.5
const FUND_CONT_DAYS = 3;      // 主力必须连续 N 天净流入
const MA_LINE_N = [5, 10, 20]; // 需站上的均线

// ============ HTTP 抓取 ============
function fetchRaw(url, timeout = 15000, retries = 3, referer = 'https://quote.eastmoney.com/') {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const doReq = (attempt) => {
      const req = mod.get(url, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': referer,
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

// ============ 新浪个股K线前缀 ============
function toMarketCode(code) {
  if (/^[69]/.test(code)) return 'sh' + code;
  if (/^[03]/.test(code)) return 'sz' + code;
  if (/^[48]/.test(code)) return 'bj' + code;
  return 'sh' + code;
}

// ============ 新浪个股日K线 (企稳/放量/技术指标判断) ============
// 与大盘K线、资金流历史同为新浪系数据源，统一稳定，不受东财/腾讯限流影响
async function getKline(code, n = 120) {
  const sym = toMarketCode(code); // sh000001 或 sz002138 (新浪用 sh/sz 前缀)
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${n}`;
  try {
    const text = await fetchRaw(url, 12000, 3, 'https://finance.sina.com.cn/');
    const arr = JSON.parse(text.trim());
    if (!Array.isArray(arr) || arr.length < 30) return null;
    return {
      closes: arr.map((r) => parseFloat(r.close)),
      highs: arr.map((r) => parseFloat(r.high)),
      lows: arr.map((r) => parseFloat(r.low)),
      vols: arr.map((r) => parseFloat(r.volume)),
      dates: arr.map((r) => String(r.day)),
    };
  } catch (e) {
    return null;
  }
}

// ============ 新浪大盘K线 (判断企稳) ============
async function getMarketState() {
  // 用新浪指数日K: 上证指数 sh000001
  const url = 'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=30';
  try {
    const text = await fetchRaw(url, 12000, 3, 'http://finance.sina.com.cn/');
    const arr = JSON.parse(text.trim());
    const closes = arr.map((x) => parseFloat(x.close));
    if (closes.length < 25) return { ok: false, reason: '大盘数据不足' };
    const last = closes[closes.length - 1];
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    return {
      last,
      ma20,
      ok: last > ma20,
      reason: `上证收盘${last.toFixed(2)} vs 20日线${ma20.toFixed(2)} (${last > ma20 ? '已站上-企稳' : '未站上-观望'})`,
    };
  } catch (e) {
    return { ok: false, reason: '大盘接口失败: ' + e.message };
  }
}

// ============ 资金流历史 (主力连续净流入判断) ============
// 用新浪个股资金流历史接口, 返回最近 N 天逐日主力净流入(r0_net, 元)
async function getMainFlow(code) {
  const mc = (code.startsWith('6') ? 'sh' : 'sz') + code;
  const url = `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=10&sort=opendate&asc=0&daima=${mc}`;
  try {
    const text = await fetchRaw(url, 12000, 3, 'https://finance.sina.com.cn/');
    const arr = JSON.parse(text.trim());
    if (!Array.isArray(arr) || !arr.length) return null;
    // 升序排列(旧日期在前), 便于 slice(-N) 取最近 N 天
    return arr.map((d) => ({
      date: String(d.opendate || ''),
      main: parseFloat(d.r0_net || 0),
    })).sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    return null;
  }
}

// 判断最近 N 天主力是否连续净流入 (含今天)
function isMainFlowConsec(flow, n) {
  if (!flow || flow.length < n) return false;
  const lastN = flow.slice(-n);
  return lastN.every((d) => d.main > 0);
}

// ============ 技术指标 ============
function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

// EMA 指数均线
function ema(arr, period) {
  if (!arr.length) return null;
  const k = 2 / (period + 1);
  let prev = arr[0];
  for (let i = 1; i < arr.length; i++) prev = arr[i] * k + prev * (1 - k);
  return prev;
}

// MACD (dif/dea/hist)
function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = emaFast - emaSlow;
  // DEA 用整体 EMA 近似: 对 dif 数列做 EMA(signal)
  const difArr = [];
  for (let i = 0; i < closes.length; i++) {
    const f = ema(closes.slice(0, i + 1), fast);
    const s = ema(closes.slice(0, i + 1), slow);
    difArr.push(f - s);
  }
  const dea = ema(difArr, signal);
  return { dif, dea, hist: (dif - dea) * 2 };
}

// RSI (14日)
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / period / (loss / period);
  return 100 - 100 / (1 + rs);
}

// KDJ (9日)
function kdj(highs, lows, closes, period = 9) {
  if (highs.length < period) return null;
  const n = closes.length;
  const ll = Math.min(...lows.slice(-period));
  const hh = Math.max(...highs.slice(-period));
  const rsv = hh === ll ? 50 : (closes[n - 1] - ll) / (hh - ll) * 100;
  // 简化: K/D 用近三次 rsv 近似
  let k = 50, d = 50;
  for (let i = 1; i <= 3; i++) {
    const rsv_i = hh === ll ? 50 : (closes[n - i] - ll) / (hh - ll) * 100;
    k = 2 / 3 * k + 1 / 3 * rsv_i;
    d = 2 / 3 * d + 1 / 3 * k;
  }
  return { k, d, j: 3 * k - 2 * d };
}

// 均线斜率 (近5日 20日线升/降, 返回度数/正常化)
function maSlope(closes, period = 20) {
  if (closes.length < period + 5) return null;
  const maNow = sma(closes.slice(-period), period);
  const maPrev = sma(closes.slice(-period - 5, -5), period);
  if (maNow == null || maPrev == null || maPrev === 0) return null;
  return (maNow - maPrev) / maPrev * 100; // 5日变化率%
}

// ============ 选股判定 ============
// 返回 { pass:true, volRatio, maOk, fundDays, reasons, score, totalMain, tech } 或 { pass:false, failReason }
function evaluate(o) {
  const { closes, highs, lows, vols, flow, pct } = o;
  const reasons = [];

  // 硬条件1: 站上 5/10/20 日均线 (企稳)
  let maOk = false;
  let last = 0, ma5 = null, ma10 = null, ma20 = null;
  if (closes.length >= 25) {
    last = closes[closes.length - 1];
    ma5 = sma(closes, 5); ma10 = sma(closes, 10); ma20 = sma(closes, 20);
    if (ma5 != null && ma10 != null && ma20 != null) {
      // 收盘价 站上 三条均线 且 均线多头排列 (5>10>20)
      if (last > ma5 && last > ma10 && last > ma20 && ma5 >= ma10 && ma10 >= ma20) {
        maOk = true;
        reasons.push(`站上三线(MA5=${ma5.toFixed(2)}/MA10=${ma10.toFixed(2)}/MA20=${ma20.toFixed(2)})`);
      }
    }
  }
  if (!maOk) return { pass: false, failReason: '未站上三线' };

  // 硬条件2: 放量 近5日均量 > 前20日均量 × 1.5
  let volRatio = 0;
  if (vols.length >= 25) {
    const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avg20 = vols.slice(-25, -5).reduce((a, b) => a + b, 0) / 20; // 前20日
    volRatio = avg20 > 0 ? avg5 / avg20 : 0;
    if (volRatio >= VOL_RATIO) {
      reasons.push(`放量${volRatio.toFixed(2)}x`);
    } else {
      return { pass: false, failReason: `放量不足(${volRatio.toFixed(2)}x<${VOL_RATIO})` };
    }
  } else {
    return { pass: false, failReason: '量能数据不足' };
  }

  // 硬条件3: 主力连续 FUND_CONT_DAYS 天净流入
  const fundDays = (flow || []).filter((d) => d.main > 0).length;
  if (!isMainFlowConsec(flow, FUND_CONT_DAYS)) {
    return { pass: false, failReason: `主力未连续${FUND_CONT_DAYS}天净流入` };
  }
  reasons.push(`主力连续${FUND_CONT_DAYS}天净流入`);

  // 附加: 涨幅过滤 (已站上三线+回调企稳, 不应暴涨过猛)
  if (pct != null) {
    if (pct > 9.5) return { pass: false, failReason: '当日已涨停' };
    if (pct > 7) reasons.push(`当日涨${pct.toFixed(1)}%`); // 允许但标记
  }

  // ===== 技术指标综合评分 (用于排序精选) =====
  const tech = {};
  let score = 0;
  const flow3 = (flow || []).slice(-FUND_CONT_DAYS);
  const totalMain = flow3.reduce((a, d) => a + d.main, 0);

  // 1. 资金强度 (权重2.5·上限10)
  let sFund = 0;
  sFund += Math.min(6, totalMain / 2e7);              // 3日主力累计
  sFund += (flow || []).slice(-FUND_CONT_DAYS).every((d) => d.main > 0) ? 3 : 0;
  sFund = Math.min(10, sFund + 1);                     // 连续净流入给基础分
  score += sFund * 2.5;
  tech.fund = sFund;

  // 2. 放量强度 (权重1.5·上限10)
  const sVol = Math.min(10, Math.max(0, (volRatio - VOL_RATIO) * (10 / 3)));
  score += sVol * 1.5;
  tech.vol = sVol;

  // 3. 均线趋势基本面 (权重2·上限10)
  let sMa = 5; // 已站上三线, 给基础分
  if (ma20 > 0) sMa += Math.min(3, Math.max(0, (last - ma20) / ma20 * 100 / 2)); // 距20日线安全边际
  const slope = maSlope(closes, 20);
  if (slope != null) sMa += Math.max(-2, Math.min(2, slope * 4)); // 20日线斜率
  sMa = Math.max(0, Math.min(10, sMa));
  score += sMa * 2;
  tech.ma = sMa;

  // 4. MACD 强势 (权重1·上限10)
  let sMacd = 5;
  const m = macd(closes);
  if (m && m.dif != null) {
    if (m.dif > 0 && m.hist > 0) sMacd = 10;         // 零轴上方+红柱扩大
    else if (m.dif > 0) sMacd = 8;
    else if (m.hist > 0) sMacd = 6;                   // 绿柱缩小/翻红
    else sMacd = 3;
  }
  score += sMacd * 1;
  tech.macd = sMacd;

  // 5. RSI 健康区 (权重1·上限10): 50-68 为强势未完
  let sRsi = 5;
  const r = rsi(closes);
  if (r != null) {
    if (r >= 50 && r <= 68) sRsi = 10;
    else if (r >= 45 && r < 50) sRsi = 7;
    else if (r > 68 && r <= 75) sRsi = 5;
    else if (r > 75) sRsi = 2;   // 过热
    else sRsi = 3;               // <45 弱势
  }
  score += sRsi * 1;
  tech.rsi = sRsi;

  // 6. KDJ 超买/金叉修正 (权重0.8·上限10)
  let sKdj = 5;
  if (highs && lows && highs.length >= 9 && closes.length >= 9) {
    const kd = kdj(highs, lows, closes);
    if (kd) {
      if (kd.k > 50 && kd.j < 100) sKdj = 8;      // 强势未超买
      else if (kd.k > 80 || kd.j > 110) sKdj = 3; // 超买风险
      else if (kd.k > 30) sKdj = 6;
      else sKdj = 4;
    }
  }
  score += sKdj * 0.8;
  tech.kdj = sKdj;

  // 7. 当日涨幅温和 (权重1·上限10): 底部启动应+2%~+5%, 大涨反而扣分(避免追高)
  let sPct = 5;
  if (pct != null) {
    if (pct >= 2 && pct <= 5) sPct = 10;   // 温和放量上攻
    else if (pct > 0 && pct < 2) sPct = 8; // 刚启动
    else if (pct > 5 && pct <= 7) sPct = 6;
    else if (pct <= 0) sPct = 4;           // 微跌
    else sPct = 2;
  }
  score += sPct * 1;
  tech.pct = sPct;

  // 满分 = 25+15+20+10+10+8+10
  score = Math.round(score * 10) / 10;

  return {
    pass: true, volRatio, fundDays, reasons, score, totalMain, maOk, tech,
    ma5, ma10, ma20, last,
  };
}

// ============ 主流程 ============
async function main() {
  console.log('='.repeat(56));
  console.log('A股选股引擎 v2.0 (底部企稳+放量+主力连续净流入)');
  console.log('时间:', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
  console.log('='.repeat(56));

  // ===== 0. 大盘企稳自动判断 =====
  console.log('\n[0/4] 大盘企稳自动判断...');
  const market = await getMarketState();
  console.log('  ' + market.reason);
  if (!market.ok) {
    // 大盘未企稳: 仍可选股, 但结果标记"观望"提示 (不硬性停止, 让用户看到数据)
    console.log('  ⚠️ 大盘未站上20日线, 处于观望区! 选股结果仅供参考, 建议谨慎。');
  }

  console.log('\n[1/4] 拉取全市场A股列表...');
  let stocks = await getAllStocks();
  if (MAX_STOCKS > 0) stocks = stocks.slice(0, MAX_STOCKS);
  console.log(`  获取 ${stocks.length} 只候选股票${MAX_STOCKS ? ` (测试模式限制${MAX_STOCKS})` : ''}`);

  // ===== 粗筛(只靠列表字段, 秒级): 大幅减少待拉K线的数量 =====
  const before = stocks.length;
  stocks = stocks.filter((s) => {
    const inflow = s.net_inflow == null ? 0 : s.net_inflow;
    const pct = s.pct == null ? 0 : s.pct;
    // 排除: 当日涨停/大涨追高陷阱、当日暴跌、主力当日净流出
    if (pct > 9.5) return false;   // 涨停不追
    if (pct < -5) return false;    // 当日大跌
    if (inflow <= 0) return false; // 主力当日必须净流入
    return true;
  });
  console.log(`  粗筛(主力当日净流入+未涨停+未暴跌): ${before} → ${stocks.length} 只`);

  console.log('\n[2/4] 逐股判定硬条件(站上三线+放量+连续净流入)...');
  const passed = [];
  let okCount = 0, fail = { 未站上三线: 0, 放量不足: 0, 主力未连续净流入: 0, 已涨停: 0, 数据不足: 0 };
  // 并发处理: 控制最大并发防限流(新浪资金流+腾讯K线都要克制)
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < stocks.length) {
      const i = idx++;
      const s = stocks[i];
      const k = await getKline(s.code);
      if (!k) { fail['数据不足']++; continue; }
      const flow = await getMainFlow(s.code);
      const r = evaluate({ closes: k.closes, highs: k.highs, lows: k.lows, vols: k.vols, flow, pct: s.pct });
      if (r.pass) {
        passed.push({
          code: s.code, name: s.name, price: s.price, pct: s.pct,
          turnover: s.turnover, pe: s.pe, pb: s.pb,
          volRatio: r.volRatio, fundDays: r.fundDays, totalMain: r.totalMain,
          score: r.score, tech: r.tech, reasons: r.reasons.join('; '),
          ma5: r.ma5, ma10: r.ma10, ma20: r.ma20,
        });
        okCount++;
      } else {
        const f = r.failReason || '数据不足';
        if (f.startsWith('放量')) fail['放量不足']++;
        else if (f.startsWith('未站上三线')) fail['未站上三线']++;
        else if (f.startsWith('主力未连续')) fail['主力未连续净流入']++;
        else if (f.startsWith('当日已涨停')) fail['已涨停']++;
        else fail['数据不足']++;
      }
      await sleep(60);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stocks.length) }, worker));
  console.log(`  共处理 ${stocks.length} 只, 通过 ${okCount} 只`);
  console.log('  淘汰原因统计:', JSON.stringify(fail));

  // ===== 3. 排序取 TOP =====
  console.log(`\n[3/4] 按综合技术评分排序, 取前${TOP_N}...`);
  passed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.totalMain || 0) - (a.totalMain || 0);
  });
  const top = passed.slice(0, TOP_N).map((s, i) => ({ rank: i + 1, ...s }));

  const result = {
    generate_time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    generated_date: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    note: '底部企稳(站上5/10/20日线)+放量1.5x+主力连续3天净流入; 仅供参考, 不构成投资建议',
    strategy: 'v2.0 企稳放量资金策略',
    market: market,
    total_scanned: stocks.length,
    passed_count: okCount,
    top,
  };

  const outFile = path.join(__dirname, 'daily_result.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n[4/4] 选股完成! 结果已写入: ${outFile}`);
  console.log('='.repeat(56));
  console.log(`扫描 ${stocks.length} 只, 硬条件通过 ${okCount} 只, 精选前 ${TOP_N} 只(综合技术评分):`);
  for (const s of top) {
    const t = s.tech || {};
    console.log(`  ${String(s.rank).padStart(2)}. ${s.name}(${s.code}) 价${s.price} 涨${s.pct}% 评分${s.score} | 资金${(s.totalMain / 1e4).toFixed(0)}万 放量${s.volRatio.toFixed(1)}x | MACD${t.macd} RSI${t.rsi} KDJ${t.kdj}`);
  }
  console.log('='.repeat(56));
}

main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
