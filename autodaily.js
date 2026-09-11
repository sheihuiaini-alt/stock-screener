// stock-screener 每日自动选股 + 推送 GitHub
// 用法: node autodaily.js
// 流程: 1) 跑 screener.js 生成 daily_result.json  2) 推送 daily_result.json + history 归档到 GitHub main
// 备注: 由网关 cron 每天收盘后(过15:35)触发, 全程无需人工
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const RESULT = path.join(DIR, 'daily_result.json');
const RUN_LOG = path.join(DIR, '.autodaily.log');

function log(m) {
  const line = `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })} ${m}`;
  console.log(line);
  try { fs.appendFileSync(RUN_LOG, line + '\n'); } catch (e) {}
}

// 运行 screener.js(同步等待完成)
function runScreener() {
  return new Promise((resolve, reject) => {
    log('开始运行选股脚本...');
    const child = spawn('node', ['screener.js'], { cwd: DIR, stdio: 'inherit', windowsHide: true });
    child.on('close', (code) => {
      if (code === 0) { log('选股脚本完成(exit 0)'); resolve(); }
      else reject(new Error('选股脚本退出码 ' + code));
    });
    child.on('error', (e) => reject(new Error('启动失败: ' + e.message)));
  });
}

(async () => {
  try {
    await runScreener();
    // 校验生成成功且是今天
    const g = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
    log('生成的 generated_date=' + g.generated_date + ', 今天=' + today);
    if (g.generated_date !== today) {
      log('警告: generated_date 不是今天, 仍尝试推送');
    }
    // 推送
    log('开始推送 GitHub...');
    const out = execSync('node push-screener.js', { cwd: DIR, encoding: 'utf8' });
    log('推送输出:\n' + out.trim());
    log('=== 全流程完成 ===');
  } catch (e) {
    log('!!! 失败: ' + e.message);
    process.exit(1);
  }
})();
