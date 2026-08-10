// 使用日志：记录每次搜索/抓取走的路径（默认 vs 兜底），便于调参
//   写入：logs/usage-YYYY-MM.jsonl（按月度分文件，JSONL 一行一条）
//   查询：logRecent() / logStats()，供 MCP 工具 web_log 调用
// 日志永远不能影响主流程：所有写失败静默吞掉
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.WEB_MCP_LOG_DIR || path.resolve(__dirname, "../logs");

let writeChain = Promise.resolve();

/** 追加一条日志（JSONL）；串行写避免并发交错 */
export function logEntry(entry) {
  const now = new Date();
  const file = path.join(LOG_DIR, `usage-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}.jsonl`);
  const line = JSON.stringify({ ts: now.toISOString(), ...entry }) + "\n";
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      await appendFile(file, line, "utf8");
    } catch {
      /* 静默 */
    }
  });
  return writeChain;
}

function monthFile(d) {
  return `usage-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`;
}

/** 读取最近 N 天的日志条目（按时间正序） */
export async function logRecent(days = 30, limit = 100) {
  const now = new Date();
  const files = new Set();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    files.add(monthFile(d));
  }
  const entries = [];
  for (const f of [...files].sort()) {
    try {
      const raw = await readFile(path.join(LOG_DIR, f), "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 文件不存在 */
    }
  }
  return entries.slice(-limit);
}

/**
 * 统计最近 N 天：默认 vs 兜底的使用情况
 * 返回结构化汇总，供 agent 与人工调参
 */
export async function logStats(days = 7) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
  const entries = await logRecent(days, 100000);

  const stat = {
    windowDays: days,
    since: new Date(cutoff).toISOString().slice(0, 10),
    search: { total: 0, ok: 0, fail: 0, tavilyFallback: 0, avgElapsedMs: 0, engines: {} },
    fetch: { total: 0, direct: 0, jina: 0, browser: 0, error: 0, avgElapsedMs: 0 },
    byDay: {},
  };

  let searchElapsed = 0;
  let fetchElapsed = 0;
  let se = 0;
  let fe = 0;

  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    if (t < cutoff) continue;
    const day = e.ts.slice(0, 10);
    stat.byDay[day] ||= { search: 0, fetch: 0 };
    if (e.type === "search") {
      stat.search.total++;
      stat.byDay[day].search++;
      if (e.error) {
        stat.search.fail++;
      } else {
        stat.search.ok++;
        if (e.tavilyFallback) stat.search.tavilyFallback++;
        searchElapsed += e.elapsedMs || 0;
        se++;
      }
      for (const en of e.engines || []) {
        const s = (stat.search.engines[en] ||= { requested: 0, ok: 0, fail: 0, waived: 0, cooled: 0 });
        s.requested++;
      }
      for (const be of e.byEngine || []) {
        const s = (stat.search.engines[be.engine] ||= { requested: 0, ok: 0, fail: 0, waived: 0, cooled: 0 });
        s.ok += be.n > 0 ? 1 : 0;
      }
      for (const f of e.failures || []) {
        const s = (stat.search.engines[f.engine] ||= { requested: 0, ok: 0, fail: 0, waived: 0, cooled: 0 });
        s.fail++;
      }
      for (const w of e.waived || []) {
        const s = (stat.search.engines[w] ||= { requested: 0, ok: 0, fail: 0, waived: 0, cooled: 0 });
        s.waived++;
      }
      for (const c of e.cooling || []) {
        const s = (stat.search.engines[c] ||= { requested: 0, ok: 0, fail: 0, waived: 0, cooled: 0 });
        s.cooled++;
      }
    } else if (e.type === "fetch") {
      stat.fetch.total++;
      stat.byDay[day].fetch++;
      const p = e.path || "direct";
      stat.fetch[p] = (stat.fetch[p] || 0) + 1;
      fetchElapsed += e.elapsedMs || 0;
      fe++;
    }
  }
  stat.search.avgElapsedMs = se ? Math.round(searchElapsed / se) : 0;
  stat.fetch.avgElapsedMs = fe ? Math.round(fetchElapsed / fe) : 0;
  return stat;
}
