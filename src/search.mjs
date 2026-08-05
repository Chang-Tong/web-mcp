// 联网搜索后端（并行多引擎，免 key 优先）
//   baidu / brave / bing / duckduckgo  免 key，各自带反爬容忍（重试/节流）
//   serper                            可选，Google 结果，需 SERPER_API_KEY（最稳定）
//
// 编排策略（借鉴 open-webSearch）：
//   - 多引擎并行执行（Promise.allSettled），单引擎失败不阻塞整体
//   - 请求条数按引擎数均分（distributeLimit），合并后按 URL 去重
//   - 每个引擎独立超时；brave 429 退避重试、baidu 验证页重试、ddg 202 识别
//   - 结果带 engine 来源标签，agent 可据此判断可信度
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------- 通用 ----------

// 走系统代理（http_proxy/https_proxy/no_proxy 环境变量）；无代理环境自动直连
let proxyAgent = null;
try {
  const { EnvHttpProxyAgent } = await import("undici");
  proxyAgent = new EnvHttpProxyAgent();
} catch {
  // 无 undici 时降级为直连
}

// 简单的 cookie jar（按 host 存），减少搜索引擎风控命中
const cookieJar = new Map();

function saveCookies(url, res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  if (!setCookies.length) return;
  const host = new URL(url).hostname;
  const names = new Map(); // 按 cookie 名去重，后写覆盖
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const [name] = pair.split("=");
    if (name) names.set(name.trim(), pair.trim());
  }
  const prev = cookieJar.get(host) || "";
  for (const pair of prev.split("; ")) {
    const [name] = pair.split("=");
    if (name && !names.has(name.trim())) names.set(name.trim(), pair.trim());
  }
  cookieJar.set(host, [...names.values()].join("; "));
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function cleanText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

/** 响应时间盒信号的 sleep：abort 时立即抛 AbortError，不睡满 */
async function sleepWithSignal(ms, signal) {
  if (signal?.aborted) throw new DOMException("timebox", "AbortError");
  if (!signal) {
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("timebox", "AbortError"));
    }, { once: true });
  });
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function httpFetch(url, { method = "GET", body, headers = {}, timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 外部信号（时间盒竞速）：外部 abort 时立即取消本请求
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw new DOMException("timebox", "AbortError");
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const host = new URL(url).hostname;
    const jar = cookieJar.get(host);
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", ...(jar ? { Cookie: jar } : {}), ...headers },
      body,
      signal: controller.signal,
      redirect: "follow",
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    });
    saveCookies(url, res);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------- 反爬检测（open-webSearch 思路） ----------
// 搜索引擎/站点返回验证页时页面含这些关键词，命中即视为被挡，提前失败触发重试
const BOT_KEYWORDS = [
  "captcha",
  "verify you are human",
  "access denied",
  "blocked",
  "rate limit",
  "too many requests",
  "请验证",
  "验证码",
  "人机验证",
  "访问异常",
  "安全验证",
];

function assertNotBotPage(html, engine) {
  const lower = html.toLowerCase();
  if (lower.length < 5000 && BOT_KEYWORDS.some((k) => lower.includes(k))) {
    throw new Error(`${engine}: 疑似反爬验证页`);
  }
}

/** 搜索引擎被风控时的终极兜底：真实浏览器渲染同一 URL 再解析（需浏览器可用） */
async function browserFallback(url, parseFn, { signal, timeoutMs = 30_000 } = {}) {
  if (signal?.aborted) throw new DOMException("timebox", "AbortError");
  let renderPage;
  try {
    ({ renderPage } = await import("./browser.mjs"));
    if (!renderPage) return null;
  } catch {
    return null;
  }
  // playwright 导航不响应 AbortSignal：超时压缩到剩余时间盒预算，避免拖满 30s
  const remaining = signal?.__remainingMs ? signal.__remainingMs() : timeoutMs;
  const budget = Math.max(1000, Math.min(timeoutMs, remaining));
  const { html } = await renderPage(url, { timeoutMs: budget });
  if (signal?.aborted) throw new DOMException("timebox", "AbortError");
  const results = parseFn(html);
  return results && results.length > 0 ? results : null;
}

