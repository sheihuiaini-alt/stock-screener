// stock-screener 自动推送器
// 作用: 把本地生成的 daily_result.json 通过 GitHub API 推送到仓库 main 分支
//       (Contents API 更新, 无需 git, 规避 rebase/push 冲突)
// 用法: node push-screener.js
const https = require('https');
const fs = require('fs');
const path = require('path');

// 令牌从私有配置文件读取(gateway 目录下, 非工作区公开目录, 避免泄露)
const SECRET_FILE = 'C:\\Users\\Administrator\\.openclaw\\stockboard-gh.json';
let SECRET = {};
try { SECRET = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')); } catch (e) { console.error('读取密钥文件失败:', e.message); process.exit(1); }
const TOKEN = SECRET.gh_pat;
const REPO = SECRET.repo;
const BRANCH = SECRET.branch;
const DIR = __dirname;
const RESULT = path.join(DIR, 'daily_result.json');
const HISTORY_DIR = path.join(DIR, 'history');

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

// Contents API 更新单一文件
async function putFile(filePath, content, commitMsg) {
  const enc = Buffer.from(content, 'utf8').toString('base64');
  // 拿当前 sha
  const cur = await api('/repos/' + REPO + '/contents/' + filePath + '?ref=' + BRANCH);
  let sha = null;
  if (cur.status === 200) { try { sha = JSON.parse(cur.body).sha; } catch (e) {} }
  // 文件可能不存在(首次/历史归档), sha=null 则新建
  const body = {
    message: commitMsg,
    content: enc,
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await api('/repos/' + REPO + '/contents/' + filePath, 'PUT', body);
  return { status: r.status, body: r.body };
}

(async () => {
  const g = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const stamp = g.generated_date || new Date().toISOString().slice(0, 10);
  console.log('推送选股结果, generate_date=' + stamp + ', scanned=' + g.total_scanned);

  // 1. 推 daily_result.json
  const r1 = await putFile('daily_result.json', fs.readFileSync(RESULT, 'utf8'), '每日选股结果 ' + stamp);
  console.log('daily_result.json => HTTP', r1.status);

  // 2. 归档历史 history/YYYY-MM-DD.json
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const histPath = 'history/' + stamp + '.json';
  const r2 = await putFile(histPath, fs.readFileSync(RESULT, 'utf8'), '归档 ' + stamp);
  console.log(histPath, '=> HTTP', r2.status);
})();
