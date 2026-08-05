# web-mcp

联网搜索 + 网页抓取的 MCP 服务。多引擎并行搜索（免 key）、正文提取、搜索摘要与深度搜索，支持 stdio 与 Streamable HTTP 两种部署方式。任何支持 MCP 的 agent（Claude Code、Cursor、Codex、pi 等）都能接入。

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="Node >= 18">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP%20%2F%20stdio-orange" alt="MCP">
</p>

设计上吸收了多个主流开源 MCP 项目的优点，并针对免费搜索引擎的反爬做了大量实测验证。

| 借鉴项目 | 吸收的特性 |
|---|---|
| [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) | 多引擎并行编排、失败容忍、反爬关键词检测、CSDN 垂直引擎、GitHub README 抓取、代理支持 |
| [zcaceres/fetch-mcp](https://github.com/zcaceres/fetch-mcp) | 多格式抓取（text / readable / json）、自定义请求头 |
| [nickclyde/duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) | 搜索引擎限流保护、结构化结果输出 |
| [ihor-sokoliuk/mcp-searxng](https://github.com/ihor-sokoliuk/mcp-searxng) | 可选 SearXNG 自托管引擎 |
| [tavily-ai/tavily-mcp](https://github.com/tavily-ai/tavily-mcp) | 可选 Tavily API 引擎 |

## 特性

- **免 key 优先**：baidu / brave / bing / duckduckgo / csdn / github / arxiv 免 key 可用；可选 serper（Google）、tavily、searxng
- **多引擎并行**：`Promise.allSettled` 编排，单引擎失败不阻塞整体，结果按 URL 去重并带 `engine` 来源标签
- **反爬全套应对**（实测验证）：验证页检测、浏览器渲染兜底、brave 429 节流退避、ddg 202 转 POST、cookie jar、代理自动生效
- **意图感知路由**：按查询特征（code / academic / news / general）自动选择引擎组合
- **站点权重重排**：官方文档加权、内容农场降权，黑名单剔除，支持环境变量覆盖
- **网页抓取三模式**：text / readable（Readability）/ json，另支持 PDF、DOCX 解析与 GitHub README 自动抓取
- **搜索增强**：`search_summarize`（搜索→抓正文→LLM 带引用摘要）与 `deep_search`（多角度子查询）
- **两种部署**：stdio（本地 MCP 客户端）与 Streamable HTTP（联网部署，可选 Bearer 鉴权）

## 四个工具

### 1. `web_search` — 多引擎并行搜索

免 key 引擎并行执行，每个引擎满额请求，结果按 URL 去重合并，每条带 `engine` 来源标签。

**时间盒竞速**：默认 5 秒（`WEB_MCP_TIME_BOX` 可调）。结果数达标（≥ `max_results`）立即取消其余引擎提前返回；到期未达标也返回已有结果，绝不等待最慢引擎。返回 `elapsedMs`（实际耗时）、`waived`（因时间盒放弃的引擎）、`timeBoxMs`。

**意图感知路由**（auto 模式）：

| 意图 | 中文查询 | 英文查询 |
|---|---|---|
| code（api/报错/教程/框架） | csdn + github + brave + baidu | github + brave + bing |
| academic（论文/研究） | baidu + arxiv + brave + csdn | arxiv + brave + bing |
| news（发布/新闻/最新） | baidu + brave + bing | brave + bing + ddg |
| general | baidu + csdn + brave + ddg | brave + baidu + bing + ddg |

**站点权重重排**：内置权重表（github.com ×1.6、官方文档站加权；百家号 ×0.55、内容农场降权），黑名单域名直接剔除。可用 `SITE_WEIGHTS`（JSON）/ `SITE_BLOCKLIST`（逗号分隔）覆盖。

**recency 时间过滤**：`recency=day/week/month/year` 透传各引擎（brave tf、bing freshness、ddg df、serper tbs）。

### 2. `fetch_page` — 网页抓取（三模式 + 文档解析 + 浏览器兜底）

| 模式 | 说明 |
|---|---|
| `text`（默认） | 粗提取为 markdown，保留链接格式，截断到 `max_chars` |
| `readable` | Mozilla Readability 提取正文，去导航/广告（适合文章页），失败自动降级 text |
| `json` | 直接解析 JSON API 接口（`auto` 模式下检测到 JSON content-type 也自动走这里） |

附加能力：

- PDF / DOCX 自动解析（pdf-parse + mammoth，30MB 上限）
- GitHub 仓库页自动抓 README（raw.githubusercontent.com，走代理）
- 403/5xx 时浏览器渲染兜底（知乎等反爬站实测可抓）
- 自定义请求头（`headers` 参数，如带 Cookie 绕过登录墙）

### 3. `search_summarize` — 搜索 + 摘要

一步完成：搜索 → 并行抓 top 结果正文 → DeepSeek 生成带 `[1][2]` 引用标注的结构化中文摘要（总述 + 要点 + 关键事实）。查资料写报告场景省去多次 search+fetch 往返。无 `DEEPSEEK_API_KEY` 时退化为返回搜索+抓取结果。

### 4. `deep_search` — 多角度深度搜索

LLM 把查询拆成多个角度（官方/技术细节/评测/最新动态…）的子查询并行搜索，分组返回。无 LLM 时用规则拆分（原查询 + 官网 + 教程）。

## 快速开始

```bash
git clone https://github.com/Chang-Tong/web-mcp.git
cd web-mcp
npm install

# stdio 模式（本地 MCP 客户端）
node src/index.mjs

# HTTP 模式（联网部署，局域网/公网可访问）
node src/index.mjs --http 8787

# 带鉴权启动（推荐公网部署时开启）
WEB_MCP_AUTH_TOKEN=your-secret node src/index.mjs --http 8787
```

## 接入客户端

**Claude Code / Codex**（`~/.claude/settings.json` 或项目 `.mcp.json`）：

```json
{
  "mcpServers": {
    "web": {
      "command": "node",
      "args": ["/absolute/path/to/web-mcp/src/index.mjs"]
    }
  }
}
```

**Cursor**（Settings → MCP，远程模式）：

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

**curl 验证 HTTP 服务**：

```bash
curl http://localhost:8787/health   # 健康检查，返回 { ok: true, ... }
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SEARCH_ENGINE` | `auto` | `auto` / 单引擎名（`baidu`/`brave`/`bing`/`csdn`/`duckduckgo`/`github`/`arxiv`）/ `serper` / `tavily` / `searxng` |
| `SERPER_API_KEY` | — | Serper 的 Google 搜索 key（免费 2500 次/月），最稳定，推荐配置 |
| `SERPER_GL` / `SERPER_HL` | `cn` / `zh-cn` | Serper 搜索地区/语言 |
| `TAVILY_API_KEY` | — | Tavily key（可选引擎） |
| `SEARXNG_URL` | — | 自托管 SearXNG 实例地址（可选引擎，需开启 JSON 格式） |
| `DEEPSEEK_API_KEY` | 自动读取 | search_summarize / deep_search 的 LLM（优先环境变量，其次 pi 的 `~/.pi/agent/auth.json`） |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 可指向 OpenAI 兼容的任意端点 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | LLM 模型名 |
| `SITE_WEIGHTS` | 内置表 | JSON 格式域名→权重，如 `{"github.com": 1.5}`；`SITE_WEIGHTS_MERGE=1` 时与内置合并 |
| `SITE_BLOCKLIST` | — | 逗号分隔的域名黑名单（直接剔除），如 `baijiahao.baidu.com` |
| `WEB_MCP_ENABLE_BROWSER` | 自动 | `0` 禁用浏览器兜底；`1` 强制启用 |
| `WEB_MCP_BROWSER_PATH` | 自动探测 | 指定浏览器可执行文件路径（系统 Chrome/Edge、playwright 缓存自动探测） |
| `WEB_MCP_AUTH_TOKEN` | — | HTTP 模式鉴权，设置后要求 `Authorization: Bearer <token>` |
| `WEB_MCP_DEBUG` | — | 设为 `1` 输出每个引擎的执行日志（stderr） |
| `WEB_MCP_TIME_BOX` | `5000` | web_search 时间盒（ms）：达标提前收 / 到期返回已有结果，不等最慢引擎 |

代理自动生效：`http_proxy` / `https_proxy` / `no_proxy`（undici `EnvHttpProxyAgent`），无代理环境自动直连，无需额外配置。

## 架构

```
MCP 客户端 (Claude Code / Cursor / Codex / ...)
   │  stdio 或 Streamable HTTP（stateful session，CORS + 可选 Bearer 鉴权）
   ▼
web-mcp (Node + @modelcontextprotocol/sdk)
   ├── web_search ── 并行多引擎 ──┬─ baidu / csdn（中文，免 key）
   │                             ├─ brave（免 key，节流+退避重试）
   │                             ├─ bing / duckduckgo（免 key）
   │                             └─ serper / tavily / searxng（可选）
   └── fetch_page ── text / readable(Readability) / json / GitHub README
```

## 已知限制

- 免费引擎在代理 IP 池下会被间歇风控（brave 429、baidu 验证页、ddg 202），多引擎并行 + 快速失败 + 浏览器兜底已把影响降到最低；要最稳定体验请配置 `SERPER_API_KEY`
- 浏览器兜底需要本机有 Chrome/Edge/Chromium（自动探测系统浏览器与 playwright 缓存），首次启动浏览器约 3-10s
- search_summarize / deep_search 依赖 `DEEPSEEK_API_KEY`（默认自动读 pi 凭据）

## 测试

```bash
node test-client.mjs "搜索词"   # stdio 冒烟测试：搜索 + 抓取
```

## 贡献

欢迎提交 Issue 和 PR。代码风格保持简单，每个引擎的失败容忍逻辑建议附上实测场景说明。

## 许可证

[MIT](./LICENSE)