// ---------- Brave ----------

function parseBraveHtml(html) {
  const results = [];
  for (const chunk of html.split('<div class="snippet svelte-jmfu5f"').slice(1)) {
    if (chunk.includes('data-type="ad"')) continue; // 跳过广告
    const a = chunk.match(/<a href="(https?:\/\/[^"]*)"[^>]*class="svelte-14r20fy l1">/);
    const title = chunk.match(/<div class="title search-snippet-title[^"]*" title="([^"]*)">/);
    if (!a || !title) continue;
    const snippetHtml = chunk.match(/<div class="generic-snippet[^>]*>[\s\S]*?<div class="content[^>]*>([\s\S]*?)<\/div>/);
    const cite = chunk.match(/<cite class="snippet-url[^>]*>([\s\S]*?)<\/cite>/);
    let snippet = cleanText(snippetHtml?.[1] || "");
    let date = "";
    const d = snippet.match(/^([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*/); // "June 30, 2026 - 正文"
    if (d) {
      date = d[1];
      snippet = snippet.slice(d[0].length);
    }
    results.push({
      title: cleanText(title[1]),
      url: a[1],
      snippet,
      date,
      domain: cleanText(cite?.[1] || "") || hostnameOf(a[1]),
    });
  }
  return results;
}

// brave 对高频请求敏感，全局节流：相邻请求至少间隔 1.5s
let lastBraveTs = 0;
async function braveThrottle(signal) {
  const gap = 1500 - (Date.now() - lastBraveTs);
  if (gap > 0) await sleepWithSignal(gap, signal);
  lastBraveTs = Date.now();
}

async function braveSearch(query, { maxResults = 5, timeoutMs = 15_000, recency, signal } = {}) {
  await braveThrottle(signal);
  if (signal?.aborted) throw new DOMException("timebox", "AbortError");
  let url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  const tf = { day: "pd", week: "pw", month: "pm", year: "py" }[recency];
  if (tf) url += `&tf=${tf}`;
  // 429/403 限流时退避重试：等 2s → 再等 5s（受时间盒约束，到期即放弃）
  const waits = [0, 2000, 5000];
  let lastErr = null;
  for (const wait of waits) {
    if (wait) await sleepWithSignal(wait, signal);
    try {
      const html = await httpFetch(url, { timeoutMs, signal });
      assertNotBotPage(html, "brave");
      return { engine: "brave", results: parseBraveHtml(html).slice(0, maxResults) };
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") throw err;
      if (!/HTTP (429|403)/.test(err.message)) throw err;
    }
  }
  // 持续限流 → 浏览器兜底（时间盒到期则放弃）
  const fb = await browserFallback(url, parseBraveHtml, { signal });
  if (fb) return { engine: "brave(browser)", results: fb.slice(0, maxResults) };
  throw new Error(`HTTP 429 (brave 持续限流${lastErr ? `: ${lastErr.message}` : ""})`);
}

// ---------- Bing（英文查询可用；中文查询质量差，auto 模式不启用） ----------

function parseBingHtml(html) {
  const results = [];
  for (const chunk of html.split('<li class="b_algo"').slice(1)) {
    const a = chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = cleanText(a[2]);
    if (!title) continue;
    const snip = chunk.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const cite = chunk.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
    results.push({
      title,
      url: a[1],
      snippet: cleanText(snip?.[1] || ""),
      date: "",
      domain: cleanText(cite?.[1] || "") || hostnameOf(a[1]),
    });
  }
  return results;
}

// bing 匿名 HTTP 常返回与查询无关的垃圾结果（中文分词 / 英文词条化，如查 "best mcp server" 返回词典）。
// 启发式检测：查询核心词（中文长片段 ≥3 字；英文词 ≥3 字母去停用词）在结果中命中率 <50% 判为无关 → 浏览器兜底
const EN_STOP = new Set(["the", "a", "an", "for", "and", "or", "of", "is", "are", "was", "were", "in", "on", "at", "to", "with", "from", "what", "how", "why", "its", "it", "this", "that", "you", "your", "not", "be", "by"]);

function looksIrrelevant(query, results) {
  const hay = results.map((r) => (r.title + " " + r.snippet).toLowerCase()).join(" ");
  // 中英文分开判定：中文片段按 CJK 命中率；英文查询按英文核心词命中率。
  // 混在一起会被英文专有名词（如 OpenAI）在词条页的命中拉高整体命中率，漏掉垃圾结果。
  const cjk = query.match(/[\u4e00-\u9fff]{3,}/g) || [];
  if (cjk.length > 0) {
    const hit = cjk.filter((c) => hay.includes(c)).length;
    if (hit / cjk.length < 0.5) return true;
  }
  const enWords = (query.toLowerCase().match(/[a-z]{3,}/g) || []).filter(
    (w) => !EN_STOP.has(w) && !["http", "https", "com", "org", "www"].includes(w)
  );
  if (enWords.length > 0) {
    const hit = enWords.filter((w) => hay.includes(w)).length;
    if (hit / enWords.length < 0.5) return true;
  }
  return false;
}

async function bingSearch(query, { maxResults = 5, timeoutMs = 10_000, recency, signal } = {}) {
  let url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}`;
  const freshness = { day: "Day", week: "Week", month: "Month", year: "Year" }[recency];
  if (freshness) url += `&freshness=${freshness}`;
  let results = [];
  try {
    const html = await httpFetch(url, { timeoutMs, signal });
    assertNotBotPage(html, "bing");
    results = parseBingHtml(html).slice(0, maxResults);
    if (results.length === 0) throw new Error("bing: 空结果");
    if (looksIrrelevant(query, results)) throw new Error("bing: 结果与查询无关（中文分词问题）");
    return { engine: "bing", results };
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (!/HTTP (429|403)|反爬|空结果|无关/.test(err.message)) throw err;
  }
  // 被风控/低质 → 浏览器兜底（时间盒到期则放弃）
  const fb = await browserFallback(url, parseBingHtml, { signal });
  if (fb && !looksIrrelevant(query, fb)) return { engine: "bing(browser)", results: fb.slice(0, maxResults) };
  return { engine: "bing", results: [], note: "bing 被风控且浏览器兜底失败" };
}

// ---------- Baidu（中文首选，间歇性验证页 → 重试） ----------

function parseBaiduHtml(html) {
  const results = [];
  for (const chunk of html.split('<div class="result c-container').slice(1)) {
    const mu = chunk.match(/mu="([^"]*)"/);
    const h3 = chunk.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    if (!mu || !h3) continue;
    const title = cleanText(h3[1]);
    let snippet = "";
    for (const m of chunk.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)) {
      const t = cleanText(m[1]);
      if (t.length > snippet.length && t !== title) snippet = t;
    }
    results.push({
      title,
      url: mu[1],
      snippet,
      date: "",
      domain: hostnameOf(mu[1]),
    });
  }
  return results;
}

async function baiduSearch(query, { maxResults = 5, timeoutMs = 10_000, signal } = {}) {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  // 百度间歇性返回验证页/跳转页（无结果容器即视为被挡），等待后重试一次（受时间盒约束）
  for (let attempt = 1; ; attempt++) {
    const html = await httpFetch(url, { timeoutMs, signal });
    assertNotBotPage(html, "baidu");
    const results = parseBaiduHtml(html).slice(0, maxResults);
    if (results.length > 0 || attempt >= 2) {
      if (results.length > 0) return { engine: "baidu", results };
      break; // 两次都被挡，进入浏览器兜底
    }
    await sleepWithSignal(2000, signal);
  }
  // 百度验证页 → 浏览器兜底
  const fb = await browserFallback(url, parseBaiduHtml, { signal });
  if (fb) return { engine: "baidu(browser)", results: fb.slice(0, maxResults) };
  return { engine: "baidu", results: [], note: "百度返回了空结果（可能被反爬）" };
}

// ---------- DuckDuckGo（部分网络环境被 202 限流，换网络可用） ----------

function decodeDdgLink(href) {
  // DDG 结果链接形如 //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.hostname.includes("duckduckgo.com") && u.searchParams.has("uddg")) {
      return u.searchParams.get("uddg");
    }
    return u.href;
  } catch {
    return href;
  }
}

function parseDdgHtml(html) {
  const results = [];
  for (const chunk of html.split('<div class="result ').slice(1)) {
    const a = chunk.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = cleanText(a[2]);
    if (!title) continue;
    const url = decodeDdgLink(a[1]);
    const snip = chunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const shown = chunk.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/);
    results.push({
      title,
      url,
      snippet: cleanText(snip?.[1] || ""),
      date: "",
      domain: cleanText(shown?.[1] || "") || hostnameOf(url),
    });
  }
  return results;
}

async function duckduckgoSearch(query, { maxResults = 5, timeoutMs = 10_000, recency } = {}) {
  // 优先 GET；被限流（报错或空结果）时退化为 POST 表单
  const df = { day: "d", week: "w", month: "m", year: "y" }[recency];
  let url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  if (df) url += `&df=${df}`;
  try {
    const html = await httpFetch(url, { timeoutMs });
    assertNotBotPage(html, "duckduckgo");
    const results = parseDdgHtml(html);
    if (results.length === 0) throw new Error("duckduckgo: 空结果（可能被限流）");
    return { engine: "duckduckgo", results: results.slice(0, maxResults) };
  } catch {
    // GET 被限流（报错或空结果）时退化为 POST 表单
    const html = await httpFetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://html.duckduckgo.com",
        Referer: "https://html.duckduckgo.com/html/",
      },
      body: new URLSearchParams({ q: query }),
      timeoutMs,
    });
    assertNotBotPage(html, "duckduckgo");
    return { engine: "duckduckgo", results: parseDdgHtml(html).slice(0, maxResults) };
  }
}

// ---------- CSDN（中文技术垂直源，JSON API，稳定免 key） ----------

async function csdnSearch(query, { maxResults = 5, timeoutMs = 10_000 } = {}) {
  const json = await httpFetch(
    `https://so.csdn.net/api/v3/search?q=${encodeURIComponent(query)}&t=blog&p=1`,
    { timeoutMs, headers: { Accept: "application/json" } }
  );
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`CSDN 返回非 JSON：${json.slice(0, 200)}`);
  }
  const results = (data.result_vos || []).slice(0, maxResults).map((r) => ({
    title: (r.title || "").replace(/<[^>]+>/g, ""), // 去掉 <em> 高亮标签
    url: r.url || "",
    snippet: (r.description || "").replace(/<[^>]+>/g, ""),
    date: r.create_time_str || "",
    author: r.author || r.nickname || "",
    domain: hostnameOf(r.url || ""),
  }));
  return { engine: "csdn", results };
}

