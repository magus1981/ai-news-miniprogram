# AI前沿资讯小程序 - 部署操作手册

前置状态：代码已就绪（本地 7 源采集管线、API 服务、小程序均验证通过），本文档面向"已注册好 Turso 和 Vercel 账号"的场景，按 ①→④ 顺序照抄执行即可。

凭证准备清单（部署全程只需要这些）：

- Turso 数据库 URL（形如 `libsql://your-db-your-org.turso.io`）
- Turso 认证 Token（一长串 JWT）
- DashScope API Key（已在 `pipeline/.env`，部署 GitHub Actions 时要用同一个值）

---

## ① Turso：建库 + 灌入本地数据

### 1. 注册建库（网页操作）

1. 打开 https://turso.tech 注册（可用 GitHub 账号登录）
2. 创建数据库：Dashboard → Create Database → 名字随意（如 `ai-news`），区域选 `Singapore` 或 `Tokyo`（离国内近）
3. 在数据库页面拿到两个值：
   - **URL**：`libsql://ai-news-xxxx.turso.io`
   - **Token**：Database → Generate Token（选 Full Access）

### 2. 灌库（本地执行）

在 `pipeline/.env` 里追加两行（该文件已被 .gitignore 排除，不会泄露）：

```
TURSO_URL=libsql://ai-news-xxxx.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOi...（你的Token）
```

然后执行（在 `pipeline` 目录下）：

```powershell
cd D:\20260402qoder\ai-news-miniprogram\pipeline
node seed-turso.mjs
```

**预期输出**：

```
本地读取: D:\...\data\articles.db
本地行数: 215
Turso建表完成（IF NOT EXISTS）
灌入进度: 50/215
灌入进度: 100/215
...
=== 灌库完成 ===
本次新增: 215 条, 跳过(已存在): 0 条
Turso总行数: 215（本地 215 行）
```

脚本幂等，重复运行会显示"跳过 215 条"，不会重复插入。

> 临时用环境变量（不写 .env）也可以，PowerShell：
> `$env:TURSO_URL="libsql://..."; $env:TURSO_AUTH_TOKEN="eyJ..."; node seed-turso.mjs`

---

## ② Vercel：部署 API 服务

### 1. 安装并登录 CLI

```powershell
npm install -g vercel
vercel login
```

### 2. 部署（server 目录是项目根）

```powershell
cd D:\20260402qoder\ai-news-miniprogram\server
vercel deploy --prod
```

首次会交互式提问：Set up and deploy? → **Y**；Which scope? → 回车；Link to existing project? → **N**；Project name? → 回车或自定义（如 `ai-news-api`）；Code directory? → 回车（`./`）。

**预期输出**结尾会给出生产地址：

```
✅ Production: https://ai-news-api-xxxx.vercel.app
```

记下这个地址（下称 `<VERCEL_URL>`）。

### 3. 配置环境变量（两个）

```powershell
vercel env add TURSO_URL production
# 提示输入值时粘贴 libsql://...

vercel env add TURSO_AUTH_TOKEN production
# 提示输入值时粘贴 eyJ...

vercel deploy --prod   # 重新部署使变量生效
```

（也可以在 Vercel 网页 Dashboard → Project → Settings → Environment Variables 里加，加完同样要 redeploy。）

### 4. 验证 3 个端点

```powershell
curl "<VERCEL_URL>/api/featured"
curl "<VERCEL_URL>/api/articles?category=technology&page=1"
curl "<VERCEL_URL>/api/article/202"
```

**预期**：都返回 JSON。`/api/featured` 返回当日精选数组；`/api/articles` 返回带 `total/has_more/articles` 的分页对象；`/api/article/202` 返回单篇详情（含 `summary` 字段）。如果报 500，去 Vercel Dashboard → Functions 日志看是不是环境变量没生效。

---

## ③ GitHub：推代码 + 定时采集

### 1. 推送代码（本地 git 仓库已就绪，含首次 commit）

