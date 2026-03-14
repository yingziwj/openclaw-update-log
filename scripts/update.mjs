import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");

const SITE_URL =
  process.env.SITE_URL || "https://openclaw-update-log.pages.dev";
const REPO = "openclaw/openclaw";
const PER_PAGE = 100;
const DEFAULT_OFFLINE_PATH = path.join(__dirname, "offline-releases.json");

const HEADERS = {
  "User-Agent": "openclaw-update-log-generator",
  Accept: "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function parseMarkdown(body) {
  const lines = (body || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = {
    title: "更新内容",
    items: [],
    notes: [],
  };

  const pushCurrent = () => {
    if (current.items.length || current.notes.length) {
      sections.push(current);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      pushCurrent();
      current = {
        title: heading[1].trim(),
        items: [],
        notes: [],
      };
      continue;
    }

    const listItem = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listItem) {
      current.items.push(listItem[2].trim());
      continue;
    }

    if (line.trim()) {
      current.notes.push(line.trim());
    }
  }

  pushCurrent();
  return sections;
}

function parseModuleLabel(modulePart) {
  if (!modulePart) return "";
  const parts = modulePart.split("/").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]}（${parts.slice(1).join("/")}）`;
}

function splitSteps(text) {
  const raw = text.trim();
  const parts = raw
    .split(/;\s+|,\s+and\s+|,\s+with\s+|,\s+including\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [raw];
}

function simplifyText(text, sectionTitle) {
  const raw = text.trim();
  let clean = raw
    .replace(/\s*\([^)]*#\d+[^)]*\)\s*/g, " ")
    .replace(/\s*Thanks\s+@[\w-]+\.?/gi, "")
    .replace(/\s*thanks\s+@[\w-]+\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) clean = raw;

  let modulePart = "";
  let detailPart = clean;
  const colonIndex = clean.indexOf(":");
  if (colonIndex > 0 && colonIndex < 50) {
    modulePart = clean.slice(0, colonIndex).trim();
    detailPart = clean.slice(colonIndex + 1).trim();
  }

  const moduleLabel = parseModuleLabel(modulePart);
  const isFix = /fix/i.test(sectionTitle || "");
  const steps = splitSteps(detailPart);

  const summary = isFix
    ? moduleLabel
      ? `这条是在修复 ${moduleLabel} 相关的问题。`
      : "这条是在修复一个问题。"
    : moduleLabel
      ? `这条是 ${moduleLabel} 相关的功能改动/优化。`
      : "这条是功能改动/优化。";

  const detailLine = `原文内容拆开说就是：${detailPart}`;
  const impact = moduleLabel
    ? `影响范围：主要影响 ${moduleLabel} 相关功能或流程。`
    : "影响范围：主要影响对应功能或流程。";
  const action = moduleLabel
    ? `需要你做什么：一般不需要额外操作；如果你在用 ${moduleLabel}，更新后留意变化即可。`
    : "需要你做什么：一般不需要额外操作，更新后生效。";

  return {
    raw,
    summary,
    detailLine,
    steps,
    impact,
    action,
  };
}

function renderRelease(release) {
  const date = formatDate(release.published_at);
  const title = release.name || release.tag_name;
  const sections = parseMarkdown(release.body || "");

  const sectionHtml = sections
    .map((section) => {
      const items = section.items
        .map((item) => {
          const { raw, summary, detailLine, steps, impact, action } =
            simplifyText(item, section.title);
          const stepList =
            steps.length > 1
              ? `<ul class="steps">${steps
                  .map((step) => `<li>${escapeHtml(step)}</li>`)
                  .join("")}</ul>`
              : "";
          return `
            <li class="item">
              <div class="raw">原文：${escapeHtml(raw)}</div>
              <div class="plain">
                <div class="plain-title">通俗解释</div>
                <div class="plain-text">${escapeHtml(summary)}</div>
                <div class="plain-text">${escapeHtml(detailLine)}</div>
                ${stepList}
                <div class="plain-meta">${escapeHtml(impact)}</div>
                <div class="plain-meta">${escapeHtml(action)}</div>
              </div>
            </li>
          `;
        })
        .join("");

      const notes = section.notes
        .map((note) => {
          const { raw, summary, detailLine, steps, impact, action } =
            simplifyText(note, section.title);
          const stepList =
            steps.length > 1
              ? `<ul class="steps">${steps
                  .map((step) => `<li>${escapeHtml(step)}</li>`)
                  .join("")}</ul>`
              : "";
          return `
            <div class="note">
              <div class="raw">原文：${escapeHtml(raw)}</div>
              <div class="plain">
                <div class="plain-title">通俗解释</div>
                <div class="plain-text">${escapeHtml(summary)}</div>
                <div class="plain-text">${escapeHtml(detailLine)}</div>
                ${stepList}
                <div class="plain-meta">${escapeHtml(impact)}</div>
                <div class="plain-meta">${escapeHtml(action)}</div>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="section">
          <h4>${escapeHtml(section.title)}</h4>
          ${items ? `<ul class="list">${items}</ul>` : ""}
          ${notes}
        </div>
      `;
    })
    .join("");

  return `
    <article class="release" id="${escapeHtml(release.tag_name)}">
      <header class="release-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p class="meta">
            发布时间：${escapeHtml(date)}
            ${release.prerelease ? " · 预览版" : ""}
          </p>
        </div>
        <a class="source" href="${escapeHtml(release.html_url)}" target="_blank" rel="noopener">
          查看原文
        </a>
      </header>
      ${sectionHtml || "<p class=\"empty\">此版本没有发布说明。</p>"}
    </article>
  `;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchAllReleases() {
  let url = `https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=1`;
  const releases = [];

  while (url) {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GitHub API 请求失败 (${response.status}): ${text.slice(0, 200)}`
      );
    }

    const page = await response.json();
    releases.push(...page);

    const linkHeader = response.headers.get("link");
    if (!linkHeader || !linkHeader.includes('rel="next"')) {
      url = "";
      continue;
    }

    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : "";
  }

  return releases.filter((release) => !release.draft);
}