// ---------- GitHub 仓库搜索（意图路由 code 场景，JSON API，内置节流） ----------

let lastGithubTs = 0;
async function githubThrottle(signal) {
  // 未认证 10 req/min，保守起见 7s 间隔
  const gap = 7000 - (Date.now() - lastGithubTs);
  if (gap > 0) await sleepWithSignal(gap, signal);
  lastGithubTs = Date.now();
}

async function githubSearch(query, { maxResults = 5, timeoutMs = 12_000, signal } = {}) {
  await githubThrottle(signal);
  const json = await httpFetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${maxResults}`,
    { timeoutMs, headers: { Accept: "application/vnd.github+json" } }
  );
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`GitHub API 返回非 JSON：${json.slice(0, 200)}`);
  }
  if (data.message) throw new Error(`GitHub API: ${data.message}`);
  const results = (data.items || []).slice(0, maxResults).map((r) => ({
    title: r.full_name || "",
    url: r.html_url || "",
    snippet: `${r.description || ""} ${r.language ? `[${r.language}]` : ""} ★${r.stargazers_count ?? "?"}`.trim(),
    date: (r.updated_at || "").slice(0, 10),
    domain: "github.com",
  }));
  return { engine: "github", results };
}

// ---------- arXiv 学术搜索（意图路由 academic 场景，Atom API 免 key） ----------

function stripXmlTags(s) {
  return (s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

async function arxivSearch(query, { maxResults = 5, timeoutMs = 12_000 } = {}) {
  const xml = await httpFetch(
    `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=relevance`,
    { timeoutMs, headers: { Accept: "application/atom+xml" } }
  );
  const entries = xml.split("<entry>").slice(1);
  const results = entries.slice(0, maxResults).map((e) => ({
    title: stripXmlTags(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""),
    url: e.match(/<id>([^<]*)<\/id>/)?.[1] || "",
    snippet: stripXmlTags(e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "").slice(0, 300),
    date: (e.match(/<published>([^<]*)<\/published>/)?.[1] || "").slice(0, 10),
    authors: (e.match(/<author>([\s\S]*?)<\/author>/)?.[1].match(/<name>([^<]*)<\/name>/g) || []).slice(0, 3).map((a) => a.replace(/<[^>]+>/g, "")),
    domain: "arxiv.org",
  }));
  return { engine: "arxiv", results };
}

// ---------- SearXNG（可选：自托管实例，JSON API，mcp-searxng 思路） ----------

async function searxngSearch(query, { maxResults = 5, timeoutMs = 10_000 } = {}) {
  const base = (process.env.SEARXNG_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("使用 searxng 引擎需设置 SEARXNG_URL（自托管实例，如 http://localhost:8080）");
  const json = await httpFetch(
    `${base}/search?q=${encodeURIComponent(query)}&format=json`,
    { timeoutMs, headers: { Accept: "application/json" } }
  );
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`SearXNG 返回非 JSON（实例需开启 JSON 格式：searxng.yml 中 formats 含 json）：${json.slice(0, 150)}`);
  }
  const results = (data.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
    date: r.publishedDate || "",
    domain: hostnameOf(r.url || ""),
  }));
  return { engine: "searxng", results };
}

// ---------- Tavily（可选：TAVILY_API_KEY，tavily-mcp 思路） ----------

async function tavilySearch(query, { maxResults = 5, apiKey, timeoutMs = 12_000 } = {}) {
  const json = await httpFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: maxResults, include_answer: false }),
    timeoutMs,
  });
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`Tavily 返回非 JSON：${json.slice(0, 200)}`);
  }
  const results = (data.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || "",
    date: r.published_date || "",
    domain: hostnameOf(r.url || ""),
  }));
  return { engine: "tavily", results };
}

// ---------- Serper（Google，需 key，最稳定） ----------

async function serperSearch(query, { maxResults = 5, apiKey, timeoutMs = 10_000, recency } = {}) {
  const gl = process.env.SERPER_GL || "cn";
  const hl = process.env.SERPER_HL || "zh-cn";
  const tbs = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[recency];
  const json = await httpFetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: Math.min(maxResults, 20), gl, hl, ...(tbs ? { tbs } : {}) }),
    timeoutMs,
  });
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`Serper 返回非 JSON：${json.slice(0, 200)}`);
  }
  if (data.error) throw new Error(`Serper 错误：${data.error}`);
  const results = (data.organic || []).slice(0, maxResults).map((r) => ({
    title: r.title || "",
    url: r.link || "",
    snippet: r.snippet || "",
    date: r.date || "",
    domain: hostnameOf(r.link || ""),
  }));
  return { engine: "serper", results };
}

// ---------- 引擎注册表与编排 ----------

const ENGINES = {
  baidu: { exec: baiduSearch, timeoutMs: 12_000 },
  brave: { exec: braveSearch, timeoutMs: 18_000 }, // 含节流+重试，超时给足
  bing: { exec: bingSearch, timeoutMs: 10_000 },
  csdn: { exec: csdnSearch, timeoutMs: 10_000 },
  duckduckgo: { exec: duckduckgoSearch, timeoutMs: 10_000 },
  github: { exec: githubSearch, timeoutMs: 12_000 },
  arxiv: { exec: arxivSearch, timeoutMs: 12_000 },
  searxng: { exec: searxngSearch, timeoutMs: 10_000 },
  tavily: { exec: tavilySearch, timeoutMs: 12_000 },
};

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) u.searchParams.delete(key);
    return u.href.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function mergeResults(engineResults, capPerEngine = 3) {
  const seen = new Set();
  const merged = [];
  for (const { engine, results } of engineResults) {
    let added = 0;
    for (const r of results) {
      const key = normalizeUrl(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...r, engine });
      if (++added >= capPerEngine) break; // 单引擎最多贡献 cap 条，保持来源多样性
    }
  }
  return merged;
}

/**
 * 解析要使用的引擎列表：
 *   - 显式 engines 参数优先（工具层透传，agent 可指定）
 *   - 否则读 SEARCH_ENGINE env：serper=Google；单引擎名=只用它；auto=按查询语言自动选
 *   - auto：含中文 → [baidu, brave, duckduckgo]（bing 中文查询稳定出垃圾结果，排除）
 *           纯英文 → [brave, baidu, bing, duckduckgo]
 */
// 模块级探测：浏览器兜底是否可用（resolveEngines 是同步函数，不能在里面 await）
let browserAvailableFlag = false;
try {
  const { browserAvailable } = await import("./browser.mjs");
  browserAvailableFlag = browserAvailable();
} catch {}

/**
 * 意图感知路由：按查询特征选引擎组合
 *   code     代码/报错/教程类 → GitHub / CSDN 优先
 *   academic 论文/研究类 → arXiv 优先
 *   news     新闻/发布类 → bing/brave（时间过滤支持好）
 *   general  默认按语言
 */
function detectIntent(query) {
  const q = query.toLowerCase();
  if (/(api|error|bug|fix|function|class|component|vue|react|angular|python|java|rust|node|npm|install|报错|教程|代码|实现|源码|sdk|框架|怎么用|如何使用|github)/.test(q)) return "code";
  if (/(论文|paper|arxiv|research|研究|期刊|journal|thesis|引用|学术|综述)/.test(q)) return "academic";
  if (/(发布|宣布|新闻|消息|最新|报道|上市|发布会|launch|release|announce|news|breaking|召回)/.test(q)) return "news";
  return "general";
}

const INTENT_ENGINES = {
  code: { cjk: ["csdn", "github", "brave", "baidu"], en: ["github", "brave", "bing", "duckduckgo"] },
  academic: { cjk: ["baidu", "arxiv", "brave", "csdn"], en: ["arxiv", "brave", "bing", "duckduckgo"] },
  news: { cjk: ["baidu", "brave", "bing"], en: ["brave", "bing", "duckduckgo"] },
  general: { cjk: ["baidu", "csdn", "brave", "duckduckgo"], en: ["brave", "baidu", "bing", "duckduckgo"] },
};

/**
 * 解析要使用的引擎列表：
 *   - 显式 engines 参数优先（工具层透传，agent 可指定）
 *   - 否则读 SEARCH_ENGINE env：serper=Google；单引擎名=只用它；auto=按意图+语言自动选
 */
function resolveEngines(query, requested) {
  if (requested && requested.length > 0) return { engines: requested.map((e) => e.toLowerCase()), intent: "manual" };
  const env = (process.env.SEARCH_ENGINE || "auto").toLowerCase();
  if (env === "serper") return { engines: ["serper"], intent: "manual" };
  if (env === "tavily") return { engines: ["tavily"], intent: "manual" };
  if (env === "searxng") return { engines: ["searxng"], intent: "manual" };
  if (env !== "auto") return { engines: [env], intent: "manual" };
  const intent = detectIntent(query);
  const hasCJK = /[\u4e00-\u9fff]/.test(query);
  let engines = INTENT_ENGINES[intent][hasCJK ? "cjk" : "en"];
  // 浏览器可用时，中文查询也启用 bing（HTTP 低质结果会走浏览器兜底）
  if (hasCJK && !engines.includes("bing") && browserAvailableFlag) {
    engines = [...engines.slice(0, 2), "bing", ...engines.slice(2)];
  }
  return { engines, intent };
}

export async function webSearch(query, { maxResults = 5, engines, recency, timeBoxMs } = {}) {
  if (!query || !query.trim()) throw new Error("query 不能为空");
  const t0 = Date.now();
  const { engines: engineNames, intent } = await resolveEngines(query, engines);
  const debug = !!process.env.WEB_MCP_DEBUG;
  const boxMs = timeBoxMs || Number(process.env.WEB_MCP_TIME_BOX) || 5000;
  const deadline = Date.now() + boxMs;
  const abortCtrl = new AbortController();

  const results = []; // {engine, results}
  const failures = [];
  const waived = []; // 因时间盒到期/达标提前收而放弃的引擎

  // 时间盒：到期 abort 所有未完成的引擎请求，不等最慢的
  const boxTimer = setTimeout(() => {
    const have = results.reduce((n, x) => n + x.results.length, 0);
    if (have >= maxResults) {
      abortCtrl.abort(); // 已达标，直接收
      return;
    }
    // 结果不足 → 给在途引擎 1.5s 缓冲（baidu 重试等常在此时出结果）
    setTimeout(() => abortCtrl.abort(), 1500);
  }, boxMs);
  // 浏览器兜底读取剩余预算
  abortCtrl.signal.__remainingMs = () => Math.max(0, deadline - Date.now());

  await Promise.all(
    engineNames.map(async (name) => {
      try {
        let out;
        if (name === "serper") {
          const apiKey = process.env.SERPER_API_KEY;
          if (!apiKey) throw new Error("需要设置环境变量 SERPER_API_KEY");
          out = await serperSearch(query, { maxResults, apiKey, recency, signal: abortCtrl.signal });
        } else if (name === "tavily") {
          const apiKey = process.env.TAVILY_API_KEY;
          if (!apiKey) throw new Error("需要设置环境变量 TAVILY_API_KEY");
          out = await tavilySearch(query, { maxResults, apiKey, signal: abortCtrl.signal });
        } else {
          const engine = ENGINES[name];
          if (!engine) throw new Error(`未知搜索引擎: ${name}`);
          // 每个引擎满额请求（不再均分），合并去重后截断
          out = await engine.exec(query, { maxResults, timeoutMs: engine.timeoutMs, recency, signal: abortCtrl.signal });
        }
        if (out.results.length > 0) {
          results.push({ engine: name, results: out.results });
          if (debug) console.error(`[web-mcp] ${name}: ${out.results.length} 条`);
        } else {
          failures.push({ engine: name, message: out.note || "空结果" });
          if (debug) console.error(`[web-mcp] ${name}: 空结果`);
        }
      } catch (err) {
        if (err?.name === "AbortError") {
          waived.push(name);
          if (debug) console.error(`[web-mcp] ${name}: 时间盒放弃`);
        } else {
          failures.push({ engine: name, message: err?.message || String(err) });
          if (debug) console.error(`[web-mcp] ${name}: ${err?.message}`);
        }
      }
      // 达标提前收：已收集结果 >= maxResults 时取消其余引擎
      const have = results.reduce((n, x) => n + x.results.length, 0);
      if (have >= maxResults && !abortCtrl.signal.aborted) {
        abortCtrl.abort();
      }
    })
  );
  clearTimeout(boxTimer);

  const merged = mergeResults(results).slice(0, maxResults);
  if (merged.length === 0) {
    throw new Error(
      `所有搜索引擎都失败（${engineNames.join(", ")}）。\n` +
        failures.map((f) => `  ${f.engine}: ${f.message}`).join("\n") +
        (waived.length ? `\n时间盒放弃: ${waived.join(", ")}` : "") +
        "\n提示：可设置 SERPER_API_KEY 使用稳定的 Google 搜索。"
    );
  }

  // 站点权重重排（黑名单剔除 + 权威站前置）
  const { rerank } = await import("./rank.mjs");
  const ranked = rerank(merged);

  return {
    query,
    intent,
    engines: engineNames,
    recency: recency || "any",
    results: ranked,
    failures,
    waived,
    elapsedMs: Date.now() - t0,
    timeBoxMs: boxMs,
  };
}
