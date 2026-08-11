# web-mcp

> **给本地小模型，插上联网的翅膀。** 🪽

跑在 Ollama / LM Studio 里的模型其实挺聪明，但它的世界停在了训练截止那一天：
问它今天的新闻，它一本正经地编；让它查最新文档，它给你三年前的 API。

**web-mcp 是一个完全免费、无需任何 API key 的 MCP 服务。** 装上它，你的模型立刻能实时搜索全网、抓取网页正文——不花一分钱，也不用注册任何账号。

Claude Code / Cursor / Codex / pi 等支持 MCP 的客户端，同样即插即用。

<p align="center">
  <img src="https://img.shields.io/github/stars/Chang-Tong/web-mcp?style=social" alt="GitHub Stars">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node >= 18">
  <img src="https://img.shields.io/badge/MCP-stdio%20%2F%20Streamable%20HTTP-orange" alt="MCP">
</p>

> ⭐ **如果它帮你省下了搜索 API 的钱，点个 Star 支持一下——这也是你以后找回这个项目最快的方式。**

## 为什么是 web-mcp

| 你的处境 | web-mcp 的答案 |
|---|---|
| 不想为搜索 API 付费 | **9 个免 key 引擎**：百度 / Brave / Bing / DuckDuckGo / CSDN / GitHub / arXiv / Wikipedia / StackOverflow |
| 免费引擎老是被风控 | **四层保命**：引擎自动冷却 → Tavily 免费额度兜底 → r.jina.ai 抓取兜底 → 浏览器渲染兜底 |
| 小模型等不起 | **时间盒竞速**：结果够了立刻返回，绝不等最慢的引擎 |
| 搜到一堆内容农场 | **站点权重重排**：官方文档加权，百家号降权，黑名单直接剔除 |
| 不知道模型联网时发生了什么 | **web_log 工具**：每次搜索/抓取走了哪条路径，一清二楚 |

## 60 秒上手

```bash
git clone https://github.com/Chang-Tong/web-mcp.git
cd web-mcp
npm install

# 命令行先爽一把（不需要任何客户端）
node cli.mjs search "今天有什么 AI 新闻"
node cli.mjs fetch "https://example.com/article"
```

## 接入你的客户端

**本地模型玩家**（Cherry Studio / Cline / Roo Code 等 + Ollama / LM Studio）——在客户端的 MCP 设置里添加：

```json
{
  "mcpServers": {
    "web": {
      "command": "node",
      "args": ["/绝对路径/web-mcp/src/index.mjs"]
    }
  }
}
```

**Claude Code / Codex / pi**（`~/.claude/settings.json` 或项目 `.mcp.json`）：同上配置即可。

**HTTP 模式**（团队共享 / 远程部署）：

```bash
node src/index.mjs --http 8787                          # 启动
WEB_MCP_AUTH_TOKEN=your-secret node src/index.mjs --http 8787   # 带鉴权（公网推荐）
curl http://localhost:8787/health                       # 健康检查
```

Cursor 远程接入：

```json
{
  "mcpServers": {
    "web": {
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer your-secret"
      }
    }
  }
}
```

## 五个工具

### 1. `web_search` — 多引擎并行搜索

免 key 引擎并行执行，结果按 URL 去重合并，每条带 `engine` 来源标签。

- **意图感知路由**：按查询特征自动选引擎组合

| 意图 | 中文查询 | 英文查询 |
|---|---|---|
| code（api/报错/教程） | csdn + github + stackoverflow + brave + baidu | github + stackoverflow + brave + bing + ddg |
| academic（论文/研究） | baidu + arxiv + wikipedia + brave + csdn | arxiv + wikipedia + brave + bing + ddg |
| news（发布/最新） | baidu + brave + bing | brave + bing + ddg |
| general | baidu + csdn + wikipedia + brave + ddg | wikipedia + brave + baidu + bing + ddg |

