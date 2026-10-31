// stock-screener 每日更新总控: 选股 → 推送 → 触发发布
// 流程: 1) screener.js 生成 daily_result.json
//        2) push-screener.js 推 daily_result.json + history 归档到 GitHub main
//        3) trigger-workflow.js 触发 daily.yml 发布到 gh-pages(网站更新)
// 用法: node daily-update.js
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const RUN_LOG = path.join(DIR, '.daily-update.log');

function now() { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); }
function log(m) {
  const line = `${now()} ${m}`;
  console.log(line);
  try { fs.appendFileSync(RUN_LOG, line + '\n'); } catch (e) {}
}

function runScreener() {
  return new Promise((resolve, reject) => {
    log('① 运行选股脚本 screener.js ...');
    const child = spawn('node', ['screener.js'], { cwd: DIR, stdio: 'inherit', windowsHide: true });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('screener 退出码 ' + code)));
    child.on('error', (e) => reject(new Error('启动失败: ' + e.message)));
  });
}

(async () => {
  try {
    await runScreener();
    const g = JSON.parse(fs.readFileSync(path.join(DIR, 'daily_result.json'), 'utf8'));
    log(`  选股完成: 日期=${g.generated_date} 扫描=${g.total_scanned} 精选=${(g.top || []).length} 大盘看好=${g.market && g.market.ok}`);

    log('② 推送 daily_result.json + 历史归档到 GitHub ...');
    const out = execSync('node push-screener.js', { cwd: DIR, encoding: 'utf8' });
    log('  ' + out.trim().split('\n').join(' | '));

    log('③ 触发 GitHub Actions 发布到网站(gh-pages) ...');
    const trig = execSync('node trigger-workflow.js', { cwd: DIR, encoding: 'utf8', timeout: 660000 });
    log('  ' + trig.trim().split('\n').slice(0, 3).join(' | '));

    log('=== 每日更新全流程完成 ===');
  } catch (e) {
    log('!!! 失败: ' + e.message);
    process.exit(1);
  }
})();
