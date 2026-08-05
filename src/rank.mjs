// 结果排序：站点权重 + 黑名单
// 环境变量：
//   SITE_BLOCKLIST  逗号分隔的域名黑名单（完全剔除），如 "baijiahao.baidu.com,mp.weixin.qq.com"
//   SITE_WEIGHTS    JSON 格式的域名→权重，如 {"github.com": 1.5, "csdn.net": 0.8}（覆盖内置默认）
//   SITE_WEIGHTS_MERGE  1 时与内置默认合并，否则完全替换（默认替换）

// 内置默认权重：官方文档/权威源加权，内容农场/低质聚合站降权
const DEFAULT_WEIGHTS = {
  // 官方与技术权威（加权）
  "github.com": 1.6,
  "modelcontextprotocol.io": 1.6,
  "developer.mozilla.org": 1.5,
  "arxiv.org": 1.4,
  "react.dev": 1.4,
  "vuejs.org": 1.4,
  "anthropic.com": 1.3,
  "openai.com": 1.3,
  "cloud.google.com": 1.3,
  "pypi.org": 1.3,
  "npmjs.com": 1.3,
  "microsoft.com": 1.2,
  "apple.com": 1.2,
  "w3.org": 1.2,
  "ietf.org": 1.2,
  "wikipedia.org": 1.15,
  "stackoverflow.com": 1.15,
  "zhihu.com": 1.05,
  "oschina.net": 1.05,
  "infoq.cn": 1.05,
  // 内容农场/低质聚合（降权）
  "baijiahao.baidu.com": 0.55,
  "mp.weixin.qq.com": 0.75,
  "sohu.com": 0.7,
  "163.com": 0.75,
  "toutiao.com": 0.7,
  "csdn.net": 0.85,
  "juejin.cn": 0.95,
};

function loadWeights() {
  const env = process.env.SITE_WEIGHTS;
  if (env) {
    try {
      const parsed = JSON.parse(env);
      if (process.env.SITE_WEIGHTS_MERGE === "1") return { ...DEFAULT_WEIGHTS, ...parsed };
      return parsed;
    } catch (e) {
      console.error(`[web-mcp] SITE_WEIGHTS 解析失败（应为 JSON）: ${e.message}`);
    }
  }
  return DEFAULT_WEIGHTS;
}

const weights = loadWeights();

function loadBlocklist() {
  return (process.env.SITE_BLOCKLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, ""))
    .filter(Boolean);
}
const blocklist = loadBlocklist();

/** 域名归一化：去掉 www. 和端口 */
function normalizeDomain(host) {
  return (host || "").toLowerCase().replace(/^www\./, "").split(":")[0];
}

/** 域名精确匹配 + 父域后缀匹配（如 "baijiahao.baidu.com" 命中 "baidu.com" 下的子域） */
function domainScore(host) {
  const d = normalizeDomain(host);
  if (!d) return 1;
  if (blocklist.includes(d)) return 0;
  // 先精确，再尝试逐级父域
  for (const [domain, w] of Object.entries(weights)) {
    if (d === domain) return w;
  }
  const parts = d.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (weights[parent] !== undefined) return weights[parent];
  }
  return 1;
}

/**
 * 对搜索结果重排：黑名单剔除 + 站点权重加权（稳定的次排序：同权重保持原顺序）
 * 注意：多引擎结果原本就按引擎分组混合，这里做全局重排，权重高的站点排前面
 */
export function rerank(results) {
  const scored = results
    .map((r) => {
      const w = domainScore(r.domain || r.url);
      return { r, w };
    })
    .filter((x) => x.w > 0) // 黑名单直接剔除
    .sort((a, b) => b.w - a.w);
  return scored.map((x) => x.r);
}
