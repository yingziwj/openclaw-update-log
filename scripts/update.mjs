import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const DEFAULT_OFFLINE_PATH = path.join(__dirname, "offline-releases.json");

const SITE_URL =
  process.env.SITE_URL || "https://openclaw-update-log.pages.dev";
const REPO = "openclaw/openclaw";
const PER_PAGE = 100;

const HEADERS = {
  "User-Agent": "openclaw-update-log-generator",
  Accept: "application/vnd.github+json",
};

if (process.env.GITHUB_TOKEN) {
  HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

const MODULE_RULES = [
  [/table|list items?|quick actions?/i, "列表与表格操作", "经常点列表和看表格的人"],
  [/android|mobile/i, "Android app", "手机端用户"],
  [/chat settings?|chat/i, "聊天设置", "正在调整聊天设置的用户"],
  [/settings?/i, "设置页面", "经常改设置的人"],
  [/workflow|automation/i, "工作流与自动化", "配置流程和自动化的人"],
  [/api/i, "接口与后台", "开发者或管理员"],
  [/slack/i, "Slack 集成", "接 Slack 的团队"],
  [/google oauth/i, "Google 登录与授权", "管理员"],
  [/webhook/i, "Webhook 通知", "做系统对接的人"],
  [/data source/i, "数据源", "接数据源的人"],
  [/module/i, "模块列表", "经常找模块的人"],
  [/search|filter/i, "搜索与筛选", "需要快速找内容的人"],
  [/pagination/i, "翻页机制", "数据量大的用户"],
  [/boto3|dependabot/i, "底层依赖", "普通用户基本无感"],
  [/sqlite|database/i, "数据库设置", "需要本地数据库配置的人"],
  [/voice/i, "语音能力", "使用语音功能的人"],
  [/connection/i, "连接配置", "管理连接的人"],
];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(0, 10);
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 10)} ${date
    .toISOString()
    .slice(11, 16)} UTC`;
}

function normalizeText(text) {
  return (text || "")
    .replace(/\([^)]*#\d+[^)]*\)/g, " ")
    .replace(/\(Thanks\s+@[\w-]+\)\.?/gi, " ")
    .replace(/\bThanks\s+@[\w-]+\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitMeaningPoints(text) {
  const placeholders = [];
  const protectedText = text.replace(/`[^`]+`/g, (match) => {
    const token = `__TOKEN_${placeholders.length}__`;
    placeholders.push(match);
    return token;
  });

  const parts = protectedText
    .split(/\s*;\s*|\s*,\s+(?=(?:add|fix|show|make|allow|load|update|switch|stop|ensure|read)\b)/i)
    .flatMap((chunk) => chunk.split(/\s+to\s+(?=(?:allow|show|organize|explain|use|display|select|mention)\b)/i))
    .map((part) =>
      part.replace(/__TOKEN_(\d+)__/g, (_, index) => placeholders[Number(index)])
    )
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length ? parts.slice(0, 3) : [text.trim()];
}