async function loadOfflineReleases() {
  const offlinePath = process.env.OFFLINE_RELEASES_PATH || DEFAULT_OFFLINE_PATH;
  try {
    const data = await fs.readFile(offlinePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function buildSite() {
  let releases = [];
  try {
    releases = await fetchAllReleases();
  } catch (error) {
    const offline = await loadOfflineReleases();
    if (!offline) {
      throw error;
    }
    console.warn(
      "GitHub API unavailable. Using offline releases data for local preview."
    );
    releases = offline;
  }

  const html = `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw 版本更新日志（通俗版）</title>
    <meta name="description" content="把 OpenClaw 的版本更新日志翻译成农民伯伯都能看懂的中文解释版，逐条解释，不遗漏重要步骤。" />
    <meta name="keywords" content="OpenClaw, 更新日志, 版本说明, 通俗中文, release notes" />
    <link rel="canonical" href="${escapeHtml(SITE_URL)}" />
    <meta property="og:title" content="OpenClaw 版本更新日志（通俗版）" />
    <meta property="og:description" content="把 OpenClaw 的版本更新日志翻译成农民伯伯都能看懂的中文解释版，逐条解释，不遗漏重要步骤。" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(SITE_URL)}" />
    <meta name="twitter:card" content="summary" />
    <link rel="stylesheet" href="/style.css" />
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "OpenClaw 版本更新日志（通俗版）",
        url: SITE_URL,
        description:
          "把 OpenClaw 的版本更新日志翻译成农民伯伯都能看懂的中文解释版，逐条解释，不遗漏重要步骤。",
        inLanguage: "zh-CN",
      })}
    </script>
  </head>
  <body>
    <div class="bg"></div>
    <main>
      <header class="hero">
        <div class="badge">OpenClaw Update Log</div>
        <h1>OpenClaw 版本更新日志（通俗版）</h1>
        <p>
          这里把官方发布的更新日志逐条解释成大白话。每一条都保留原文，不省略重要步骤。
          如果原站新增、修改、删除内容，重新生成即可同步。
        </p>
        <div class="meta-row">
          <div>来源：GitHub Releases</div>
          <div>最后生成时间：${escapeHtml(new Date().toISOString())}</div>
        </div>
      </header>

      <section class="ad">
        <div class="ad-title">广告位（预留给 Google AdSense）</div>
        <div class="ad-box">这里将来放广告代码</div>
      </section>

      <section class="releases">
        ${releases.map(renderRelease).join("")}
      </section>
    </main>
  </body>
</html>
  `.trim();

  await writeFile(path.join(PUBLIC_DIR, "index.html"), html);
  await writeFile(path.join(PUBLIC_DIR, "style.css"), STYLE_CSS);
  await writeFile(
    path.join(DATA_DIR, "releases.json"),
    JSON.stringify(releases, null, 2)
  );
  await writeFile(path.join(PUBLIC_DIR, "robots.txt"), buildRobots());
  await writeFile(path.join(PUBLIC_DIR, "sitemap.xml"), buildSitemap());
  await writeFile(path.join(PUBLIC_DIR, "ads.txt"), buildAdsTxt());
}

function buildRobots() {
  return `
User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml
  `.trim();
}

function buildSitemap() {
  return `
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
  `.trim();
}

function buildAdsTxt() {
  return `
# 将来接入 Google AdSense 后，在此填入 ads.txt 记录
# 示例：
# google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0
  `.trim();
}

const STYLE_CSS = `
:root {
  color-scheme: light;
  --bg-1: #f7f4ef;
  --bg-2: #efe6db;
  --ink: #1f1a14;
  --muted: #60584f;
  --accent: #c76f2b;
  --card: rgba(255, 255, 255, 0.85);
  --shadow: 0 10px 30px rgba(31, 26, 20, 0.12);
  --radius: 20px;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: "Noto Serif SC", "Source Han Serif SC", "STSong", "Songti SC",
    serif;
  color: var(--ink);
  background: linear-gradient(120deg, var(--bg-1), var(--bg-2));
  min-height: 100vh;
}

.bg {
  position: fixed;
  inset: 0;
  background-image: radial-gradient(
      rgba(199, 111, 43, 0.12) 1px,
      transparent 1px
    ),
    radial-gradient(rgba(0, 0, 0, 0.04) 1px, transparent 1px);
  background-size: 32px 32px, 64px 64px;
  opacity: 0.8;
  pointer-events: none;
  z-index: 0;
}

main {
  position: relative;
  z-index: 1;
  max-width: 980px;
  margin: 0 auto;
  padding: 48px 24px 80px;
}

.hero {
  background: var(--card);
  border-radius: var(--radius);
  padding: 32px;
  box-shadow: var(--shadow);
  animation: fadeUp 0.8s ease forwards;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: rgba(199, 111, 43, 0.12);
  color: var(--accent);
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
}

h1 {
  margin: 16px 0 12px;
  font-size: clamp(28px, 4vw, 40px);
}

p {
  margin: 0 0 12px;
  color: var(--muted);
  line-height: 1.7;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  font-size: 12px;
  color: var(--muted);
}

.ad {
  margin: 24px 0;
  padding: 20px;
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.7);
  border: 1px dashed rgba(199, 111, 43, 0.4);
  text-align: center;
}

.ad-title {
  font-size: 12px;
  color: var(--accent);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.ad-box {
  font-size: 14px;
  color: var(--muted);
}

.releases {
  display: grid;
  gap: 24px;
}

.release {
  background: var(--card);
  border-radius: var(--radius);
  padding: 24px;
  box-shadow: var(--shadow);
  animation: fadeUp 0.7s ease forwards;
}

.release:nth-child(2) {
  animation-delay: 0.1s;
}

.release:nth-child(3) {
  animation-delay: 0.2s;
}

.release:nth-child(4) {
  animation-delay: 0.3s;
}

.release-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  border-bottom: 1px solid rgba(96, 88, 79, 0.2);
  padding-bottom: 12px;
  margin-bottom: 16px;
}

.release-header h3 {
  margin: 0 0 6px;
  font-size: 22px;
}

.meta {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}

.source {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
  border: 1px solid rgba(199, 111, 43, 0.4);
  padding: 6px 12px;
  border-radius: 999px;
}

.section h4 {
  margin: 16px 0 8px;
  font-size: 16px;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 12px;
}

.item,
.note {
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(96, 88, 79, 0.1);
}

.raw {
  font-size: 13px;
  color: var(--ink);
  margin-bottom: 6px;
}

.plain {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(96, 88, 79, 0.2);
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}

.plain-title {
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}

.plain-text {
  margin-bottom: 6px;
}

.plain-meta {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}

.steps {
  list-style: decimal;
  padding-left: 20px;
  margin: 6px 0 6px;
  color: var(--muted);
}

.steps li {
  margin-bottom: 4px;
}

.empty {
  color: var(--muted);
  font-size: 13px;
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 720px) {
  .release-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
`.trim();

buildSite().catch((error) => {
  console.error(error);
  process.exit(1);
});
