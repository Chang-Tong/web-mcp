// web-mcp CLI 包装：供 Python/脚本调用（stdio JSON 输出）
//   node search-cli.mjs "查询词" [条数]   → {"results": [...], "failures": [...]}
//   node fetch-cli.mjs "URL" [text|readable|json] [maxChars] → {"content": "...", "title": "..."}
import { webSearch } from "./src/search.mjs";
import { fetchPage } from "./src/fetch.mjs";

const [,, cmd, arg1, arg2, arg3] = process.argv;

async function main() {
  if (cmd === "search") {
    const query = arg1 || "";
    const n = parseInt(arg2 || "5", 10);
    if (!query) { console.log(JSON.stringify({ error: "no query" })); return; }
    const res = await webSearch(query, n);
    console.log(JSON.stringify(res));
  } else if (cmd === "fetch") {
    const url = arg1 || "";
    const mode = arg2 || "readable";
    const maxChars = parseInt(arg3 || "6000", 10);
    if (!url) { console.log(JSON.stringify({ error: "no url" })); return; }
    const res = await fetchPage(url, { mode, maxChars });
    console.log(JSON.stringify(res));
  } else {
    console.log(JSON.stringify({ error: "usage: search-cli.mjs search|fetch ..." }));
  }
}

main().catch((e) => console.log(JSON.stringify({ error: String(e) })));
