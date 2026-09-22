#!/usr/bin/env node
/**
 * Internal link suggestions for the English docs and the blog, judged by Jev.
 *
 *   node scripts/internal-links.mjs propose [--only docs|blog] [--limit N] [--report PATH] [--dry-run]
 *     (--dry-run writes the candidate queue to queue.json beside the report, no Jev calls)
 *   node scripts/internal-links.mjs apply [--report PATH]
 *
 * `propose` reads every English docs page in docs/docs.json and every blog
 * post, asks Jev one request per page (about $0.0005), and writes a report of
 * the links it would place. Review or prune the report's `links`, then `apply`
 * wraps each anchor in the source file. Rerunning `propose` after `apply`
 * finds nothing new for those pairs: an existing link excludes its target.
 *
 * Targets also include the API reference operations (docs/api/*.openapi.json)
 * and, when `npm run build:crawlable-corpus` has run, the generated country,
 * chokepoint, crisis, comparison and source pages under public/.
 *
 * Chinese docs are out of scope: TypeSafe documents non-Latin scripts as
 * weaker for Jev, and anchor phrases need word boundaries Chinese text lacks.
 *
 * Needs TYPESAFE_API_KEY (.env.local) for `propose` without --dry-run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadEnvFile } from './_seed-utils.mjs';
import {
  JEV_ENDPOINT, JEV_MODEL, JEV_USD_PER_INPUT_TOKEN, RUBRIC, SITE_ORIGIN,
  applyLinks, buildJevRequest, buildQueue, canonicalHref, hrefFor, parseJevAnswers, parseMarkdown, placeLinks, splitCamel,
} from './lib/internal-links.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPORT = join(ROOT, 'node_modules/.cache/internal-links/report.json');

const TARGET_ONLY_DOCS = new Set(['changelog', 'eula', 'privacy', 'terms', 'dpa', 'license']);

// Map.groupBy needs Node 21; scripts/package.json still admits Node 20.
function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

const keyOf = (url) => canonicalHref(url, 'site');

function page({ url, kind, file = null, title, name = title, about = '', headings = [], plain = '', hrefs = [], prose = [] }) {
  const key = keyOf(url);
  const outbound = new Set(hrefs.map((h) => canonicalHref(h, kind)).filter(Boolean));
  return { key, url, kind, file, title, name, about, headings, plain, prose, outbound, editable: Boolean(file) };
}

function docsPages() {
  const nav = JSON.parse(readFileSync(join(ROOT, 'docs/docs.json'), 'utf8'));
  const en = nav.navigation.languages.find((l) => l.language === 'en');
  const slugs = new Set();
  // Page slugs sit in `pages` arrays, nested groups included; every other string is a label.
  const walk = (node) => {
    for (const entry of node.pages ?? []) {
      if (typeof entry === 'string') slugs.add(entry);
      else walk(entry);
    }
    for (const g of node.groups ?? []) walk(g);
  };
  en.tabs.forEach(walk);
  const out = [];
  for (const slug of slugs) {
    const file = ['.mdx', '.md'].map((ext) => `docs/${slug}${ext}`).find((f) => existsSync(join(ROOT, f)));
    if (!file) continue;
    const md = parseMarkdown(readFileSync(join(ROOT, file), 'utf8'));
    if (md.front.noindex === 'true') continue;
    const p = page({ url: `${SITE_ORIGIN}/docs/${slug}`, kind: 'docs', file, title: md.front.title || slug, about: md.front.description ?? '', ...md });
    // Legal text and the release log stay as written; both remain link targets.
    if (TARGET_ONLY_DOCS.has(slug)) p.editable = false;
    out.push(p);
  }
  return out;
}

function apiReferencePages() {
  const dir = join(ROOT, 'docs/api');
  const out = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.openapi.json'))) {
    const spec = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const ops of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(ops)) {
        if (!op?.operationId || !op.tags?.[0] || op.deprecated) continue;
        const description = op.description ?? '';
        out.push(page({
          url: `${SITE_ORIGIN}/docs/api-reference/${op.tags[0].toLowerCase()}/${op.operationId.toLowerCase()}`,
          kind: 'docs',
          title: `${splitCamel(op.operationId)} API`,
          about: description,
          plain: description,
        }));
      }
    }
  }
  return out;
}

function blogPages() {
  const dir = join(ROOT, 'blog-site/src/content/blog');
  return readdirSync(dir).filter((n) => n.endsWith('.md') || n.endsWith('.mdx')).map((n) => {
    const md = parseMarkdown(readFileSync(join(dir, n), 'utf8'));
    const slug = n.replace(/\.mdx?$/, '');
    return page({ url: `${SITE_ORIGIN}/blog/posts/${slug}/`, kind: 'blog', file: `blog-site/src/content/blog/${n}`, title: md.front.title || slug, about: md.front.description ?? '', ...md });
  });
}

// Similarity text from our own generated HTML, never rendered: one decoding
// pass, and `&lt;`/`&gt;` become spaces so no markup can reappear.
const ENTITIES = { amp: '&', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ', lt: ' ', gt: ' ' };
const textOf = (html) => html
  .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|quot|#39|#x27|nbsp|lt|gt);/g, (_, e) => ENTITIES[e])
  .replace(/\s+/g, ' ')
  .trim();

function sitePages() {
  const manifestFile = join(ROOT, 'public/crawlable-corpus.json');
  if (!existsSync(manifestFile)) {
    console.error('[internal-links] public/crawlable-corpus.json missing: generated site pages are not targets this run (npm run build:crawlable-corpus)');
    return [];
  }
  const { sections } = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const routes = new Set();
  for (const s of Object.values(sections)) {
    if (s.index) routes.add(s.index);
    for (const r of s.routes ?? []) routes.add(r);
  }
  const out = [];
  for (const route of routes) {
    const file = join(ROOT, 'public', route, 'index.html');
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    const title = textOf(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').replace(/\s*[|–—]\s*World ?Monitor.*$/i, '').trim();
    const about = textOf(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
    const h1 = textOf(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
    const plain = textOf(html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? '');
    if (title) out.push({ ...page({ url: `${SITE_ORIGIN}${route}`, kind: 'site', title: h1 || title, about, plain: plain.slice(0, 20000) }), h1, section: route.split('/')[1] });
  }
  // Every country page is titled "<Country> Country Instability Index": the
  // words a section's titles share are template, the rest is the page's name.
  for (const group of groupBy(out, (p) => p.section).values()) {
    if (group.length < 3) continue;
    const split = group.map((p) => p.title.split(/\s+/));
    let shared = 0;
    while (split.every((w) => w.length > shared + 1 && w.at(-1 - shared) === split[0].at(-1 - shared))) shared++;
    if (shared) for (const [n, p] of group.entries()) p.name = split[n].slice(0, -shared).join(' ');
  }
  return out;
}

async function askJev(body, key, attempt = 0) {
  try {
    const r = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-InternalLinks/1.0' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 429 || r.status >= 500) throw new Error(`jev http ${r.status}`);
    if (!r.ok) throw Object.assign(new Error(`jev http ${r.status}: ${(await r.text()).slice(0, 300)}`), { fatal: true });
    return await r.json();
  } catch (err) {
    if (err.fatal || attempt >= 2) throw err;
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    return askJev(body, key, attempt + 1);
  }
}

async function propose(opts) {
  const pages = [...docsPages(), ...apiReferencePages(), ...blogPages(), ...sitePages()];
  for (const p of pages) if (p.editable && opts.only && p.kind !== opts.only) p.editable = false;
  const byKey = new Map(pages.map((p) => [p.key, p]));
  let queue = buildQueue(pages);
  if (opts.limit) queue = queue.slice(0, opts.limit);
  const decisions = queue.reduce((n, j) => n + j.targets.length, 0);
  console.error(`[internal-links] ${pages.length} pages (${pages.filter((p) => p.editable).length} editable), ${queue.length} to judge, ${decisions} link decisions`);
  mkdirSync(dirname(opts.report), { recursive: true });
  if (opts.dryRun) {
    // Beside the report, never over it: a reviewed, pruned report must survive a dry run.
    const queueFile = join(dirname(opts.report), 'queue.json');
    writeFileSync(queueFile, `${JSON.stringify(queue, null, 2)}\n`);
    console.error(`[internal-links] candidate queue: ${relative(process.cwd(), queueFile)}`);
    return;
  }

  loadEnvFile(import.meta.url, { only: ['TYPESAFE_API_KEY'] });
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (.env.local)');

  const links = [];
  const failed = [];
  let inputTokens = 0;
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < queue.length) {
      const job = queue[next++];
      const src = byKey.get(job.source);
      try {
        const body = await askJev(buildJevRequest(job, src), apiKey);
        inputTokens += Number(body.usage?.input_tokens) || 0;
        for (const l of placeLinks(job, parseJevAnswers(body, job))) {
          links.push({ ...l, sourceFile: src.file, href: hrefFor(src, byKey.get(l.target)) });
        }
      } catch (err) {
        failed.push({ source: job.source, error: String(err.message ?? err) });
      }
    }
  }));
  links.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.line - b.line);
  const report = {
    generatedAt: new Date().toISOString(),
    model: JEV_MODEL,
    rubric: { linkThreshold: RUBRIC.linkThreshold, anchorConfidence: RUBRIC.anchorConfidence, maxLinksPerPage: RUBRIC.maxLinksPerPage },
    stats: {
      pages: pages.length,
      judged: queue.length,
      decisions,
      links: links.length,
      pagesLinked: new Set(links.map((l) => l.source)).size,
      failed: failed.length,
      inputTokens,
      estimatedUsd: Math.round(inputTokens * JEV_USD_PER_INPUT_TOKEN * 1e4) / 1e4,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    },
    failed,
    links,
  };
  writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  for (const l of links) console.log(`${l.sourceFile}:${l.line + 1}  [${l.anchor}](${l.href})  p=${l.link.toFixed(2)}`);
  console.error(`[internal-links] ${JSON.stringify(report.stats)}\n[internal-links] report: ${relative(process.cwd(), opts.report)}`);
  if (failed.length) process.exitCode = 1;
}

function apply(opts) {
  const { links } = JSON.parse(readFileSync(opts.report, 'utf8'));
  if (!links) throw new Error(`${opts.report} holds no links: run propose without --dry-run`);
  const byFile = groupBy(links, (l) => l.sourceFile);
  let placed = 0;
  for (const [file, fileLinks] of byFile) {
    const path = join(ROOT, file);
    const { text, skipped } = applyLinks(readFileSync(path, 'utf8'), fileLinks);
    writeFileSync(path, text);
    placed += fileLinks.length - skipped.length;
    for (const s of skipped) console.error(`[internal-links] skipped ${file}:${s.line + 1} "${s.anchor}": not found as plain text on that line`);
  }
  console.error(`[internal-links] placed ${placed} of ${links.length} links in ${byFile.size} files`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: 'string' },
    limit: { type: 'string' },
    report: { type: 'string', default: DEFAULT_REPORT },
    'dry-run': { type: 'boolean', default: false },
  },
});
const opts = { only: values.only, limit: Number(values.limit) || 0, report: resolve(values.report), dryRun: values['dry-run'] };
if (opts.only && !['docs', 'blog'].includes(opts.only)) throw new Error('--only takes docs or blog');
const command = positionals[0] ?? 'propose';
if (command === 'propose') await propose(opts);
else if (command === 'apply') apply(opts);
else throw new Error(`unknown command ${command}: propose or apply`);