function parseMarkdown(body) {
  const lines = (body || "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  let current = { title: "更新内容", items: [] };

  const pushCurrent = () => {
    if (current.items.length) sections.push(current);
  };

  for (const line of lines) {
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    if (heading) {
      pushCurrent();
      current = { title: heading[1].trim(), items: [] };
      continue;
    }

    const item = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (item) {
      current.items.push(item[2].trim());
      continue;
    }

    if (line.trim()) {
      current.items.push(line.trim());
    }
  }

  pushCurrent();
  return sections;
}

function detectActionKind(text, sectionTitle) {
  const source = `${sectionTitle} ${text}`;
  if (/fix|error|issue|bug|broken|missing/i.test(source)) return "fix";
  if (/bump|upgrade|update/i.test(text)) return "upgrade";
  if (/add|support|show|load|read/i.test(text)) return "add";
  if (/make|allow|switch|reorganize|group|organize|collapsible/i.test(text)) {
    return "improve";
  }
  if (/stop|prevent|ensure/i.test(text)) return "protect";
  return "change";
}

function detectModule(text) {
  for (const [pattern, label, audience] of MODULE_RULES) {
    if (pattern.test(text)) return { label, audience };
  }
  return { label: "通用功能", audience: "大多数用户" };
}

function classifyRisk(kind, moduleLabel) {
  if (kind === "fix") return "稳";
  if (kind === "upgrade" && /底层依赖/.test(moduleLabel)) return "低感知";
  if (kind === "protect") return "管控";
  return "优化";
}

function buildHeadline(kind, moduleLabel) {
  switch (kind) {
    case "fix":
      return `这条是在修 ${moduleLabel} 里的老毛病。`;
    case "upgrade":
      return `这条是在升级 ${moduleLabel} 用到的底层东西。`;
    case "protect":
      return `这条是在给 ${moduleLabel} 加限制和保护。`;
    case "improve":
      return `这条是在把 ${moduleLabel} 做得更顺手。`;
    case "add":
      return `这条是在给 ${moduleLabel} 添新能力。`;
    default:
      return `这条是在调整 ${moduleLabel}。`;
  }
}

function buildPlainSummary(text, kind, moduleLabel) {
  const clean = normalizeText(text);

  if (/bump\s+`?([\w.-]+)`?\s+from\s+([\w.-]+)\s+to\s+([\w.-]+)/i.test(clean)) {
    const match = clean.match(
      /bump\s+`?([\w.-]+)`?\s+from\s+([\w.-]+)\s+to\s+([\w.-]+)/i
    );
    return `把 ${match[1]} 从 ${match[2]} 升到 ${match[3]}。这类更新通常是在补稳定性、安全性或兼容性。`;
  }

  if (kind === "fix") {
    return `${moduleLabel} 之前这里有问题，现在官方把它修好了，出错概率会更低。`;
  }

  if (kind === "protect") {
    return `官方在 ${moduleLabel} 这里加了一道规矩，目的是别让不该发生的访问或操作继续发生。`;
  }

  if (kind === "add") {
    return `官方给 ${moduleLabel} 增了新入口、新说明或新能力，让原来做不到的事现在可以做，或者更容易做。`;
  }

  if (kind === "improve") {
    return `这不是全新功能，而是把 ${moduleLabel} 的使用过程重新整理了一下，用起来会更顺。`;
  }

  return `这是一次 ${moduleLabel} 相关调整，重点是让现有流程更清楚或更稳定。`;
}

function buildImpact(text, moduleLabel, audience, kind) {
  if (/android|mobile/i.test(text)) {
    return "主要影响手机端，尤其是 Android 用户。";
  }
  if (/api|backend|oauth|webhook/i.test(text)) {
    return "普通访客基本无感，主要影响做配置、接系统、管后台的人。";
  }
  if (kind === "upgrade") {
    return "表面上不一定看得出来，但底层会更稳一些。";
  }
  return `最容易感受到变化的是${audience}。`;
}

function buildBenefit(text, kind, moduleLabel) {
  if (/search|filter|pagination/i.test(text)) {
    return "直接好处是找东西更快、翻页更稳，不容易卡住。";
  }
  if (/settings|group|section|layout|collapsible/i.test(text)) {
    return "直接好处是页面更好找，设置不会挤成一团。";
  }
  if (/webhook|oauth|connection|access/i.test(text)) {
    return "直接好处是对接过程更清楚，也更不容易误配。";
  }
  if (kind === "fix") {
    return `直接好处是 ${moduleLabel} 少报错、少出意外。`;
  }
  if (kind === "upgrade") {
    return "直接好处通常是兼容性和稳定性更好。";
  }
  return `直接好处是 ${moduleLabel} 更顺手，也更省心。`;
}

function buildAction(kind, moduleLabel, audience) {
  if (kind === "upgrade") {
    return "你通常不用手动处理，这类改动属于底层维护。";
  }
  if (/管理员|开发者|接/.test(audience)) {
    return `如果你负责 ${moduleLabel} 配置，更新后最好顺手检查一下相关页面或接口。`;
  }
  return "大多数人不用做额外操作，更新后直接生效。";
}

function buildFarmerVersion(item, sectionTitle) {
  const clean = normalizeText(item);
  const kind = detectActionKind(clean, sectionTitle);
  const moduleInfo = detectModule(clean);
  const points = splitMeaningPoints(clean).map((part) =>
    part.replace(/^`|`$/g, "")
  );

  return {
    raw: item.trim(),
    clean,
    kind,
    moduleLabel: moduleInfo.label,
    audience: moduleInfo.audience,
    statusLabel: classifyRisk(kind, moduleInfo.label),
    headline: buildHeadline(kind, moduleInfo.label),
    summary: buildPlainSummary(clean, kind, moduleInfo.label),
    points,
    impact: buildImpact(clean, moduleInfo.label, moduleInfo.audience, kind),
    benefit: buildBenefit(clean, kind, moduleInfo.label),
    action: buildAction(kind, moduleInfo.label, moduleInfo.audience),
  };
}

function summarizeRelease(release, parsedSections) {
  const items = parsedSections.flatMap((section) =>
    section.items.map((item) => buildFarmerVersion(item, section.title))
  );

  const stats = {
    total: items.length,
    fixes: items.filter((item) => item.kind === "fix").length,
    adds: items.filter((item) => item.kind === "add").length,
    upgrades: items.filter((item) => item.kind === "upgrade").length,
    protects: items.filter((item) => item.kind === "protect").length,
  };

  const moduleCount = new Map();
  for (const item of items) {
    moduleCount.set(item.moduleLabel, (moduleCount.get(item.moduleLabel) || 0) + 1);
  }
  const topModules = [...moduleCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label]) => label);

  const summaryLines = [
    `这版一共动了 ${stats.total} 处，重点不在“炫新功能”，而是在把现有流程理顺。`,
    topModules.length
      ? `这次改动最集中的地方是：${topModules.join("、")}。`
      : "这次改动比较分散，没有只盯着一个地方改。",
    stats.fixes
      ? `里面有 ${stats.fixes} 条明确是修问题，说明官方这次也在补稳定性。`
      : "这次没有明显的大修 bug，更多是体验和结构调整。",
  ];

  return { items, stats, topModules, summaryLines };
}