> ⚠️ 本机**尚未安装 git 命令行**。先二选一：
> - 方式A（命令行）：装 [Git for Windows](https://git-scm.com/download/win)，装完重开终端。若 `.git` 不存在先 `git init` 并 `git add . && git commit -m "init"`。
> - 方式B（图形界面，免命令）：装 [GitHub Desktop](https://desktop.github.com/)，登录后 Add Local Repository 选 `ai-news-miniprogram` 目录 → Publish repository。

在 GitHub 网页新建一个**空仓库**（不要勾 README/.gitignore），然后（方式A）：

```powershell
cd D:\20260402qoder\ai-news-miniprogram
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 配置 3 个 Secrets

仓库页面 → Settings → Secrets and variables → Actions → New repository secret，逐个添加：

| Name | Value |
|---|---|
| `TURSO_URL` | `libsql://ai-news-xxxx.turso.io` |
| `TURSO_AUTH_TOKEN` | `eyJhbGciOi...` |
| `DASHSCOPE_API_KEY` | `sk-...`（与 pipeline/.env 里相同） |

### 3. 手动触发验证

仓库 → Actions → "AI News Collection Pipeline" → Run workflow → Run workflow。

**预期**：几分钟后变绿。点开日志应看到：

```
[OK] Hacker News AI: N 条
[OK] TechCrunch AI: N 条
...（7 源全部 [OK]，含 机器之心/量子位 爬虫）
AI筛选完成: N条 -> M条入选
写入完成: 新增 X 条, 跳过 Y 条(重复)
```

之后每天北京时间 08:00 / 14:00 / 20:00 自动三轮采集（共享每日 10-20 条日配额，增量轮只补高价值新增；cron 已配置，无需干预）。

> 注：runner 是 ubuntu-latest，自带 curl（机器之心爬虫依赖）、Node 20 由 setup-node 提供、`npm install` 会装 cheerio，均已确认无缺失。

---

## 资料库存档同步机制（2026-09-04 起为增量合并）

存档 = `data/archive/{URL哈希}/`（article.html + images/），采集管线 `fetch-content.mjs` 按哈希建目录纯增量写入，从不读旧条目。

- **推送**（`pipeline/sync-push.mjs`）：先 `GET /api/archive-manifest` 拉服务器存量目录名清单，只打包本地有、服务器没有的新目录（增量 tar，一般每轮几 MB），`POST /api/sync-archive` 上传；无新增则跳过。不再整包上传（旧机制每轮 276MB）。
- **服务器**（`local-server.mjs`）：`/api/sync-archive` 解包后逐目录合并进 `data/archive`——同名覆盖、不动包外其他目录，天然不误删历史，存档全量永久保留（crontab 的 prune-archive.mjs 删图任务已停用）。
- `/api/sync-archive-download`（整包下载）已退役，采集链路不再调用，保留仅作兼容/整包迁移用。
- 磁盘水位：服务器 `daily-check.mjs` 检查 `/opt` 使用率，>75% 在快照输出 `disk_alert`。

---

## ④ 小程序：切换生产地址

编辑 `miniprogram/utils/config.js`，两处改动：

```js
// 1. 切换环境
const ENV = 'prod';   // 原来是 'dev'

// 2. 把 prod.apiBase 改成 ② 中拿到的实际地址
prod: {
  apiBase: 'https://ai-news-api-xxxx.vercel.app',
},
```

微信开发者工具重新编译即可。正式发布前记得在微信公众平台 → 开发管理 → 服务器域名 → request 合法域名中添加 `https://ai-news-api-xxxx.vercel.app`。

---

## 本地兜底采集任务（临时，云端 ③ 就绪后请删除）

为保证云端部署完成前每天也有新数据，已注册一个 Windows 计划任务 **AINewsCollect**：

- 每天 **08:00** 本地跑一轮 `pipeline/collect.mjs`（写本地 `data/articles.db`），`StartWhenAvailable`：若 8 点电脑没开，开机后会自动补跑
- 依赖：电脑开机、不休眠；用 `C:\Program Files\nodejs\node.exe`；日志在 `pipeline/collect-cron.log`
- 包装脚本：`pipeline/run-collect.ps1`

常用命令（PowerShell）：

```powershell
Get-ScheduledTaskInfo -TaskName AINewsCollect        # 看下次/上次运行
Start-ScheduledTask   -TaskName AINewsCollect        # 立即手动跑一轮
Unregister-ScheduledTask -TaskName AINewsCollect -Confirm:$false   # 云端就绪后删除
```

> ⚠️ 云端 GitHub Actions 上线后，务必删除该本地任务，否则本地库与云端库会各跑各的、产生两套数据。

---

## 故障速查

| 症状 | 排查 |
|---|---|
| seed-turso.mjs 报"缺少 TURSO_URL" | .env 里两行是否写对；是否在 pipeline 目录下运行 |
| Vercel 端点 500 | 环境变量是否配了 production 且 redeploy 过；Functions 日志 |
| Actions 里机器之心 [FAIL] | 机器之心 WAF 波动，重跑一次 workflow；连续失败则需检查爬虫 |
| 小程序白屏 | config.js 的 ENV 和 apiBase；微信后台合法域名 |
