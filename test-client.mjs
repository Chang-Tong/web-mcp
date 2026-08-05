// 冒烟测试：以 stdio 客户端连上服务，依次调用 web_search 和 fetch_page
// 用法：node test-client.mjs ["搜索词"]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./src/index.mjs", import.meta.url).pathname],
});

const client = new Client({ name: "test-client", version: "0.1.0" });
await client.connect(transport);

console.log("== 工具列表 ==");
const tools = await client.listTools();
console.log(tools.tools.map((t) => t.name).join(", "));

const query = process.argv[2] || "Model Context Protocol 是什么";

console.log(`\n== web_search: ${query} ==`);
const r1 = await client.callTool({ name: "web_search", arguments: { query, max_results: 5 } });
let searchOut;
try {
  searchOut = JSON.parse(r1.content[0].text);
} catch {
  // MCP 错误响应（如全部引擎失败）
  console.log(`工具返回错误: ${r1.content?.[0]?.text?.slice(0, 300) || JSON.stringify(r1)}`);
  await client.close();
  process.exit(1);
}
console.log(
  `引擎: ${searchOut.engines.join(",")}，结果数: ${searchOut.results.length}` +
    (searchOut.failures.length ? `（失败: ${searchOut.failures.map((f) => `${f.engine}:${f.message.slice(0, 20)}`).join(" / ")}）` : "")
);
for (const r of searchOut.results) {
  console.log(`- [${r.engine}] ${r.title}\n  ${r.url}\n  ${(r.snippet || "").slice(0, 100)}`);
}

if (searchOut.results.length > 0) {
  const url = searchOut.results[0].url;
  console.log(`\n== fetch_page (readable): ${url} ==`);
  try {
    const r2 = await client.callTool({
      name: "fetch_page",
      arguments: { url, max_chars: 1200, mode: "readable" },
    });
    const page = JSON.parse(r2.content[0].text);
    console.log(`类型: ${page.type} | 标题: ${(page.title || "").slice(0, 50)}`);
    console.log(`正文前 300 字: ${(page.text || "").slice(0, 300).replace(/\n+/g, " ")}`);
  } catch (e) {
    console.log(`抓取失败（目标站可能反爬）: ${e.message.slice(0, 100)}`);
  }
}

await client.close();
console.log("\nOK");