- **风控自动冷却**：引擎被限流后冷却 60s 不再调度（同一出口 IP 反复请求只会更糟）；连续两次时间盒放弃同样进冷却；Tavily 免费配额耗尽自动冷却到下月 1 日
- **Tavily 免费兜底**：auto 模式下免 key 引擎全灭时，自动用 Tavily 免费额度（每月 1000 次）兜最后一次
- **时间盒竞速**：默认 12 秒（`WEB_MCP_TIME_BOX` 可调）。结果达标立即取消其余引擎提前返回；到期未达标也返回已有结果
- **站点权重重排**：github.com ×1.6、官方文档加权；百家号 ×0.55、内容农场降权；黑名单剔除。`SITE_WEIGHTS` / `SITE_BLOCKLIST` 可覆盖
- **recency 时间过滤**：`day/week/month/year` 透传各引擎原生参数

### 2. `fetch_page` — 网页抓取

| 模式 | 说明 |
|---|---|
| `text`（默认） | 粗提取为 markdown，保留链接格式 |
| `readable` | Mozilla Readability 提取正文，去导航/广告（适合文章页） |
| `json` | 直接解析 JSON API（`auto` 模式检测到 JSON 自动走这里） |

附加能力：

- **反爬双兜底**：目标站 403/5xx 或网络错误时，先走 r.jina.ai 免费代理（免 key），不行再浏览器渲染（知乎等反爬站实测可抓）；返回结果标注走的哪条路径
- PDF / DOCX 自动解析（pdf-parse + mammoth，30MB 上限）
- GitHub 仓库页自动抓 README
- 自定义请求头（如带 Cookie 绕过登录墙）
- GBK / GB2312 / Big5 老站点编码自动识别

### 3. `search_summarize` — 搜索 + 摘要

一步完成：搜索 → 并行抓 top 结果正文 → DeepSeek 生成带 `[1][2]` 引用标注的结构化中文摘要。查资料写报告场景省去多次 search+fetch 往返。无 `DEEPSEEK_API_KEY` 时退化为返回搜索+抓取结果。

### 4. `deep_search` — 多角度深度搜索

LLM 把查询拆成多个角度（官方/技术细节/评测/最新动态…）的子查询并行搜索，分组返回。无 LLM 时用规则拆分。

### 5. `web_log` — 使用日志

搜索/抓取走了哪条路径，全量记录（JSONL 月度日志，写失败静默不影响主流程）：

- `action=stats`：各引擎成功率 / 冷却次数 / Tavily 兜底次数 / 抓取 direct·jina·browser·error 分布 / 日均请求量
- `action=recent`：最近日志明细

调参、排查风控、向别人证明"免费路线真的够用"，都靠它。

## 配置（环境变量）

全部可选。**零配置即可用**，按下表按需增强：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEARCH_ENGINE` | `auto` | `auto` / 单引擎名 / `serper` / `tavily` / `searxng` |
| `SERPER_API_KEY` | — | Serper 的 Google 搜索 key（免费 2500 次/月），追求最稳定体验时配置 |
| `SERPER_GL` / `SERPER_HL` | `cn` / `zh-cn` | Serper 搜索地区/语言 |
| `TAVILY_API_KEY` | — | Tavily key（免费 1000 次/月；auto 模式下兼作兜底引擎） |
| `SEARXNG_URL` | — | 自托管 SearXNG 实例地址（需开启 JSON 格式） |
| `DEEPSEEK_API_KEY` | 自动读取 | search_summarize / deep_search 的 LLM（优先环境变量，其次 pi 的 `~/.pi/agent/auth.json`） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 可指向任意 OpenAI 兼容端点 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | LLM 模型名 |
| `SITE_WEIGHTS` | 内置表 | JSON 域名→权重；`SITE_WEIGHTS_MERGE=1` 与内置合并 |
| `SITE_BLOCKLIST` | — | 逗号分隔的域名黑名单 |
| `WEB_MCP_TIME_BOX` | `12000` | 搜索时间盒（ms）：达标提前收 / 到期返回已有结果 |
| `WEB_MCP_ENABLE_BROWSER` | 自动 | `0` 禁用浏览器兜底；`1` 强制启用 |
| `WEB_MCP_BROWSER_PATH` | 自动探测 | 浏览器路径（系统 Chrome/Edge、playwright 缓存自动探测） |
| `WEB_MCP_LOG_DIR` | `./logs` | web_log 日志目录 |
| `WEB_MCP_AUTH_TOKEN` | — | HTTP 模式鉴权 |
| `WEB_MCP_DEBUG` | — | `1` 输出每个引擎的执行日志（stderr） |

代理自动生效：`http_proxy` / `https_proxy` / `no_proxy`，无代理环境自动直连。

## 架构

```
MCP 客户端（Claude Code / Cursor / Cherry Studio / Cline / pi / ...）
   │  stdio 或 Streamable HTTP（stateful session，CORS + 可选 Bearer 鉴权）
   ▼
