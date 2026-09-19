# A股每日选股引擎 📈

每天收盘后（北京时间 15:30）自动扫描全市场 A 股，按「资金面 + 技术面 + 估值」多维综合评分，选出得分最高的前 20 只股票，供次日参考。

> ⚠️ **免责声明**：本工具为程序化技术选股参考，不构成投资建议。股市有风险，盈亏自负。

---

## 工作原理

| 步骤 | 说明 |
|---|---|
| 1. 数据源 | 东方财富 push2delat（股票列表/资金/估值）+ 腾讯（历史K线） |
| 2. 过滤 | 剔除 ST/退市/新股/无价格股票 |
| 3. 评分 | 资金25 + 量价15 + 均线20 + 技术15 + 估值15 + 涨幅10 |
| 4. 输出 | 综合得分前 20 只，存为 `daily_result.json` |

## 评分维度

- **主力资金净流入** (25分)：大资金真实买入
- **量价配合** (15分)：温和放量上涨最佳
- **均线多头排列** (20分)：趋势健康
- **MACD/RSI 技术信号** (15分)：趋势转强、避免超买
- **估值合理** (15分)：PE/PB 不过热
- **涨幅过滤** (10分)：**刻意降权涨停/大涨股**，避免追高次日被套

## 部署到 GitHub（自动每天跑）

1. 在 GitHub 新建一个**公开仓库**（如 `stock-screener`）
2. 把本目录所有文件上传到仓库根目录（**保留 `.github/` 文件夹**）
3. 开启 **GitHub Pages**：Settings → Pages → Source 选 `gh-pages` branch
4. 完成！之后每天 15:30 自动选股，`gh-pages` 分支会更新结果

> 选股结果由 GitHub Actions 自动提交到仓库并发布到 Pages。

### 查看选股结果

- **手机**：打开 `https://<你的用户名>.github.io/<仓库名>/` 即可看到当天选股（自动更新）
- **原始JSON**：`https://<你的用户名>.github.io/<仓库名>/daily_result.json`
- 你的用户名是 `sheihuiaini-alt`，若仓库名叫 `stock-screener`：
  `https://sheihuiaini-alt.github.io/stock-screener/`

## 本地手动测试

```bash
node screener.js
```

结果写入当前目录 `daily_result.json`。（当前仅用 Node 标准库，无需安装依赖）

## 手动触发

在 GitHub 仓库 → Actions → 「每日选股」→ `Run workflow` 按钮，可手动触发一次选股（无需等定时）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `screener.js` | 选股引擎（Node.js，扫描全市场+评分+输出） |
| `.github/workflows/daily.yml` | GitHub Actions 定时任务（每天15:30北京时间） |
| `index.html` | 手机端展示页（自动读取 daily_result.json） |
| `README.md` | 本说明 |
