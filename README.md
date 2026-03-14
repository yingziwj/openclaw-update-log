# OpenClaw 更新日志（通俗版）

这个站点会从 OpenClaw 的 GitHub Releases 拉取更新日志，生成“农民伯伯都能看懂”的中文解释版。每一条都保留原文，同时给出通俗解释，避免遗漏重要步骤。

## 本地生成

```bash
npm install
npm run build
```

生成结果在 `public/` 目录，可直接作为 Cloudflare Pages 的部署目录。

## Cloudflare Pages（免费部署）

1. 在 Cloudflare Pages 里创建新项目，连接 GitHub 仓库。
2. 构建命令填 `npm run build`，输出目录填 `public`。
3. 绑定免费域名，例如 `openclaw-update-log.pages.dev`。
4. 若想换自定义域名，可在 Pages 里添加域名并完成 DNS 解析。

## SEO 基础

已内置 `meta`、Open Graph、结构化数据、`robots.txt` 与 `sitemap.xml`，内容会在构建时自动生成并更新。

## 未来接入 Google AdSense

页面已预留广告区块，且 `public/ads.txt` 有示例。接入时：

1. 替换页面里的广告脚本（Cloudflare Pages 支持）。
2. 用 AdSense 的 `ads.txt` 记录覆盖 `public/ads.txt`。

## 自动更新（建议每日一次）

如果 GitHub Releases 有新增/修改/删除，重新构建即可同步站点内容。可以用 GitHub Actions 定时触发，示例如下（UTC 02:00，每天一次）：

```yaml
name: Daily Update
on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
      - uses: EndBug/add-and-commit@v9
        with:
          message: "chore: daily update"
```

如果遇到 GitHub API 频率限制，配置 `GITHUB_TOKEN` 环境变量可提升额度。