web-mcp（Node + @modelcontextprotocol/sdk）
   ├── web_search ── 意图路由 → 并行多引擎 → 冷却/兜底 → 权重重排
   │      免 key：baidu / brave / bing / duckduckgo / csdn / github / arxiv / wikipedia / stackoverflow
   │      可选：serper / tavily / searxng
   ├── fetch_page ── text / readable / json → 反爬则 r.jina.ai → 浏览器渲染
   ├── search_summarize / deep_search ── 搜索 + LLM 摘要
   └── web_log ── JSONL 使用日志（stats / recent）
```

## 已知限制

- 免费引擎在代理 IP 池下会被间歇风控（brave 429、baidu 验证页、ddg 202）。多引擎并行 + 冷却 + Tavily 兜底 + 浏览器兜底已把影响降到最低；要最稳定体验请配置 `SERPER_API_KEY`
- 浏览器兜底需要本机有 Chrome/Edge/Chromium，首次启动约 3-10s
- search_summarize / deep_search 依赖 `DEEPSEEK_API_KEY`（默认自动读 pi 凭据）

## 测试

```bash
node test-client.mjs "搜索词"   # stdio 冒烟测试：搜索 + 抓取
```

## 喜欢这个项目？

web-mcp 是个人维护的开源项目，你的 Star 是它活下去的燃料：

- **对你**：Star 过的项目躺在你的 starred 列表里，下次配环境一秒找回；Releases 还能收到大版本更新提醒
- **对作者**：每一个 Star 都在说"这个方向是对的"，直接决定维护优先级
- **对社区**：Star 数会让更多本地模型玩家发现它——免费联网这条路，走的人越多越好走

愿意更进一步？把它推荐给用 Ollama 的朋友，或在相关 awesome 列表里提一嘴，都是莫大的帮助。🙏

[![Star History Chart](https://api.star-history.com/svg?repos=Chang-Tong/web-mcp&type=Date)](https://star-history.com/#Chang-Tong/web-mcp&Date)

## 致谢

设计上吸收了多个主流开源 MCP 项目的优点，并针对免费搜索引擎的反爬做了大量实测验证：

| 借鉴项目 | 吸收的特性 |
|---|---|
| [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) | 多引擎并行编排、失败容忍、反爬关键词检测、CSDN 垂直引擎、GitHub README 抓取、代理支持 |
| [zcaceres/fetch-mcp](https://github.com/zcaceres/fetch-mcp) | 多格式抓取（text / readable / json）、自定义请求头 |
| [nickclyde/duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) | 搜索引擎限流保护、结构化结果输出 |
| [ihor-sokoliuk/mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) | 可选 SearXNG 自托管引擎 |
| [tavily-ai/tavily-mcp](https://github.com/tavily-ai/tavily-mcp) | 可选 Tavily API 引擎 |

## 贡献

欢迎 Issue 和 PR。代码风格保持简单，每个引擎的失败容忍逻辑建议附上实测场景说明。

## 许可证

[MIT](./LICENSE)