function renderQuickStats(summary) {
  return `
    <div class="quick-stats">
      <div class="quick-stat">
        <span class="quick-stat-label">总改动</span>
        <strong>${summary.stats.total}</strong>
      </div>
      <div class="quick-stat">
        <span class="quick-stat-label">修复</span>
        <strong>${summary.stats.fixes}</strong>
      </div>
      <div class="quick-stat">
        <span class="quick-stat-label">新增/补充</span>
        <strong>${summary.stats.adds}</strong>
      </div>
      <div class="quick-stat">
        <span class="quick-stat-label">依赖升级</span>
        <strong>${summary.stats.upgrades}</strong>
      </div>
    </div>
  `;
}

function renderInsightList(summary) {
  return `
    <section class="insight-panel">
      <div class="section-kicker">快速看完这版</div>
      <p class="insight-brief">${escapeHtml(summary.summaryLines.join(" "))}</p>
    </section>
  `;
}

function renderTimelineItem(item) {
  return `
    <article class="story-card">
      <div class="story-top">
        <span class="status-pill status-${escapeHtml(item.kind)}">${escapeHtml(
          item.statusLabel
        )}</span>
        <span class="module-pill">${escapeHtml(item.moduleLabel)}</span>
      </div>
      <h4>${escapeHtml(item.headline)}</h4>
      <p class="story-summary">${escapeHtml(item.summary)}</p>
      <div class="story-facts">
        <div class="story-fact">
          <span class="story-fact-label">原文</span>
          <p>${escapeHtml(item.clean)}</p>
        </div>
        <div class="story-fact">
          <span class="story-fact-label">影响</span>
          <p>${escapeHtml(item.impact)} ${escapeHtml(item.benefit)}</p>
        </div>
        <div class="story-fact">
          <span class="story-fact-label">要不要管</span>
          <p>${escapeHtml(item.action)}</p>
        </div>
      </div>
    </article>
  `;
}

