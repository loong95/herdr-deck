// Mermaid -> PNG, for the panel to draw with image().
//
// The panel can only draw what GPUI's rasterizer understands: a hand-written SVG
// works, mermaid's own SVG (CSS <style>, foreignObject, markers) comes out blank.
// A real browser has no such problem and Chrome/Edge is installed on every
// desktop this runs on, so the diagram is rendered in headless Chrome and
// screenshotted to a PNG, cached by content hash.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BROWSER_CANDIDATES = [
  process.env.PI_GUI_BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

export function browserPath() {
  for (const candidate of BROWSER_CANDIDATES) {
    try { if (existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

export function hashOf(code) {
  return createHash("sha1").update(code).digest("hex").slice(0, 16);
}

/** The path the panel's image() wants: relative to the app home, forward slashes. */
export function imagePathFor(hash) {
  return "mods/pi-gui/.cache/mermaid/" + hash + ".png";
}

export function cacheDir(appHome) {
  return join(appHome, "mods", "pi-gui", ".cache", "mermaid");
}

// No template literal on purpose: the page must not interpolate anything else.
function page(code, theme) {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const script = new URL("node_modules/mermaid/dist/mermaid.min.js", import.meta.url).href;
  return [
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
    "<style>html,body{margin:0;padding:0;background:transparent}#box{display:inline-block;padding:10px}</style>",
    "<script src=\"" + script + "\"></script>",
    "</head><body><div id=\"box\"><pre class=\"mermaid\">" + escaped + "</pre></div>",
    "<script>",
    "mermaid.initialize({ startOnLoad: false, theme: " + JSON.stringify(theme) + ", securityLevel: \"loose\" });",
    "window.__done = false;",
    "mermaid.run({ querySelector: \".mermaid\" })",
    "  .then(function () { window.__done = true; })",
    "  .catch(function (error) { window.__error = String(error); window.__done = true; });",
    "</script></body></html>",
  ].join("\n");
}

let browserPromise = null;

async function browser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const path = browserPath();
      if (!path) throw new Error("no chrome or edge found");
      const puppeteer = await import("puppeteer-core");
      return puppeteer.default.launch({
        executablePath: path,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
      });
    })().catch((error) => { browserPromise = null; throw error; });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try { const instance = await pending; await instance.close(); } catch {}
}

/** Render one diagram to a cached PNG. Returns its app-home-relative path, or null. */
export async function renderDiagram(appHome, code, theme) {
  const hash = hashOf(code);
  const file = join(cacheDir(appHome), hash + ".png");
  try { await mkdir(cacheDir(appHome), { recursive: true }); } catch {}
  let tab = null;
  try {
    const instance = await browser();
    tab = await instance.newPage();
    await tab.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
    // A file:// page so its file:// mermaid script is allowed to load; setContent
    // runs on about:blank, where the browser blocks that subresource.
    const htmlFile = join(tmpdir(), "pi-gui-mermaid-" + hash + ".html");
    await writeFile(htmlFile, page(code, theme || "dark"), "utf8");
    await tab.goto("file:///" + htmlFile.replace(/\\/g, "/"), { waitUntil: "load" });
    await tab.waitForFunction("window.__done === true", { timeout: 15000 });
    if (await tab.evaluate(() => window.__error || null)) return null;
    const box = await tab.$("#box");
    if (!box) return null;
    await box.screenshot({ path: file, omitBackground: true });
    return imagePathFor(hash);
  } catch {
    return null;
  } finally {
    if (tab) { try { await tab.close(); } catch {} }
  }
}
