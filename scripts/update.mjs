import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const DEFAULT_OFFLINE_RELEASES_PATH = path.join(__dirname, "offline-releases.json");
const DEFAULT_OFFLINE_CONTEXT_PATH = path.join(__dirname, "offline-context.json");

const SITE_URL =
  process.env.SITE_URL || "https://openclaw-update-log.pages.dev";
const REPO = "openclaw/openclaw";
const PER_PAGE = 100;
const RELEASE_LIMIT = Number(process.env.RELEASE_LIMIT || 1);
const CONTEXT_RELEASE_LIMIT = Number(process.env.CONTEXT_RELEASE_LIMIT || 1);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 12000);
const CONTEXT_CONCURRENCY = Number(process.env.CONTEXT_CONCURRENCY || 6);

const HEADERS = {
  "User-Agent": "openclaw-update-log-generator",
  Accept: "application/vnd.github+json",
};
const HTML_HEADERS = {
  "User-Agent": "openclaw-update-log-generator",
  Accept: "text/html,application/xhtml+xml",
};

if (process.env.GITHUB_TOKEN) {
  HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

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
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

function normalizeText(text) {
  return (text || "")
    .replace(/\(Thanks\s+@[\w-]+\)\.?/gi, " ")
    .replace(/\bThanks\s+@[\w-]+\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanBody(text) {
  return (text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max = 220) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
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

    if (line.trim()) current.items.push(line.trim());
  }

  pushCurrent();
  return sections;
}

function detectKind(text, sectionTitle) {
  const source = `${sectionTitle} ${text}`;
  if (/fix|bug|issue|error|missing|broken/i.test(source)) return "fix";
  if (/bump|upgrade|dependabot/i.test(source)) return "upgrade";
  if (/add|support|show|load|allow|read/i.test(source)) return "feature";
  if (/update|make|switch|reorganize|improve|organize|group|collapsible/i.test(source)) {
    return "improve";
  }
  return "change";
}

function detectArea(text) {
  const rules = [
    [/android|mobile/i, "Android 端"],
    [/chat settings?|chat/i, "聊天设置"],
    [/workflow|automation/i, "工作流"],
    [/api|backend/i, "接口和后台"],
    [/webhook/i, "Webhook"],
    [/search|filter/i, "搜索和筛选"],
    [/pagination/i, "翻页"],
    [/slack/i, "Slack"],
    [/oauth|google/i, "Google 授权"],
    [/database|sqlite/i, "数据库设置"],
    [/module/i, "模块列表"],
    [/connection/i, "连接配置"],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(text)) return label;
  }
  return "通用功能";
}

function shouldFetchContext(item, sectionTitle) {
  const text = normalizeText(item);
  const kind = detectKind(text, sectionTitle);
  if (kind === "upgrade") return false;
  if (/^(docs?|test|tests|refactor|chore|ci|build):/i.test(text)) return false;
  return kind === "fix";
}

function extractRefNumber(item) {
  const urlMatch = item.match(/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/(\d+)/i);
  if (urlMatch) return Number(urlMatch[1]);

  const tailMatch = item.match(/\(#(\d+)\)\s*$/);
  if (tailMatch) return Number(tailMatch[1]);

  const hashMatch = item.match(/(?:^|\s)#(\d+)(?:\s|$)/);
  return hashMatch ? Number(hashMatch[1]) : null;
}

function removeTrailingRefs(text) {
  return text
    .replace(/\s+by\s+@[\w-]+\s+in\s+https:\/\/github\.com\/[^\s]+$/i, "")
    .replace(/\s*\(#\d+\)\s*$/i, "")
    .trim();
}

function extractLinkedIssueNumbers(text) {
  const refs = new Set();
  const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  let match = pattern.exec(text || "");
  while (match) {
    refs.add(Number(match[1]));
    match = pattern.exec(text || "");
  }
  return [...refs];
}

function buildFallbackSummary(item, kind, area) {
  const clean = removeTrailingRefs(normalizeText(item));

  if (kind === "upgrade") {
    const versionMatch = clean.match(
      /bump\s+`?([\w.-]+)`?\s+from\s+([\w.-]+)\s+to\s+([\w.-]+)/i
    );
    if (versionMatch) {
      return `把 ${versionMatch[1]} 从 ${versionMatch[2]} 升到 ${versionMatch[3]}。这类改动一般是补稳定性或兼容性，普通用户通常不用操作。`;
    }
  }

  if (kind === "fix") {
    return `${area} 之前这里有个问题，这次官方已经补上，重点是让它少出错、更稳定。`;
  }

  if (kind === "feature") {
    return `这条是在 ${area} 增加入口、说明或能力，目的就是让原来难做的事情更容易完成。`;
  }

  if (kind === "improve") {
    return `这条不是大改版，而是把 ${area} 的用法理顺，减少绕路和找不到入口的情况。`;
  }

  return `这是一次 ${area} 相关调整，核心是让现有流程更清楚。`;
}

function buildContextSummary(item, kind, area, context) {
  if (!context) return buildFallbackSummary(item, kind, area);

  const title = cleanBody(context.title || "");
  const body = truncate(cleanBody(context.body || ""), 240);
  const issueTitle = cleanBody(context.linkedIssueTitle || "");
  const issueBody = truncate(cleanBody(context.linkedIssueBody || ""), 180);

  if (kind === "fix" && issueTitle) {
    return `原来 ${area} 这里有人反馈“${issueTitle}”。这次对应的修复说明是“${title || normalizeText(item)}”，也就是把那个具体问题补上，避免用户继续踩坑。`;
  }

  if (kind === "fix") {
    return `这条修复背后的上下文是“${title || normalizeText(item)}”。结合描述看，官方是在处理 ${area} 的一个实际故障点，目标是让这块更稳。`;
  }

  if (kind === "feature" && title) {
    return `这条新增不是凭空冒出来的，结合提交上下文“${title}”来看，官方是在给 ${area} 补一个更完整的使用路径。`;
  }

  if (kind === "improve" && body) {
    return `这条优化结合上下文看，重点不是炫技，而是把 ${area} 的流程重新梳顺。原始说明里提到：${body}`;
  }

  return buildFallbackSummary(item, kind, area);
}

function buildWhyItMatters(kind, area, context) {
  if (context?.linkedIssueTitle) {
    return `因为已经有人在真实使用里遇到这个问题，所以这次不是“顺手优化”，而是在补真实痛点。`;
  }
  if (kind === "feature") {
    return `${area} 的路径会更完整，用户少猜一步。`;
  }
  if (kind === "fix") {
    return `${area} 更稳，少报错，少出现“明明设置了却不生效”的情况。`;
  }
  if (kind === "upgrade") {
    return `表面上不明显，但底层兼容性和稳定性通常会更好。`;
  }
  return `${area} 会更顺手，理解成本会更低。`;
}

function buildDoNext(kind, area, context) {
  if (kind === "upgrade") return "通常不用你手动处理。";
  if (/接口|后台|Webhook|Google 授权/.test(area)) {
    return `如果你管 ${area} 配置，更新后最好顺手检查一遍相关页面或对接流程。`;
  }
  if (context?.linkedIssueTitle) {
    return "如果你之前正好遇到过这个问题，可以优先验证这次更新是否已经解决。";
  }
  return "大多数用户不用额外操作，更新后直接生效。";
}

function buildEntry(item, sectionTitle, contextMap) {
  const refNumber = extractRefNumber(item);
  const text = removeTrailingRefs(normalizeText(item));
  const kind = detectKind(text, sectionTitle);
  const area = detectArea(text);
  const context = refNumber ? contextMap.get(refNumber) : null;

  return {
    refNumber,
    raw: item,
    text,
    area,
    kind,
    summary: buildContextSummary(text, kind, area, context),
    whyItMatters: buildWhyItMatters(kind, area, context),
    doNext: buildDoNext(kind, area, context),
    contextTitle: context?.title || "",
    linkedIssueTitle: context?.linkedIssueTitle || "",
    contextUrl: context?.url || "",
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: HTML_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function fetchAllReleases() {
  let url = `https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=1`;
  const releases = [];

  while (url) {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      const text = await response.text();
      const error = new Error(
        `GitHub API 请求失败 (${response.status}): ${text.slice(0, 200)}`
      );
      error.status = response.status;
      throw error;
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

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  return decodeHtmlEntities(
    String(text)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

async function fetchReleasesViaHtml() {
  const html = await fetchText(`https://github.com/${REPO}/releases`);
  const chunks = [...html.matchAll(/<section[^>]*>[\s\S]*?<\/section>/gi)];
  const releases = [];

  for (const chunkMatch of chunks) {
    const chunk = chunkMatch[0];
    const hrefMatch = chunk.match(/href="\/openclaw\/openclaw\/releases\/tag\/([^"#?]+)"/i);
    if (!hrefMatch) continue;

    const tagName = decodeURIComponent(hrefMatch[1]);
    const titleMatch = chunk.match(/<a[^>]*href="\/openclaw\/openclaw\/releases\/tag\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i);
    const timeMatch = chunk.match(/<relative-time[^>]*datetime="([^"]+)"/i);
    const bodyMatch = chunk.match(/<div[^>]*data-pjax="#repo-content-pjax-container"[\s\S]*?<div[^>]*class="markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || chunk.match(/<div[^>]*class="markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    releases.push({
      html_url: `https://github.com/${REPO}/releases/tag/${tagName}`,
      tag_name: tagName,
      name: stripHtml(titleMatch ? titleMatch[1] : tagName),
      published_at: timeMatch ? timeMatch[1] : new Date().toISOString(),
      prerelease: /pre-release|beta|alpha/i.test(chunk),
      draft: false,
      body: stripHtml(bodyMatch ? bodyMatch[1] : ""),
    });
  }

  return releases;
}

async function fetchLatestReleaseViaHtml() {
  const html = await fetchText(`https://github.com/${REPO}/releases/latest`);
  const canonicalMatch = html.match(
    /<link[^>]+rel="canonical"[^>]+href="https:\/\/github\.com\/openclaw\/openclaw\/releases\/tag\/([^"]+)"/i
  );
  const tagName = canonicalMatch ? decodeURIComponent(canonicalMatch[1]) : "latest";
  const titleMatch =
    html.match(/<meta property="og:title" content="([^"]+)"/i) ||
    html.match(/<title>([^<]+)<\/title>/i);
  const bodyMatch =
    html.match(/<div[^>]*class="markdown-body[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [];
  const timeMatch = html.match(/<relative-time[^>]*datetime="([^"]+)"/i);

  return [
    {
      html_url: `https://github.com/${REPO}/releases/tag/${tagName}`,
      tag_name: tagName,
      name: stripHtml(titleMatch ? titleMatch[1] : tagName).replace(/\s*·\s*GitHub.*$/i, ""),
      published_at: timeMatch ? timeMatch[1] : new Date().toISOString(),
      prerelease: /pre-release|beta|alpha/i.test(html),
      draft: false,
      body: stripHtml(bodyMatch[1] || ""),
    },
  ];
}

async function loadJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function loadOfflineReleases() {
  return loadJsonFile(process.env.OFFLINE_RELEASES_PATH || DEFAULT_OFFLINE_RELEASES_PATH);
}

async function loadOfflineContext() {
  const raw = await loadJsonFile(
    process.env.OFFLINE_CONTEXT_PATH || DEFAULT_OFFLINE_CONTEXT_PATH
  );
  if (!raw) return new Map();
  return new Map(Object.entries(raw).map(([key, value]) => [Number(key), value]));
}

async function fetchContextForNumber(number, cache) {
  if (cache.has(number)) return cache.get(number);

  let item = null;

  try {
    const pr = await fetchJson(`https://api.github.com/repos/${REPO}/pulls/${number}`);
    item = {
      type: "pull",
      number,
      title: pr.title || "",
      body: pr.body || "",
      url: pr.html_url || "",
    };
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (!item) {
    try {
      const issue = await fetchJson(`https://api.github.com/repos/${REPO}/issues/${number}`);
      item = {
        type: "issue",
        number,
        title: issue.title || "",
        body: issue.body || "",
        url: issue.html_url || "",
      };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  if (item) {
    const linkedNumbers = extractLinkedIssueNumbers(item.body);
    if (linkedNumbers.length) {
      const linked = await fetchContextForNumber(linkedNumbers[0], cache);
      if (linked) {
        item.linkedIssueTitle = linked.title || "";
        item.linkedIssueBody = linked.body || "";
        item.linkedIssueUrl = linked.url || "";
      }
    }
  }

  cache.set(number, item);
  return item;
}

async function fetchContextViaHtml(number, cache) {
  if (cache.has(number)) return cache.get(number);

  const candidates = [
    `https://github.com/${REPO}/pull/${number}`,
    `https://github.com/${REPO}/issues/${number}`,
  ];

  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      const titleMatch =
        html.match(/<meta property="og:title" content="([^"]+)"/i) ||
        html.match(/<title>([^<]+)<\/title>/i);
      const descriptionMatch =
        html.match(/<meta name="description" content="([^"]+)"/i) ||
        html.match(/<meta property="og:description" content="([^"]+)"/i);

      const item = {
        type: url.includes("/pull/") ? "pull" : "issue",
        number,
        title: decodeHtmlEntities(titleMatch ? titleMatch[1] : ""),
        body: decodeHtmlEntities(descriptionMatch ? descriptionMatch[1] : ""),
        url,
      };

      cache.set(number, item);
      return item;
    } catch (error) {
      if (error.status === 404) continue;
    }
  }

  cache.set(number, null);
  return null;
}

async function buildContextMap(releases) {
  const contextMap = await loadOfflineContext();
  const numbers = new Set();
  const scopedReleases = releases.slice(0, CONTEXT_RELEASE_LIMIT);

  for (const release of scopedReleases) {
    for (const section of parseMarkdown(release.body || "")) {
      for (const item of section.items) {
        if (!shouldFetchContext(item, section.title)) continue;
        const number = extractRefNumber(item);
        if (number) numbers.add(number);
      }
    }
  }

  let failures = 0;
  const numberList = [...numbers];

  for (let i = 0; i < numberList.length; i += CONTEXT_CONCURRENCY) {
    const batch = numberList.slice(i, i + CONTEXT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (number) => {
        try {
          await fetchContextForNumber(number, contextMap);
          return true;
        } catch (error) {
          if (error.status === 403) {
            try {
              await fetchContextViaHtml(number, contextMap);
              return true;
            } catch {}
          }
          return false;
        }
      })
    );

    failures += results.filter((ok) => !ok).length;
  }

  if (failures) {
    if (!contextMap.size) {
      throw new Error("Context API unavailable and no offline context data.");
    }
    console.warn(
      `Context API unavailable for ${failures} items. Falling back to cached/offline context where needed.`
    );
  }

  return contextMap;
}

function summarizeRelease(release, contextMap) {
  const sections = parseMarkdown(release.body || "").map((section) => ({
    title: section.title,
    entries: section.items.map((item) => buildEntry(item, section.title, contextMap)),
  }));

  const allEntries = sections.flatMap((section) => section.entries);
  const total = allEntries.length;
  const fixes = allEntries.filter((entry) => entry.kind === "fix").length;
  const features = allEntries.filter((entry) => entry.kind === "feature").length;
  const upgrades = allEntries.filter((entry) => entry.kind === "upgrade").length;

  const topAreas = [...new Set(allEntries.map((entry) => entry.area))].slice(0, 3);

  return {
    release,
    sections,
    total,
    fixes,
    features,
    upgrades,
    headline: `这版一共 ${total} 条更新，重点集中在 ${topAreas.join("、")}。`,
  };
}

function renderEntry(entry) {
  return `
    <li class="entry">
      <div class="entry-main">
        <div class="entry-header">
          <span class="entry-kind kind-${escapeHtml(entry.kind)}">${escapeHtml(
            entry.area
          )}</span>
          ${entry.refNumber ? `<a class="entry-ref" href="${escapeHtml(
            entry.contextUrl || `https://github.com/${REPO}/pull/${entry.refNumber}`
          )}" target="_blank" rel="noopener">#${entry.refNumber}</a>` : ""}
        </div>
        <p class="entry-summary">${escapeHtml(entry.summary)}</p>
        <div class="entry-meta">
          <div><strong>这为什么重要：</strong>${escapeHtml(entry.whyItMatters)}</div>
          <div><strong>你要不要管：</strong>${escapeHtml(entry.doNext)}</div>
        </div>
        <details class="entry-details">
          <summary>看原始上下文</summary>
          <div class="entry-context">
            <div><strong>Release 原文：</strong>${escapeHtml(entry.text)}</div>
            ${entry.contextTitle ? `<div><strong>对应 PR/Issue：</strong>${escapeHtml(entry.contextTitle)}</div>` : ""}
            ${entry.linkedIssueTitle ? `<div><strong>关联问题：</strong>${escapeHtml(entry.linkedIssueTitle)}</div>` : ""}
          </div>
        </details>
      </div>
    </li>
  `;
}

function renderSection(section) {
  return `
    <section class="release-section">
      <h3>${escapeHtml(section.title)}</h3>
      <ul class="entry-list">
        ${section.entries.map(renderEntry).join("")}
      </ul>
    </section>
  `;
}

function renderRelease(summary) {
  const { release } = summary;
  return `
    <article class="release-card" id="${escapeHtml(release.tag_name)}">
      <header class="release-header">
        <div>
          <div class="release-kicker">Release</div>
          <h2>${escapeHtml(release.name || release.tag_name)}</h2>
          <p class="release-headline">${escapeHtml(summary.headline)}</p>
          <div class="release-facts">
            <span>发布时间：${escapeHtml(formatDate(release.published_at))}</span>
            <span>修复：${summary.fixes}</span>
            <span>新增：${summary.features}</span>
            <span>升级：${summary.upgrades}</span>
          </div>
        </div>
        <a class="release-link" href="${escapeHtml(
          release.html_url
        )}" target="_blank" rel="noopener">查看原始 Release</a>
      </header>
      ${summary.sections.map(renderSection).join("")}
    </article>
  `;
}

function buildHtml(releases, summaries) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw 更新日志中文解读</title>
    <meta name="description" content="结合 GitHub Release、PR 和 Issue 上下文，把 OpenClaw 更新日志解释成清楚、通俗的中文。" />
    <meta name="keywords" content="OpenClaw, 更新日志, 中文解读, GitHub Release, Issue, PR" />
    <link rel="canonical" href="${escapeHtml(SITE_URL)}" />
    <meta property="og:title" content="OpenClaw 更新日志中文解读" />
    <meta property="og:description" content="不只是翻译 release 文本，还结合 Issue 和 PR 上下文解释这次为什么改、改完有什么用。" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(SITE_URL)}" />
    <meta name="twitter:card" content="summary" />
    <link rel="stylesheet" href="/style.css" />
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "OpenClaw 更新日志中文解读",
        url: SITE_URL,
        description:
          "结合 GitHub Release、PR 和 Issue 上下文，把 OpenClaw 更新日志解释成清楚、通俗的中文。",
        inLanguage: "zh-CN",
      })}
    </script>
  </head>
  <body>
    <main class="page">
      <header class="page-header">
        <div class="page-title">OpenClaw 更新日志中文解读</div>
        <p class="page-intro">
          这个站不只是翻译 release 原文，而是尽量去看每条更新后面的 PR、Issue 和修复背景，
          再告诉你：原来哪里有问题、这次加了什么、对你到底有什么影响。
        </p>
        <div class="page-facts">
          <span>全球可访问</span>
          <span>Cloudflare Pages 免费部署</span>
          <span>支持每日自动同步</span>
          <span>预留 Google AdSense</span>
          <span>最后生成：${escapeHtml(formatDateTime(new Date().toISOString()))}</span>
        </div>
      </header>

      <section class="notice">
        <strong>说明：</strong>当 GitHub API 可访问时，页面会自动补充 PR/Issue 上下文；如果暂时访问不到，
        就退回到离线样本或 release 原文本身。
      </section>

      <section class="release-list">
        ${summaries.map(renderRelease).join("")}
      </section>
    </main>
  </body>
</html>`;
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

const STYLE_CSS = `
:root {
  --bg: #f6f8fa;
  --surface: #ffffff;
  --surface-muted: #f6f8fa;
  --border: #d0d7de;
  --text: #1f2328;
  --muted: #57606a;
  --link: #0969da;
  --success: #1a7f37;
  --accent: #8250df;
  --shadow: 0 1px 0 rgba(27, 31, 36, 0.04);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

.page {
  width: min(1012px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0 72px;
}

.page-header,
.notice,
.release-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

.page-header {
  padding: 24px;
}

.page-title {
  font-size: 32px;
  font-weight: 600;
  line-height: 1.25;
}

.page-intro {
  margin: 12px 0 0;
  color: var(--muted);
  max-width: 760px;
}

.page-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
}

.page-facts span,
.release-facts span,
.entry-kind,
.entry-ref {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 13px;
}

.page-facts span,
.release-facts span {
  background: var(--surface-muted);
  border: 1px solid var(--border);
  color: var(--muted);
}

.notice {
  margin-top: 16px;
  padding: 14px 16px;
  color: var(--muted);
}

.release-list {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}

.release-card {
  overflow: hidden;
}

.release-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 24px;
  border-bottom: 1px solid var(--border);
}

.release-kicker {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.release-header h2 {
  margin: 6px 0 8px;
  font-size: 28px;
  line-height: 1.25;
}

.release-headline {
  margin: 0;
  color: var(--muted);
}

.release-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.release-link {
  align-self: start;
  color: var(--link);
  text-decoration: none;
  font-weight: 500;
}

.release-section {
  padding: 20px 24px 24px;
  border-top: 1px solid var(--border);
}

.release-section h3 {
  margin: 0 0 14px;
  font-size: 20px;
}

.entry-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 12px;
}

.entry {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.entry-main {
  padding: 16px;
}

.entry-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.entry-kind {
  background: #ddf4ff;
  color: #0550ae;
}

.kind-fix {
  background: #dafbe1;
  color: var(--success);
}

.kind-upgrade {
  background: #fbefff;
  color: var(--accent);
}

.entry-ref {
  border: 1px solid var(--border);
  color: var(--link);
  text-decoration: none;
  background: var(--surface-muted);
}

.entry-summary {
  margin: 12px 0 0;
}

.entry-meta {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  color: var(--muted);
  font-size: 14px;
}

.entry-details {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.entry-details summary {
  cursor: pointer;
  color: var(--link);
  font-size: 14px;
}

.entry-context {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 14px;
}

@media (max-width: 720px) {
  .page {
    width: min(100% - 16px, 1012px);
    padding-top: 16px;
  }

  .page-title {
    font-size: 26px;
  }

  .release-header {
    flex-direction: column;
  }

  .release-header h2 {
    font-size: 24px;
  }
}
`.trim();

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function buildSite() {
  let releases;
  try {
    releases = await fetchAllReleases();
  } catch (error) {
    if (error.status === 403) {
      try {
        releases = await fetchLatestReleaseViaHtml();
        console.warn("GitHub API rate-limited. Using GitHub HTML fallback for releases.");
      } catch {
        const offline = await loadOfflineReleases();
        if (!offline) throw error;
        console.warn("GitHub API unavailable. Using offline releases data for local preview.");
        releases = offline;
      }
    } else {
      const offline = await loadOfflineReleases();
      if (!offline) throw error;
      console.warn("GitHub API unavailable. Using offline releases data for local preview.");
      releases = offline;
    }
  }

  releases = releases.slice(0, RELEASE_LIMIT);

  const contextMap = await buildContextMap(releases);
  const summaries = releases.map((release) => summarizeRelease(release, contextMap));
  const html = buildHtml(releases, summaries);

  await writeFile(path.join(PUBLIC_DIR, "index.html"), html);
  await writeFile(path.join(PUBLIC_DIR, "style.css"), STYLE_CSS);
  await writeFile(
    path.join(DATA_DIR, "releases.json"),
    JSON.stringify(releases, null, 2)
  );
  await writeFile(
    path.join(DATA_DIR, "context.json"),
    JSON.stringify(Object.fromEntries(contextMap), null, 2)
  );
  await writeFile(path.join(PUBLIC_DIR, "robots.txt"), buildRobots());
  await writeFile(path.join(PUBLIC_DIR, "sitemap.xml"), buildSitemap());
  await writeFile(path.join(PUBLIC_DIR, "ads.txt"), buildAdsTxt());
}

buildSite().catch((error) => {
  console.error(error);
  process.exit(1);
});
