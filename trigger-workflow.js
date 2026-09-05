// 触发 stock-screener 仓库的 daily.yml workflow_dispatch 并等待完成
// 作用: 把 main 分支的最新 daily_result.json 发布到 gh-pages, 让网站选股页更新
// 用法: node trigger-workflow.js
const https = require('https');
const fs = require('fs');

const SECRET_FILE = 'C:\\Users\\Administrator\\.openclaw\\stockboard-gh.json';
let SECRET = {};
try { SECRET = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { console.error('读取密钥失败:', e.message); process.exit(1); }
const TOKEN = SECRET.gh_pat;
const REPO = SECRET.repo;
const WORKFLOW_FILE = 'daily.yml';

function api(apiPath, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'node', 'Accept': 'application/vnd.github+json', 'Authorization': 'token ' + TOKEN };
    if (body) headers['Content-Type'] = 'application/json';
    const opts = { hostname: 'api.github.com', path: apiPath, method, headers, timeout: 30000 };
    const req = https.request(opts, (r) => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', function () { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function triggerAndWait(waitMaxSec = 600) {
  // 1. 触发 workflow_dispatch (main 分支)
  console.log('触发 workflow_dispatch ...');
  const t = await api('/repos/' + REPO + '/actions/workflows/' + WORKFLOW_FILE + '/dispatches', 'POST', { ref: 'main' });
  // dispatch 接口 204=成功
  console.log('dispatch HTTP', t.status, t.status === 204 ? '(已触发)' : String(t.body).slice(0, 200));

  // 2. 轮询获取最新一次的 run, 直到完成
  console.log('等待 workflow 运行完成 ...');
  const deadline = Date.now() + waitMaxSec * 1000;
  while (Date.now() < deadline) {
    await sleep(15000);
    const r = await api('/repos/' + REPO + '/actions/runs?event=workflow_dispatch&per_page=1');
    if (r.status === 200) {
      try {
        const runs = JSON.parse(r.body).workflow_runs || [];
        if (runs.length) {
          const run = runs[0];
          const st = run.status, concl = run.conclusion || '';
          console.log(`  run ${String(run.id)} status=${st} conclusion=${concl || '(运行中)'}`);
          if (st === 'completed') {
            if (concl === 'success') { console.log('✅ workflow 完成成功'); return true; }
            else { console.log('❌ workflow 完成但结果=' + concl); return false; }
          }
        }
      } catch (e) {}
    }
  }
  console.log('超时未完成');
  return false;
}

triggerAndWait().then((ok) => {
  console.log(ok ? '发布完成 ✓' : '发布未成功');
  process.exit(ok ? 0 : 1);
});
