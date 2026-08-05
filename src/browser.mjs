// Playwright 按需兜底：真实浏览器渲染（解决 403/验证页/JS 渲染）
// - 懒加载：首次需要时才启动浏览器，单实例复用，空闲 60s 自动关闭
// - 浏览器探测顺序：WEB_MCP_BROWSER_PATH > 系统 Chrome/Chromium > playwright 缓存
// - 控制：WEB_MCP_ENABLE_BROWSER=0 可显式禁用；不设置时自动探测（探测到即启用）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function isEnabled() {
  return process.env.WEB_MCP_ENABLE_BROWSER !== "0";
}

function findExecutable() {
  if (process.env.WEB_MCP_BROWSER_PATH && fs.existsSync(process.env.WEB_MCP_BROWSER_PATH)) {
    return process.env.WEB_MCP_BROWSER_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // playwright 缓存：~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  try {
    const dirs = fs.readdirSync(cacheRoot).filter((d) => d.startsWith("chromium"));
    for (const dir of dirs) {
      const macDirs = ["chrome-mac", "chrome-mac-arm64", "chrome-linux", "chrome-win"];
      for (const m of macDirs) {
        const exe = path.join(cacheRoot, dir, m, m === "chrome-win" ? "chrome.exe" : "Chromium");
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch {}
  return null;
}

let browser = null;
let browserPromise = null;
let lastUsed = 0;
let executable = null;

const IDLE_TIMEOUT_MS = 60_000;

async function getBrowser() {
  if (!isEnabled()) throw new Error("浏览器兜底已禁用（WEB_MCP_ENABLE_BROWSER=0）");
  if (!browserPromise) {
    browserPromise = (async () => {
      executable = findExecutable();
      if (!executable) throw new Error("未找到可用浏览器（可设 WEB_MCP_BROWSER_PATH 指定 Chrome）");
      const { chromium } = await import("playwright-core");
      const args = ["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"];
      // 透传系统代理（http_proxy/https_proxy），让浏览器与 node fetch 走同一条路
      const proxy = process.env.https_proxy || process.env.http_proxy;
      if (proxy && !process.env.WEB_MCP_BROWSER_NO_PROXY) {
        const host = proxy.replace(/^https?:\/\//, "");
        args.push(`--proxy-server=http://${host}`);
      }
      browser = await chromium.launch({ executablePath: executable, headless: true, args });
      browser.on("disconnected", () => {
        browser = null;
        browserPromise = null;
      });
      console.error(`[web-mcp] 浏览器兜底已就绪: ${executable}`);
      return browser;
    })();
  }
  return browserPromise;
}

// 空闲自动回收
setInterval(() => {
  if (browser && Date.now() - lastUsed > IDLE_TIMEOUT_MS) {
    browser.close().catch(() => {});
    browser = null;
    browserPromise = null;
    console.error("[web-mcp] 浏览器已空闲关闭");
  }
}, 30_000).unref();

export function browserAvailable() {
  return isEnabled() && (!!executable || !!findExecutable());
}

/**
 * 用真实浏览器抓取页面 HTML。
 * @returns {Promise<{status: number, html: string}>} 或抛错
 */
export async function renderPage(url, { timeoutMs = 30_000, waitNetworkIdle = true } = {}) {
  const b = await getBrowser();
  lastUsed = Date.now();
  const context = await b.newContext({
    userAgent: UA,
    locale: "zh-CN",
    viewport: { width: 1366, height: 900 },
  });
  try {
    const page = await context.newPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (waitNetworkIdle) {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }
    const html = await page.content();
    return { status: resp?.status() || 200, html, finalUrl: page.url() };
  } finally {
    await context.close();
  }
}

/** 关闭浏览器（进程退出时调用） */
export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    browserPromise = null;
  }
}