function renderSection(section) {
  const renderedItems = section.items
    .map((item) => renderTimelineItem(buildFarmerVersion(item, section.title)))
    .join("");

  return `
    <section class="release-section">
      <div class="section-head">
        <div>
          <div class="section-kicker">官方分组</div>
          <h3>${escapeHtml(section.title)}</h3>
        </div>
      </div>
      <div class="story-listing">
        ${renderedItems}
      </div>
    </section>
  `;
}

function renderRelease(release) {
  const parsedSections = parseMarkdown(release.body || "");
  const summary = summarizeRelease(release, parsedSections);

  return `
    <article class="release-shell" id="${escapeHtml(release.tag_name)}">
      <header class="release-hero">
        <div class="release-main">
          <div class="eyebrow">版本快报</div>
          <h2>${escapeHtml(release.name || release.tag_name)}</h2>
          <p class="release-intro">
            这是把官方英文更新日志翻成人话后的版本。重点不是逐词翻译，而是告诉你：
            这次到底改了什么、谁会受影响、你需不需要管。
          </p>
          <div class="release-meta">
            <span>发布时间：${escapeHtml(formatDate(release.published_at))}</span>
            <span>原始标签：${escapeHtml(release.tag_name)}</span>
            ${release.prerelease ? "<span>预览版</span>" : "<span>正式版</span>"}
          </div>
        </div>
        <aside class="release-side">
          ${renderQuickStats(summary)}
          <a class="source-link" href="${escapeHtml(
            release.html_url
          )}" target="_blank" rel="noopener">查看 GitHub 原文</a>
        </aside>
      </header>
      ${renderInsightList(summary)}
      <div class="section-stack">
        ${parsedSections.map(renderSection).join("")}
      </div>
    </article>
  `;
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
    if (!linkHeader || !linkHeader.includes('rel="next"')) break;
    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = match ? match[1] : "";
  }

  return releases.filter((release) => !release.draft);
}

async function loadOfflineReleases() {
  const offlinePath = process.env.OFFLINE_RELEASES_PATH || DEFAULT_OFFLINE_PATH;
  try {
    return JSON.parse(await fs.readFile(offlinePath, "utf-8"));
  } catch {
    return null;
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function buildRobots() {
  return `User-agent: *
Allow: /
Sitemap: ${SITE_URL}/sitemap.xml`;
}

function buildSitemap() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
}

function buildAdsTxt() {
  return `# Google AdSense 开通后在这里填写正式 ads.txt
# 示例：
# google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`;
}

function buildHtml(releases) {
  const newest = releases[0];

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw 更新解读站 | 不是翻译，是讲人话</title>
    <meta name="description" content="把 OpenClaw 官方版本日志拆成普通人能看懂的中文解读：这次改了什么，谁会受影响，要不要你动手。" />
    <meta name="keywords" content="OpenClaw, 更新日志, 中文解读, Release Notes, Cloudflare Pages, SEO" />
    <link rel="canonical" href="${escapeHtml(SITE_URL)}" />
    <meta property="og:title" content="OpenClaw 更新解读站" />
    <meta property="og:description" content="不是逐词翻译，而是把 OpenClaw 更新讲成人话。" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(SITE_URL)}" />
    <meta property="og:locale" content="zh_CN" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/style.css" />
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "OpenClaw 更新解读站",
        url: SITE_URL,
        description:
          "把 OpenClaw 官方版本日志拆成普通人能看懂的中文解读：这次改了什么，谁会受影响，要不要你动手。",
        inLanguage: "zh-CN",
      })}
    </script>
  </head>
  <body>
    <div class="page-noise"></div>
    <main class="page">
      <section class="masthead">
        <div class="masthead-copy">
          <div class="brand">OpenClaw Update Log</div>
          <h1>OpenClaw 更新解读站</h1>
          <p class="lead">
            这里不做生硬翻译，只回答四件事：这次到底改了什么、谁会受影响、
            你能得到什么好处、你到底要不要动手。
          </p>
        </div>
        <div class="masthead-panel">
          <div class="panel-kicker">当前站点状态</div>
          <div class="panel-line">
            <span>最新版本</span>
            <strong>${escapeHtml(newest ? newest.tag_name : "暂无")}</strong>
          </div>
          <div class="panel-line">
            <span>最近生成</span>
            <strong>${escapeHtml(formatDateTime(new Date().toISOString()))}</strong>
          </div>
          <div class="panel-line">
            <span>数据来源</span>
            <strong>GitHub Releases</strong>
          </div>
        </div>
      </section>

      <section class="ad-banner">
        <div>
          <div class="section-kicker">广告位预留</div>
          <h2>Google AdSense 以后可以直接接进来</h2>
        </div>
        <p>现在先留出结构位置，后面只要补广告脚本和正式 ads.txt 就能接入。</p>
      </section>

      <section class="release-stack">
        ${releases.map(renderRelease).join("")}
      </section>
    </main>
  </body>
