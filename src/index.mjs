#!/usr/bin/env node
// web-mcp：联网搜索 + 网页抓取的 MCP 服务
// 用法：
//   node src/index.mjs                     # stdio transport（本地 MCP 客户端）
//   node src/index.mjs --http 8787         # Streamable HTTP（联网部署，/mcp 端点）
//   node src/index.mjs --http 8787 --host 0.0.0.0
//
// 环境变量：
//   SEARCH_ENGINE        duckduckgo（默认，免 key）| serper（需 key）
//   SERPER_API_KEY       Serper 的 Google 搜索 key
//   SERPER_GL / SERPER_HL  搜索地区/语言，默认 cn / zh-cn
//   WEB_MCP_AUTH_TOKEN   可选；HTTP 模式下设置后要求 Authorization: Bearer <token>
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { webSearch } from "./search.mjs";
import { fetchPage } from "./fetch.mjs";
import { searchSummarize, deepSearch } from "./summarize.mjs";

const str = (v) => JSON.stringify(v, null, 2);
const textContent = (v) => [{ type: "text", text: str(v) }];

function createMcpServer() {
  const server = new McpServer(
    { name: "web-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // ---- 工具 1：联网搜索 ----
  server.registerTool(
    "web_search",
    {
      title: "联网搜索",
      description:
        "多引擎并行搜索并返回结构化结果（title/url/snippet/domain/engine 来源）。支持 baidu/brave/bing/duckduckgo（免 key）与 serper（Google，需 SERPER_API_KEY）；auto 模式按查询语言自动选引擎。需要最新信息、事实核查、查新闻、找参考资料时调用；拿到结果后一般再用 fetch_page 打开正文。",
      inputSchema: {
        query: z.string().describe("搜索关键词，可带引号精确匹配"),
        max_results: z.number().min(1).max(20).optional().describe("返回条数，默认 5，多引擎并行时按引擎均分再合并去重"),
        recency: z.enum(["day", "week", "month", "year"]).optional().describe("时间过滤：仅返回该时间范围内的结果（新闻/发布类查询建议用 week）"),
        engines: z.array(z.enum(["baidu", "brave", "bing", "duckduckgo", "csdn", "searxng", "tavily", "serper"])).optional().describe("指定搜索引擎（默认 auto 自动选择：中文查 baidu+csdn+brave+ddg，英文查 brave+baidu+bing+ddg）"),
      },
    },
    async (args) => {
      const out = await webSearch(args.query, {
        maxResults: args.max_results || 5,
        engines: args.engines,
        recency: args.recency,
      });
      return { content: textContent(out) };
    }
  );

  // ---- 工具 2：抓取网页 ----
  server.registerTool(
    "fetch_page",
    {
      title: "抓取网页内容",
      description:
        "抓取一个 URL 的内容。支持三种模式：text（粗提取为 markdown，默认）、readable（Readability 提取正文，去导航/广告）、json（API 接口直接解析）。GitHub 仓库页自动抓取 README。用于引用、事实核查、阅读全文。",
      inputSchema: {
        url: z.string().describe("要抓取的 URL"),
        max_chars: z.number().min(1000).optional().describe("最多保留字符数，默认 20000"),
        mode: z.enum(["auto", "text", "readable", "json"]).optional().describe("提取模式，默认 auto（JSON 接口自动解析，HTML 粗提取）"),
        headers: z.record(z.string()).optional().describe("自定义请求头（如 {'Cookie': '...'} 绕过登录墙）"),
      },
    },
    async (args) => {
      const page = await fetchPage(args.url, {
        maxChars: args.max_chars || 20_000,
        mode: args.mode || "auto",
        headers: args.headers,
      });
      return { content: textContent(page) };
    }
  );

  // ---- 工具 3：搜索 + 摘要 ----
  server.registerTool(
    "search_summarize",
    {
      title: "搜索并生成摘要",
      description:
        "一步完成：搜索 → 并行抓取 top 结果正文 → DeepSeek 生成带引用标注的结构化中文摘要。适合『查资料写报告』类任务，省去多次 search+fetch 往返。需 DEEPSEEK_API_KEY（自动读 pi 凭据）；无 key 时退化为返回搜索+抓取结果。",
      inputSchema: {
        query: z.string().describe("研究主题或问题"),
        max_results: z.number().min(1).max(20).optional().describe("搜索条数，默认 6"),
        top_k: z.number().min(1).max(5).optional().describe("抓取并纳入摘要的结果数，默认 3"),
      },
    },
    async (args) => {
      const out = await searchSummarize(args.query, {
        maxResults: args.max_results || 6,
        topK: args.top_k || 3,
      });
      return { content: textContent(out) };
    }
  );

  // ---- 工具 4：多角度深度搜索 ----
  server.registerTool(
    "deep_search",
    {
      title: "多角度深度搜索",
      description:
        "把查询拆成多个角度（官方/技术细节/用户评价/最新动态等）的子查询并行搜索，分组返回，适合需要全面了解一个主题的场景。有 DEEPSEEK_API_KEY 时用 LLM 拆分角度，否则用规则拆分。",
      inputSchema: {
        query: z.string().describe("主题"),
        max_results: z.number().min(1).max(20).optional().describe("每个子查询的条数，默认 5"),
        sub_count: z.number().min(2).max(5).optional().describe("拆几个角度，默认 3"),
      },
    },
    async (args) => {
      const out = await deepSearch(args.query, {
        maxResults: args.max_results || 5,
        subCount: args.sub_count || 3,
      });
      return { content: textContent(out) };
    }
  );

  return server;
}

// ---- transport 选择 ----
const httpFlag = process.argv.indexOf("--http");
if (httpFlag >= 0) {
  const port = Number(process.argv[httpFlag + 1] || 8787);
  const hostFlag = process.argv.indexOf("--host");
  const host = hostFlag >= 0 ? process.argv[hostFlag + 1] : "0.0.0.0";
  const authToken = process.env.WEB_MCP_AUTH_TOKEN || "";

  const { createServer } = await import("node:http");
  const sessions = new Map(); // sessionId -> transport

  function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id"
    );
  }

  createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || host}`);

    // 健康检查
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "web-mcp", sessions: sessions.size }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    // 可选鉴权：Authorization: Bearer <token>
    if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    if (req.method === "DELETE") {
      const sid = req.headers["mcp-session-id"];
      const t = sid && sessions.get(sid);
      if (t) {
        await t.close();
        sessions.delete(sid);
      }
      res.writeHead(200);
      res.end("Closed");
      return;
    }

    try {
      const sid = req.headers["mcp-session-id"];
      let transport;
      if (sid) {
        transport = sessions.get(sid);
        if (!transport) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
      } else {
        const srv = createMcpServer();
        const sessionId = crypto.randomUUID();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        });
        sessions.set(sessionId, transport);
        transport.onclose = () => sessions.delete(sessionId);
        await srv.connect(transport);
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err?.message || err));
    }
  }).listen(port, host);

  const authNote = authToken ? "（已启用 Bearer token 鉴权）" : "（未启用鉴权，请自行限制访问）";
  console.error(`web-mcp listening on http://${host}:${port}/mcp ${authNote}`);
} else {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("web-mcp (stdio) ready");
}
