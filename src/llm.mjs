// LLM 调用层：DeepSeek（OpenAI 兼容 chat/completions）
// key 优先级：DEEPSEEK_API_KEY 环境变量 > pi 的 ~/.pi/agent/auth.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function readPiAuth() {
  try {
    const p = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d?.deepseek?.key || null;
  } catch {
    return null;
  }
}

const apiKey = process.env.DEEPSEEK_API_KEY || readPiAuth();
const baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";

export function llmAvailable() {
  return !!apiKey;
}

/**
 * 调用 DeepSeek，返回纯文本。
 * @param {string} system 系统提示
 * @param {string} user 用户内容
 * @param {object} opts { maxTokens, temperature, timeoutMs, jsonMode }
 */
export async function chat(system, user, { maxTokens = 2000, temperature = 0.3, timeoutMs = 60_000, jsonMode = false } = {}) {
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY（可 export 设置，或使用 pi 的 ~/.pi/agent/auth.json 凭据）");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(timer);
  }
}