</html>`;
}

const STYLE_CSS = `
:root {
  --bg: #f3efe5;
  --paper: rgba(255, 250, 242, 0.86);
  --paper-strong: #fffaf2;
  --line: rgba(49, 39, 28, 0.12);
  --ink: #1b140e;
  --muted: #625549;
  --accent: #b85c2d;
  --accent-strong: #8d3c14;
  --olive: #646b3b;
  --shadow: 0 18px 48px rgba(45, 28, 17, 0.12);
  --radius-lg: 28px;
  --radius-md: 20px;
  --radius-sm: 14px;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  color: var(--ink);
  font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", serif;
  background:
    radial-gradient(circle at top left, rgba(184, 92, 45, 0.12), transparent 28%),
    radial-gradient(circle at right 20%, rgba(100, 107, 59, 0.12), transparent 22%),
    linear-gradient(180deg, #f6f1e7 0%, #efe7da 100%);
  min-height: 100vh;
  font-size: 17px;
  line-height: 1.7;
}

.page-noise {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(rgba(27, 20, 14, 0.04) 1px, transparent 1px),
    linear-gradient(rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.18));
  background-size: 26px 26px, 100% 100%;
  opacity: 0.55;
}

.page {
  position: relative;
  z-index: 1;
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 40px 0 96px;
}

.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.8fr);
  gap: 28px;
  align-items: stretch;
}

.masthead-copy,
.masthead-panel,
.ad-banner,
.release-hero,
.insight-panel,
.release-section {
  background: var(--paper);
  backdrop-filter: blur(10px);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
}

.masthead-copy {
  border-radius: 34px;
  padding: 36px;
  animation: rise 0.7s ease;
}

.brand,
.section-kicker,
.eyebrow,
.panel-kicker {
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 12px;
  color: var(--accent-strong);
}

.masthead-copy h1 {
  margin: 14px 0 12px;
  font-size: clamp(38px, 6vw, 68px);
  line-height: 1.02;
  letter-spacing: -0.03em;
}

.lead {
  max-width: 44rem;
  font-size: 19px;
  color: var(--muted);
}
.release-meta span,
.module-pill,
.status-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1;
}

.masthead-panel {
  border-radius: 28px;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  animation: rise 0.85s ease;
}

.panel-line {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: baseline;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}

.panel-line span {
  color: var(--muted);
  font-size: 14px;
}

.panel-line strong {
  font-size: 16px;
  text-align: right;
}

.ad-banner p,
.release-intro,
.story-summary,
.story-fact p,
.insight-brief {
  margin: 0;
  color: var(--muted);
}

.ad-banner {
  margin-top: 24px;
  border-radius: 28px;
  padding: 24px 28px;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: center;
}

.ad-banner h2 {
  margin: 4px 0 0;
  font-size: clamp(24px, 3vw, 34px);
}

.release-stack {
  display: grid;
  gap: 30px;
  margin-top: 30px;
}

.release-shell {
  display: grid;
  gap: 18px;
}

.release-hero {
  border-radius: 34px;
  padding: 30px;
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(250px, 0.7fr);
  gap: 24px;
}

.release-main h2 {
  margin: 10px 0 12px;
  font-size: clamp(30px, 4vw, 48px);
  line-height: 1.08;
}

