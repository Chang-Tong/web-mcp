// 网页抓取：fetch URL 并提取内容（text / readable / json 三种模式）
// 借鉴 fetch-mcp 的多格式设计与 open-webSearch 的 URL 校验/GitHub README 支持
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 走系统代理（与 search.mjs 一致）
let proxyAgent = null;
try {
  const { EnvHttpProxyAgent } = await import("undici");
  proxyAgent = new EnvHttpProxyAgent();
} catch {}

// 简单 cookie jar
const cookieJar = new Map();

function saveCookies(url, res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  if (!setCookies.length) return;
  const host = new URL(url).hostname;
  const names = new Map();
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

// ---------- 粗提取（text 模式） ----------

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<(h[1-6])[^>]*>/gi, (_, t) => `\n\n${"#".repeat(Number(t[1]))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${text.trim()}](${href})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metaContent(html, prop) {
  return (
    html.match(new RegExp(`(?:property|name)="${prop}" content="([^"]*)"`, "i"))?.[1]?.trim() || ""
  );
}

// ---------- 正文提取（readable 模式，fetch-mcp 的 fetch_readable 思路） ----------

async function extractReadable(html, url) {
  const [{ Readability }, { parseHTML }] = await Promise.all([
    import("@mozilla/readability"),
    import("linkedom"),
  ]);
  const doc = parseHTML(html);
  // 补 base 标签，让相对链接可解析
  const base = doc.document.createElement("base");
  base.setAttribute("href", url);
  doc.document.head?.appendChild(base);
  const article = new Readability(doc.document).parse();
  if (!article || !article.textContent) return { ok: false, reason: "未能提取正文（可能是 JS 渲染页面或内容为空）" };
  return { ok: true, title: article.title || "", byline: article.byline || "", textContent: article.textContent.trim() };
}

// ---------- PDF / DOCX 解析 ----------

async function parsePdf(buffer) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 });
  const result = await parser.getText();
  return result.text || "";
}

async function parseDocx(buffer) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
  return result.value || "";
}

// ---------- GitHub 仓库 README 抓取（open-webSearch 思路） ----------

async function httpGetText(url, { timeoutMs = 15_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const host = new URL(url).hostname;
    const jar = cookieJar.get(host);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(jar ? { Cookie: jar } : {}), ...headers },
      signal: controller.signal,
      redirect: "follow",
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    });
    saveCookies(url, res);
    if (!res.ok) return null;
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGithubReadme(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/[^/]+)?\/?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  // 优先 raw README；支持 README.md / README / readme.md
  for (const name of ["README.md", "README", "readme.md"]) {
    const text = await httpGetText(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`);
    if (text != null) {
      return {
        type: "github_readme",
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}`,
        text,
        chars: text.length,
      };
    }
  }
  return null;
}

// ---------- 主入口 ----------

async function extractHtml(html, finalUrl, mode, maxChars) {
  // readable 模式：Readability 提取正文（去导航/广告）
  if (mode === "readable") {
    const ext = await extractReadable(html, finalUrl);
    if (ext.ok) {
      const truncated = ext.textContent.length > maxChars;
      return {
        type: "readable",
        url: finalUrl,
        title: ext.title,
        byline: ext.byline,
        text: truncated ? ext.textContent.slice(0, maxChars) + "\n…（已截断）" : ext.textContent,
        chars: Math.min(ext.textContent.length, maxChars),
        truncated,
      };
    }
    // 提取失败则降级为 text 模式，附说明
    const text = stripTags(html);
    return {
      type: "text",
      url: finalUrl,
      title: "",
      note: `readable 提取失败（${ext.reason}），已降级为粗提取`,
      text: text.slice(0, maxChars),
      chars: text.length,
    };
  }

  // auto / text 模式：粗提取
  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ||
    metaContent(html, "og:title") ||
    "";
  const description = metaContent(html, "description");
  let text = stripTags(html);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars) + "\n…（已截断）";
  return { type: "text", url: finalUrl, title, description, text, chars: text.length, truncated };
}

export async function fetchPage(url, {
  maxChars = 20_000,
  timeoutMs = 30_000,
  mode = "auto", // auto | text | readable | json
  headers = {}, // 自定义请求头（fetch-mcp 思路）
} = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`仅支持 http/https URL，收到: ${url}`);

  // GitHub 仓库页 → 直接抓 README
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(url)) {
    const readme = await fetchGithubReadme(url);
    if (readme) return readme;
    // 非仓库页（issue/PR 等）继续走普通抓取
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const host = new URL(url).hostname;
    const jar = cookieJar.get(host);
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        ...(jar ? { Cookie: jar } : {}),
        ...headers,
      },
      signal: controller.signal,
      redirect: "follow",
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
    });
    saveCookies(url, res);
    if (!res.ok) {
      // 403/5xx：目标站反爬/封锁 → 浏览器渲染兜底（不处理 json 模式与显式认证头）
      if (mode !== "json") {
        try {
          const { renderPage } = await import("./browser.mjs");
          const rendered = await renderPage(url, { timeoutMs: Math.min(timeoutMs, 30_000) });
          return extractHtml(rendered.html, rendered.finalUrl || url, mode, maxChars);
        } catch {}
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const finalUrl = res.url || url;

    // PDF / DOCX：下载后解析为文本（PDF 是 agent 抓资料的高频场景）
    const isPdf = contentType.includes("pdf") || /\/pdf(?:\?|$)/i.test(finalUrl);
    const isDocx = contentType.includes("officedocument.wordprocessingml") || /\.[dD][oO][cC][xX](?:\?|$)/.test(finalUrl);
    if (isPdf || isDocx) {
      const buf = Buffer.from(await res.arrayBuffer());
      const sizeMb = buf.length / 1024 / 1024;
      if (sizeMb > 30) return { type: "binary", url: finalUrl, title: "", text: `[文件过大 ${sizeMb.toFixed(1)}MB，超过 30MB 限制]`, chars: 0 };
      try {
        const text = isPdf ? await parsePdf(buf) : await parseDocx(buf);
        const truncated = text.length > maxChars;
        return {
          type: isPdf ? "pdf" : "docx",
          url: finalUrl,
          title: "",
          text: truncated ? text.slice(0, maxChars) + "\n…（已截断）" : text,
          chars: text.length,
          truncated,
          sizeMb: Number(sizeMb.toFixed(2)),
        };
      } catch (e) {
        return { type: "binary", url: finalUrl, title: "", text: `[文档解析失败: ${e.message.slice(0, 100)}]`, chars: 0 };
      }
    }

    // JSON 内容（API 接口）→ 直接返回解析后的 JSON
    if (mode === "json" || (mode === "auto" && contentType.includes("json"))) {
      const raw = await res.text();
      try {
        return { type: "json", url: finalUrl, json: JSON.parse(raw), chars: raw.length };
      } catch {
        return { type: "text", url: finalUrl, title: "", text: raw.slice(0, maxChars), chars: raw.length };
      }
    }

    // 非 HTML/文本内容（图片/PDF/音视频等）：只返回元信息，不硬啃二进制
    if (!contentType.includes("html") && !contentType.includes("text") && !contentType.includes("xml")) {
      return {
        type: "binary",
        url: finalUrl,
        title: "",
        text: `[非网页内容] content-type: ${contentType}`,
        chars: 0,
      };
    }

    const html = await res.text();
    return extractHtml(html, finalUrl, mode, maxChars);
  } finally {
    clearTimeout(timer);
  }
}
