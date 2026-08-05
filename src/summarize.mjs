// 高级搜索工具：search_summarize（搜索→抓正文→LLM 摘要）+ deep_search（多角度子查询）
import { webSearch } from "./search.mjs";
import { fetchPage } from "./fetch.mjs";
import { chat, llmAvailable } from "./llm.mjs";

/**
 * search_summarize：搜索 → 并行抓 topK 结果正文 → LLM 生成带引用的摘要
 * LLM 不可用（无 DEEPSEEK_API_KEY）时退化为返回搜索+抓取结果
 */
export async function searchSummarize(query, { maxResults = 6, topK = 3, maxChars = 8000 } = {}) {
  const search = await webSearch(query, { maxResults });

  // 并行抓取 topK 个结果正文（readable 优先，失败降级 text）
  const docs = await Promise.all(
    search.results.slice(0, topK).map(async (r) => {
      try {
        const page = await fetchPage(r.url, { mode: "readable", maxChars });
        return {
          url: r.url,
          title: r.title || page.title || "",
          engine: r.engine,
          text: page.text || "",
          ok: true,
          fetchType: page.type,
        };
      } catch (e) {
        return { url: r.url, title: r.title || "", engine: r.engine, text: "", ok: false, error: e.message.slice(0, 120) };
      }
    })
  );

  const usable = docs.filter((d) => d.ok && d.text.length > 200);
  if (!llmAvailable()) {
    return {
      query,
      summary: null,
      note: "未配置 DEEPSEEK_API_KEY（可 export 设置，或用 pi 的 ~/.pi/agent/auth.json），仅返回搜索与抓取结果",
      search,
      docs,
    };
  }
  if (usable.length === 0) {
    return { query, summary: null, note: "抓取的正文都不足 200 字（目标站反爬或 JS 渲染），无法生成摘要", search, docs };
  }

  const context = usable
    .map((d, i) => `[${i + 1}] ${d.title}\n来源: ${d.url}\n${d.text.slice(0, maxChars)}`)
    .join("\n\n---\n\n");

  const summary = await chat(
    "你是联网研究助手。基于提供的资料写一篇结构化中文摘要（300-500字）：先一句话总述，再分 2-4 个要点（带小标题），最后列「关键事实」清单。每个要点/事实末尾用 [数字] 标注引用来源（对应资料编号）。不要编造资料里没有的内容。",
    `查询: ${query}\n\n资料:\n${context.slice(0, 40_000)}`,
    { maxTokens: 1500, temperature: 0.3 }
  );

  return { query, summary, search, docs: usable };
}

// 无 LLM 时的规则拆分子查询
function ruleSplit(query) {
  const hasCJK = /[\u4e00-\u9fff]/.test(query);
  return hasCJK
    ? [query, `${query} 官网 官方`, `${query} 教程 入门`, `${query} 优缺点 评测`]
    : [query, `${query} official`, `${query} tutorial`, `${query} review pros cons`];
}

/**
 * deep_search：把查询拆成多个角度子查询并行搜索（官方/技术/评价），分组返回
 * LLM 可用时用 LLM 拆分，否则用规则拆分
 */
export async function deepSearch(query, { maxResults = 5, subCount = 3 } = {}) {
  let subs = [];
  let splitMethod = "rule";
  if (llmAvailable()) {
    try {
      const res = await chat(
        "你是搜索策略助手。把用户的查询拆成 {subCount} 个不同角度的搜索词（如官方信息、技术细节、用户评价/对比、最新动态等角度）。输出格式：JSON 对象，key 为 queries，value 是搜索词数组，只输出 JSON。",
        `查询: ${query}\n角度数: ${subCount}`,
        { jsonMode: true, maxTokens: 300, temperature: 0.5 }
      );
      // 剥离可能的 markdown 代码块围栏后解析
      const cleaned = (res || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed) ? parsed : parsed.queries || parsed.angles || parsed.sub_queries;
      if (Array.isArray(list) && list.length > 0) {
        subs = list.map((s) => (typeof s === "string" ? s : s?.query || s?.angle || String(s))).slice(0, subCount);
        splitMethod = "llm";
      }
    } catch {}
  }
  if (subs.length === 0) {
    subs = ruleSplit(query).slice(0, subCount);
  }

  // 并行搜索所有子查询
  const groups = await Promise.all(
    subs.map(async (q) => {
      try {
        const r = await webSearch(q, { maxResults });
        return { sub_query: q, ok: true, ...r };
      } catch (e) {
        return { sub_query: q, ok: false, error: e.message.slice(0, 150), results: [] };
      }
    })
  );

  return { query, split_method: splitMethod, groups };
}