.release-intro {
  font-size: 18px;
  max-width: 42rem;
}

.release-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 18px;
}

.release-meta span,
.module-pill {
  background: rgba(100, 107, 59, 0.08);
  border: 1px solid rgba(100, 107, 59, 0.14);
}

.quick-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.quick-stat {
  border-radius: 18px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.58);
  border: 1px solid var(--line);
}

.quick-stat-label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 6px;
}

.quick-stat strong {
  font-size: 28px;
  line-height: 1;
}

.release-side {
  display: grid;
  gap: 14px;
  align-content: start;
}

.source-link {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  min-height: 48px;
  padding: 0 18px;
  border-radius: 999px;
  text-decoration: none;
  color: #fffaf5;
  background: linear-gradient(135deg, var(--accent), var(--accent-strong));
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
  font-size: 14px;
}

.insight-panel {
  border-radius: 28px;
  padding: 24px;
}

.insight-brief {
  margin-top: 10px;
  font-size: 18px;
}

.section-stack {
  display: grid;
  gap: 18px;
}

.release-section {
  border-radius: 28px;
  padding: 24px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 16px;
  margin-bottom: 18px;
}

.section-head h3 {
  margin: 6px 0 0;
  font-size: 28px;
}

.story-listing {
  display: grid;
  gap: 16px;
}

.story-card {
  background: var(--paper-strong);
  border: 1px solid var(--line);
  border-radius: 22px;
  padding: 22px;
  display: grid;
  gap: 14px;
  transition: transform 0.25s ease, box-shadow 0.25s ease;
}

.story-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 36px rgba(45, 28, 17, 0.1);
}

.story-top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.status-pill {
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
  border: 1px solid transparent;
}

.status-add,
.status-improve,
.status-change {
  background: rgba(184, 92, 45, 0.1);
  border-color: rgba(184, 92, 45, 0.14);
}

.status-fix {
  background: rgba(100, 107, 59, 0.12);
  border-color: rgba(100, 107, 59, 0.16);
}

.status-upgrade {
  background: rgba(52, 91, 122, 0.1);
  border-color: rgba(52, 91, 122, 0.15);
}

.status-protect {
  background: rgba(122, 61, 52, 0.1);
  border-color: rgba(122, 61, 52, 0.15);
}

.story-card h4 {
  margin: 0;
  font-size: 27px;
  line-height: 1.25;
}

.story-summary {
  font-size: 18px;
}

.story-facts {
  display: grid;
  gap: 10px;
}

.story-fact {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(243, 239, 229, 0.7);
  border: 1px solid rgba(49, 39, 28, 0.08);
}

.story-fact-label {
  font-family: "Noto Sans SC", "Source Han Sans SC", "PingFang SC", sans-serif;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent-strong);
  padding-top: 2px;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 980px) {
  .masthead,
  .release-hero {
    grid-template-columns: 1fr;
  }

  .ad-banner {
    flex-direction: column;
    align-items: flex-start;
  }
}

@media (max-width: 720px) {
  body {
    font-size: 16px;
  }

  .page {
    width: min(100% - 20px, 1180px);
    padding-top: 20px;
  }

  .masthead-copy,
  .masthead-panel,
  .release-hero,
  .insight-panel,
  .release-section,
  .ad-banner {
    padding: 20px;
    border-radius: 22px;
  }

  .masthead-copy h1 {
    font-size: 34px;
  }

  .release-main h2 {
    font-size: 28px;
  }

  .story-card h4 {
    font-size: 22px;
  }

  .story-fact {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .quick-stats {
    grid-template-columns: 1fr 1fr;
  }
}
`.trim();

async function buildSite() {
  let releases = [];
  try {
    releases = await fetchAllReleases();
  } catch (error) {
    const offline = await loadOfflineReleases();
    if (!offline) throw error;
    console.warn(
      "GitHub API unavailable. Using offline releases data for local preview."
    );
    releases = offline;
  }

  const html = buildHtml(releases);

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

buildSite().catch((error) => {
  console.error(error);
  process.exit(1);
});
