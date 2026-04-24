#!/usr/bin/env node
/**
 * migrate-duda.mjs — Duda-to-Pixel Migration Tool (Playwright-based)
 *
 * Core insight: Playwright renders the page against real Duda servers (so layout
 * is correct at networkidle), then we strip ALL <script> tags so Duda's post-load
 * API polling can't corrupt the layout when loaded locally.
 *
 * Network interception captures every asset the browser actually fetches (catches
 * lazy-loaded images). CSS files are downloaded and their url() references rewritten.
 *
 * Usage:
 *   node scripts/migrate-duda.mjs --url https://www.example.com --slug test-site [--pages 20] [--wait 2000]
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '../sites');

/* ── CLI args ───────────────────────────────────────────────────────── */

const { values: args } = parseArgs({
  options: {
    url:          { type: 'string' },
    slug:         { type: 'string' },
    pages:        { type: 'string', default: '20' },
    wait:         { type: 'string', default: '2000' },
    'output-dir': { type: 'string', default: '' },
    help:         { type: 'boolean', default: false },
  },
});

if (args.help || !args.url || !args.slug) {
  console.log(`Usage:
  node scripts/migrate-duda.mjs --url <url> --slug <slug> [--pages 20] [--wait 2000]

Options:
  --url    Starting URL (required)
  --slug   Output directory name under sites/ (required)
  --pages  Max pages to crawl (default: 20)
  --wait   Extra ms to wait after scroll settle (default: 2000)`);
  process.exit(0);
}

const rootUrl  = new URL(args.url);
const slug     = args.slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
const maxPages = parseInt(args.pages) || 20;
const waitMs   = parseInt(args.wait) || 2000;
const siteDir  = args['output-dir'] ? join(args['output-dir'], slug) : join(SITES_DIR, slug);
const assetsDir = join(siteDir, 'assets');

// Tracking
const capturedAssets = new Map(); // url → { buffer, contentType, ext }
const assetMap       = new Map(); // url → local filename (e.g. /assets/abc123.jpg)
const crawledPages   = new Map(); // url → html
const redirectMap    = new Map(); // original url → final url (for redirect tracking)
const errors         = [];
const startTime      = Date.now();

// Nav slugs — extracted from the home page nav, written to the report so
// Pixel can show nav pages vs. internal/subpages separately
let homeNavSlugs     = null;

/* ── Utility ────────────────────────────────────────────────────────── */

function hashUrl(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function extFromContentType(ct) {
  if (!ct) return '';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('png'))   return '.png';
  if (ct.includes('webp'))  return '.webp';
  if (ct.includes('gif'))   return '.gif';
  if (ct.includes('svg'))   return '.svg';
  if (ct.includes('ico'))   return '.ico';
  if (ct.includes('avif'))  return '.avif';
  if (ct.includes('css'))   return '.css';
  if (ct.includes('woff2')) return '.woff2';
  if (ct.includes('woff'))  return '.woff';
  if (ct.includes('ttf') || ct.includes('truetype')) return '.ttf';
  if (ct.includes('eot'))   return '.eot';
  if (ct.includes('otf'))   return '.otf';
  return '';
}

function getExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase().split('?')[0].split('#')[0];
    if (ext && ext.length <= 6) return ext;
  } catch {}
  return '';
}

function isAssetContentType(ct) {
  if (!ct) return false;
  const types = ['image/', 'text/css', 'font/', 'application/font', 'application/x-font',
                 'application/vnd.ms-fontobject'];
  return types.some(t => ct.includes(t));
}

function isSkippableUrl(href) {
  const skip = [
    'google-analytics.com', 'googletagmanager.com', 'facebook.net',
    'fbcdn.net', 'hotjar.com', 'doubleclick.net', 'googlesyndication.com',
    'googleadservices.com', 'google.com/recaptcha', 'gstatic.com/recaptcha',
    'clarity.ms', 'bing.com/bat', 'connect.facebook.net',
    'analytics.tiktok.com', 'snap.licdn.com', 'twitter.com/i/',
    'ads-twitter.com', 'hubspot.com', 'hs-analytics',
    'intercom.io', 'zendesk.com', 'crisp.chat', 'tawk.to',
    'livechatinc.com', 'olark.com', 'drift.com',
  ];
  try {
    const u = new URL(href);
    return skip.some(d => u.hostname.includes(d) || u.pathname.includes(d));
  } catch { return false; }
}

function isGoogleFont(href) {
  try {
    const u = new URL(href);
    return u.hostname.includes('fonts.googleapis.com') || u.hostname.includes('fonts.gstatic.com');
  } catch { return false; }
}

function isInternalUrl(href) {
  try {
    const u = new URL(href, rootUrl.origin);
    return u.hostname === rootUrl.hostname ||
           u.hostname === 'www.' + rootUrl.hostname ||
           'www.' + u.hostname === rootUrl.hostname;
  } catch { return false; }
}

function normalizeUrl(href) {
  try {
    const u = new URL(href, rootUrl.origin);
    u.hash = '';
    u.search = '';
    let path = u.pathname;
    if (!extname(path)) {
      path = path.endsWith('/') ? path : path + '/';
    }
    u.pathname = path;
    return u.href;
  } catch { return null; }
}

function urlToFilePath(pageUrl) {
  const u = new URL(pageUrl);
  let path = u.pathname;
  if (path === '/' || path === '') return 'index.html';
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.endsWith('.html') || path.endsWith('.htm')) return path;
  return path + '/index.html';
}

/* ── Phase 1: Discover pages (sitemap first, then link crawl) ─────── */

async function discoverPages() {
  console.log('\n[1] Discovering pages...');
  const pages = new Set();

  // Try sitemap.xml first
  try {
    const sitemapUrl = new URL('/sitemap.xml', rootUrl.origin).href;
    console.log(`  Checking ${sitemapUrl}`);
    const resp = await fetch(sitemapUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZingMigrator/2.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const xml = await resp.text();
      const locMatches = xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
      for (const m of locMatches) {
        const loc = m[1].trim();
        if (isInternalUrl(loc)) pages.add(loc);
      }
      console.log(`  Found ${pages.size} pages in sitemap.xml`);
    }
  } catch (e) {
    console.log(`  No sitemap.xml (${e.message})`);
  }

  // Ensure root URL is always first
  const result = [rootUrl.href];
  for (const p of pages) {
    if (normalizeUrl(p) !== normalizeUrl(rootUrl.href)) result.push(p);
  }

  return result.slice(0, maxPages);
}

/* ── Phase 2: Render + capture per page ───────────────────────────── */

async function renderPage(page, url) {
  // Set up network interception to capture assets
  const pageAssets = [];
  page.on('response', async (response) => {
    const respUrl = response.url();
    if (isSkippableUrl(respUrl)) return;

    const ct = response.headers()['content-type'] || '';
    const status = response.status();
    if (status < 200 || status >= 400) return;

    // Capture images, CSS, and fonts
    if (isAssetContentType(ct) || isGoogleFont(respUrl)) {
      // Skip Google Fonts CSS (keep as CDN links) but capture gstatic font files
      if (respUrl.includes('fonts.googleapis.com')) return;

      try {
        const buffer = await response.body();
        let ext = getExtension(respUrl) || extFromContentType(ct);
        if (!ext) ext = '.bin';
        capturedAssets.set(respUrl, { buffer, contentType: ct, ext });
        pageAssets.push(respUrl);
      } catch {
        // Response body may not be available (redirects, etc.)
      }
    }
  });

  // Navigate — track final URL in case of redirect
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  const finalUrl = page.url(); // may differ from url if redirected

  // Scroll full page to trigger lazy loading
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate(y => window.scrollTo(0, y), y);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(waitMs);

  // Get rendered HTML with scripts stripped
  const html = await page.evaluate(() => {
    // Remove all script tags — prevents Duda's post-load API polling
    document.querySelectorAll('script').forEach(s => s.remove());
    // Remove noscript tags — we're static now
    document.querySelectorAll('noscript').forEach(s => s.remove());
    return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  });

  // Collect internal links for crawling
  const links = await page.evaluate((hostname) => {
    const found = new Set();
    document.querySelectorAll('a[href]').forEach(el => {
      try {
        const u = new URL(el.href);
        if ((u.hostname === hostname || u.hostname === 'www.' + hostname ||
             'www.' + u.hostname === hostname) &&
            !el.href.startsWith('mailto:') && !el.href.startsWith('tel:') &&
            !el.href.startsWith('javascript:')) {
          found.add(el.href);
        }
      } catch {}
    });
    return [...found];
  }, rootUrl.hostname);

  return { html, links, assetCount: pageAssets.length, finalUrl };
}

/* ── Phase 3: Save captured assets ────────────────────────────────── */

// Canonical URL key: decode percent-encoding, lowercase scheme+host, no fragment/query
// This ensures a URL captured as "Untitled+design.jpg" and looked up as "Untitled+design.jpg"
// always match even if one side went through new URL() normalization.
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Don't strip query — some asset URLs need it. But do decode the pathname.
    u.pathname = decodeURIComponent(u.pathname);
    return u.href;
  } catch { return url; }
}

function saveAssets() {
  console.log(`\n[3] Saving ${capturedAssets.size} captured assets...`);
  mkdirSync(assetsDir, { recursive: true });

  let saved = 0;
  for (const [url, asset] of capturedAssets) {
    const hash = hashUrl(url);
    const filename = hash + asset.ext;
    const localPath = '/assets/' + filename;
    // Key by canonical form so lookups match regardless of encoding
    assetMap.set(canonicalUrl(url), localPath);
    // Also key by original URL as fallback
    if (canonicalUrl(url) !== url) assetMap.set(url, localPath);

    writeFileSync(join(assetsDir, filename), asset.buffer);
    saved++;
  }
  console.log(`  Saved ${saved} assets`);
}

/* ── Download helper for uncaptured url() references ──────────────── */

async function downloadMissingAsset(url) {
  if (assetMap.has(url)) return true;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZingMigrator/2.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return false;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ct = resp.headers.get('content-type') || '';
    let ext = getExtension(url) || extFromContentType(ct) || '.bin';
    const hash = hashUrl(url);
    const filename = hash + ext;
    assetMap.set(url, '/assets/' + filename);
    writeFileSync(join(assetsDir, filename), buffer);
    return true;
  } catch {
    return false;
  }
}

function collectCssUrls(css, baseUrl) {
  const urls = [];
  const regex = /url\(\s*['"]?\s*([^'")\s]+)\s*['"]?\s*\)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    const ref = match[1];
    if (ref.startsWith('data:') || ref.startsWith('#')) continue;
    if (ref.includes('fonts.googleapis.com') || ref.includes('fonts.gstatic.com')) continue;
    try {
      urls.push(new URL(ref, baseUrl).href);
    } catch {}
  }
  return urls;
}

/* ── Phase 4: Process CSS files + inline styles (rewrite url()) ───── */

async function processCss() {
  console.log('\n[4] Processing CSS and downloading missing assets...');

  // Collect all url() references from CSS files AND HTML <style> tags
  const missingUrls = new Set();

  // From external CSS files
  for (const [originalUrl, localPath] of assetMap) {
    if (!localPath.endsWith('.css')) continue;
    const fullPath = join(siteDir, localPath);
    if (!existsSync(fullPath)) continue;
    const css = readFileSync(fullPath, 'utf-8');
    for (const u of collectCssUrls(css, originalUrl)) {
      if (!assetMap.has(u) && !capturedAssets.has(u)) missingUrls.add(u);
    }
  }

  // From HTML <style> blocks
  for (const [pageUrl, html] of crawledPages) {
    const styleBlocks = html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
    for (const m of styleBlocks) {
      for (const u of collectCssUrls(m[1], pageUrl)) {
        if (!assetMap.has(u) && !capturedAssets.has(u)) missingUrls.add(u);
      }
    }
  }

  // Download missing assets (concurrency 5)
  if (missingUrls.size > 0) {
    console.log(`  Downloading ${missingUrls.size} missing url() assets...`);
    const batches = [];
    const urls = [...missingUrls];
    for (let i = 0; i < urls.length; i += 5) {
      const batch = urls.slice(i, i + 5).map(u => downloadMissingAsset(u));
      await Promise.allSettled(batch);
    }
  }

  // Also add captured-but-not-yet-mapped assets
  for (const [url, asset] of capturedAssets) {
    if (!assetMap.has(url)) {
      const hash = hashUrl(url);
      const filename = hash + asset.ext;
      assetMap.set(url, '/assets/' + filename);
      writeFileSync(join(assetsDir, filename), asset.buffer);
    }
  }

  // Now rewrite external CSS files
  let cssCount = 0;
  for (const [originalUrl, localPath] of assetMap) {
    if (!localPath.endsWith('.css')) continue;
    cssCount++;

    const fullPath = join(siteDir, localPath);
    if (!existsSync(fullPath)) continue;

    let css = readFileSync(fullPath, 'utf-8');

    // Rewrite url() references to local paths
    css = css.replace(/url\(\s*['"]?\s*([^'")\s]+)\s*['"]?\s*\)/g, (full, ref) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return full;
      if (ref.includes('fonts.googleapis.com') || ref.includes('fonts.gstatic.com')) return full;
      try {
        const absUrl = new URL(ref, originalUrl).href;
        if (assetMap.has(absUrl)) {
          const localFile = assetMap.get(absUrl).replace('/assets/', '');
          return `url('${localFile}')`;
        }
      } catch {}
      return full;
    });

    writeFileSync(fullPath, css);
  }

  console.log(`  Processed ${cssCount} CSS files`);
}

/* ── Nav Rebuilder ───────────────────────────────────────────────── */

function parseRgba(val) {
  // Returns {r,g,b} or null. Accepts rgba(...) or #hex
  let m = val && val.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  m = val && val.match(/#([0-9a-f]{3,6})\b/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(x=>x+x).join('') : m[1];
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}
function luminance({r,g,b}) { return 0.299*r + 0.587*g + 0.114*b; }
function textOnBg(color) { const c = parseRgba(color); return (c && luminance(c) > 140) ? '#000' : '#fff'; }

// If perceived luminance contrast is poor, flip text to white or dark charcoal
function ensureContrast(textColor, bgColor) {
  const fg = parseRgba(textColor);
  const bg = parseRgba(bgColor);
  if (!fg || !bg) return textColor;
  const fgL = luminance(fg);
  const bgL = luminance(bg);
  // If both are dark (both < 140) or both are light (both >= 140), flip text
  if ((fgL < 140) === (bgL < 140)) {
    return bgL >= 140 ? 'rgba(30,30,30,1)' : 'rgba(255,255,255,1)';
  }
  return textColor;
}

function extractNavData($) {
  const styleBlocks = [];
  $('style').each((_, el) => styleBlocks.push($(el).html() || ''));
  const allCss = styleBlocks.join('\n');

  // ── Logo ────────────────────────────────────────────────────────────
  const nav = $('nav.main-navigation, nav.unifiednav, nav[class*="navigation"]').first();
  let logoSrc = nav.attr('data-logo-src') || '';
  let logoAlt = nav.attr('data-logo-alt') || '';
  if (!logoSrc) {
    // Try middleLogoLink (Duda SPLIT nav puts logo in a center container)
    const mid = $('[class*="middleLogo"] img, [class*="navLogo"] img, a[class*="logo"] img').first();
    logoSrc = mid.attr('src') || mid.attr('data-src') || '';
    logoAlt = mid.attr('alt') || '';
  }
  if (!logoSrc) {
    const logoImg = nav.find('img').first();
    // Check both src and data-src — Duda lazy-loads logos via data-src
    logoSrc = logoImg.attr('src') || logoImg.attr('data-src') || '';
    logoAlt = logoImg.attr('alt') || '';
  }
  if (!logoSrc) {
    const img = $('img[alt*="logo" i], img[src*="logo" i]').first();
    logoSrc = img.attr('src') || img.attr('data-src') || '';
    logoAlt = img.attr('alt') || logoAlt;
  }
  // Last resort: any img in the header area that isn't a tiny icon (<30px)
  if (!logoSrc) {
    $('header img, .dmHeader img, [class*="header"] img').each((_, el) => {
      if (logoSrc) return;
      const w = parseInt($(el).attr('width') || '100');
      if (w < 30) return; // skip tiny icons
      logoSrc = $(el).attr('src') || $(el).attr('data-src') || '';
      logoAlt = $(el).attr('alt') || '';
    });
  }

  // ── Nav items: extract all, then split for SPLIT layout ────────────
  const navStructure = (nav.attr('data-nav-structure') || '').toUpperCase();
  const isSplit = navStructure === 'SPLIT' || nav.find('.left_nav, .right_nav').length > 0;

  // Flat extraction — works regardless of left/right containers
  const allItems = [];
  nav.find('.unifiednav__item-wrap').each((_, el) => {
    // Skip nested items (inside a dropdown)
    if ($(el).parents('.unifiednav__item-wrap').length > 0) return;
    const link = $(el).find('> .unifiednav__item > a, > a').first();
    const href = link.attr('href') || '#';
    const text = (link.find('.nav-item-text').text().trim() || link.text().trim()).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const subItems = [];
    $(el).find('[data-depth] .unifiednav__item-wrap').each((_, sub) => {
      if ($(sub).parents('.unifiednav__item-wrap').filter((i, p) => p !== el).length > 1) return;
      const sl = $(sub).find('> .unifiednav__item > a, > a').first();
      const stext = (sl.find('.nav-item-text').text().trim() || sl.text().trim()).replace(/\s+/g, ' ').trim();
      const shref = sl.attr('href') || '#';
      if (stext) subItems.push({ text: stext, href: shref });
    });
    allItems.push({ text, href, subItems });
  });

  // For SPLIT layout: split items in half (left nav / right nav around center logo)
  const mid = Math.ceil(allItems.length / 2);
  const leftItems = isSplit ? allItems.slice(0, mid) : allItems;
  const rightItems = isSplit ? allItems.slice(mid) : [];

  // ── Colors: extract from Duda's CSS variables and specific rules ───
  // Priority: --btn-bg-color (brand accent) > most-frequent interesting color
  let accentColor = 'rgba(126,166,125,1)'; // fallback sage green
  let navBg = 'rgba(255,255,255,1)'; // Duda default header: white
  let navLinkColor = 'rgba(102,102,102,1)'; // Duda default link: grey

  // --btn-bg-color: explicit brand button color
  const btnBg = allCss.match(/--btn-bg-color\s*:\s*([^;\n}]+)/);
  if (btnBg) accentColor = btnBg[1].trim();

  // Nav background: look for .dmHeader or dmInner div.dmHeader background-color override
  const navBgMatch = allCss.match(/div\.dmHeader[^{]*\{[^}]*background-color\s*:\s*([^;!}]+)/);
  if (navBgMatch) navBg = navBgMatch[1].trim();

  // Nav link color: look for nav.u_xxx .unifiednav__item color
  const navLinkMatch = allCss.match(/nav\.u_\w+[^{]*unifiednav[^{]*color\s*:\s*([^;!}]+)/);
  if (navLinkMatch) navLinkColor = navLinkMatch[1].trim();
  else {
    const navLinkMatch2 = allCss.match(/\.unifiednav__item\b[^{]*\{[^}]*color\s*:\s*([^;!}]+)/);
    if (navLinkMatch2) navLinkColor = navLinkMatch2[1].trim();
  }

  // Accent underline color (effect-bottom2 border color)
  let accentUnderline = accentColor;
  const underlineMatch = allCss.match(/nav-item-text::after[^{]*\{[^}]*border-top-color\s*:\s*([^;!}]+)/);
  if (underlineMatch) accentUnderline = underlineMatch[1].trim();

  // Font info
  const fontFamilyMatch = allCss.match(/font-family\s*:\s*([^;,"]+)/);
  const navFont = fontFamilyMatch ? fontFamilyMatch[1].trim() : 'inherit';

  // Auto-correct link color if it doesn't contrast enough against the nav background
  navLinkColor = ensureContrast(navLinkColor, navBg);
  // Accent color should also contrast against nav background (for hover underlines etc.)
  accentColor = ensureContrast(accentColor, navBg);

  return { logoSrc, logoAlt, isSplit, leftItems, rightItems, accentColor, accentUnderline, navBg, navLinkColor, navFont };
}

function renderNavItems(items, linkColor, accentColor, dropdownBg, dropdownLinkColor) {
  return items.map(({ text, href, subItems }) => {
    if (subItems.length > 0) {
      const subHtml = subItems.map(s =>
        `<li class="pxnav__sub-item"><a href="${s.href}">${s.text}</a></li>`
      ).join('');
      return `<li class="pxnav__item pxnav__item--has-sub"><a href="${href}">${text} <span class="pxnav__caret">▾</span></a><ul class="pxnav__dropdown">${subHtml}</ul></li>`;
    }
    return `<li class="pxnav__item"><a href="${href}">${text}</a></li>`;
  }).join('');
}

function buildCleanNav(navData, sitePrefix) {
  const { logoSrc, logoAlt, isSplit, leftItems, rightItems, accentColor, accentUnderline, navBg, navLinkColor, navFont } = navData;
  const dropdownBg = navBg;
  const burgerColor = navLinkColor;

  const logoHtml = logoSrc
    ? `<a href="${sitePrefix}/" class="pxnav__logo-link"><img src="${logoSrc}" alt="${logoAlt || 'Home'}" class="pxnav__logo-img" /></a>`
    : `<a href="${sitePrefix}/" class="pxnav__logo-link pxnav__logo-text">${logoAlt || 'Home'}</a>`;

  const allItems = isSplit ? [...leftItems, ...rightItems] : leftItems;
  const leftHtml = renderNavItems(leftItems.length ? leftItems : allItems.slice(0, Math.ceil(allItems.length/2)), navLinkColor, accentColor, dropdownBg, navLinkColor);
  const rightHtml = isSplit ? renderNavItems(rightItems, navLinkColor, accentColor, dropdownBg, navLinkColor) : '';
  const flatHtml = !isSplit ? renderNavItems(allItems, navLinkColor, accentColor, dropdownBg, navLinkColor) : '';

  const navInner = isSplit
    ? `<ul class="pxnav__menu pxnav__menu--left">${leftHtml}</ul>${logoHtml}<ul class="pxnav__menu pxnav__menu--right">${rightHtml}</ul>`
    : `${logoHtml}<ul class="pxnav__menu">${flatHtml}</ul>`;

  const mobileMenuItems = renderNavItems(allItems, navLinkColor, accentColor, dropdownBg, navLinkColor);

  return `<nav class="pxnav" role="navigation">
<style>
/* ── Pixel rebuilt nav ── */
.pxnav{background:${navBg};display:flex;align-items:center;justify-content:space-between;padding:0 20px;width:100%;box-shadow:0 1px 4px rgba(0,0,0,.1);position:relative;z-index:9999;box-sizing:border-box;}
.pxnav__logo-link{display:flex;align-items:center;flex-shrink:0;text-decoration:none;padding:12px 0;}
.pxnav__logo-img{height:55px;width:auto;display:block;}
.pxnav__logo-text{font-size:1.2rem;font-weight:700;color:${navLinkColor};}
.pxnav__menu{list-style:none;margin:0;padding:0;display:flex;align-items:stretch;}
.pxnav__menu--left{justify-content:flex-end;flex:1;}
.pxnav__menu--right{justify-content:flex-start;flex:1;}
.pxnav__item{position:relative;display:flex;align-items:stretch;}
.pxnav__item>a{display:flex;align-items:center;padding:0 15px;color:${navLinkColor};text-decoration:none;font-family:${navFont};font-size:15px;font-weight:400;letter-spacing:.03em;text-transform:uppercase;white-space:nowrap;border-bottom:3px solid transparent;transition:border-color .2s,color .2s;}
.pxnav__item>a:hover{border-bottom-color:${accentUnderline};color:${navLinkColor};}
.pxnav__caret{font-size:.7em;margin-left:4px;display:inline-block;}
.pxnav__dropdown{display:none;position:absolute;top:100%;left:0;min-width:180px;background:${dropdownBg};list-style:none;margin:0;padding:4px 0;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:1000;border-top:2px solid ${accentColor};}
.pxnav__item--has-sub:hover>.pxnav__dropdown{display:block;}
.pxnav__sub-item>a{display:block;padding:10px 20px;color:${navLinkColor};text-decoration:none;font-size:14px;white-space:nowrap;transition:color .15s;}
.pxnav__sub-item>a:hover{color:${accentColor};}
/* Mobile */
.pxnav__toggle{display:none;position:absolute;}
.pxnav__burger{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:8px;border:none;background:none;}
.pxnav__burger span{display:block;width:24px;height:2px;background:${burgerColor};transition:all .2s;}
.pxnav__mobile-menu{display:none;flex-direction:column;background:${navBg};border-top:1px solid rgba(0,0,0,.1);list-style:none;margin:0;padding:8px 0;position:absolute;top:100%;left:0;right:0;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:9998;}
.pxnav__toggle:checked~.pxnav__mobile-menu{display:flex;}
.pxnav__mobile-menu li{display:block;}
.pxnav__mobile-menu a{display:block;padding:12px 24px;color:${navLinkColor};text-decoration:none;font-size:14px;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid rgba(0,0,0,.05);}
.pxnav__mobile-menu a:hover{color:${accentColor};}
@media(max-width:768px){
  .pxnav{flex-wrap:wrap;}
  .pxnav__menu{display:none;}
  .pxnav__burger{display:flex;margin-left:auto;}
}
</style>
<input class="pxnav__toggle" type="checkbox" id="pxnav-mob-toggle" />
${navInner}
<label class="pxnav__burger" for="pxnav-mob-toggle" aria-label="Menu"><span></span><span></span><span></span></label>
<ul class="pxnav__mobile-menu">${mobileMenuItems}</ul>
</nav>`;
}

/* ── Phase 5: Rewrite HTML ────────────────────────────────────────── */

function rewriteHtml(html, pageUrl, sitePrefix = '') {
  const $ = cheerio.load(html, { decodeEntities: false });

  function rewriteAttr(selector, attr) {
    $(selector).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;

      if (attr === 'srcset') {
        const newSrcset = val.split(',').map(entry => {
          const parts = entry.trim().split(/\s+/);
          try {
            const absUrl = new URL(parts[0], pageUrl).href;
            const key = canonicalUrl(absUrl);
            const local = assetMap.get(key) || assetMap.get(absUrl);
            if (local) parts[0] = local;
          } catch {}
          return parts.join(' ');
        }).join(', ');
        $(el).attr(attr, newSrcset);
        return;
      }

      try {
        const absUrl = new URL(val, pageUrl).href;
        if (isGoogleFont(absUrl)) return; // Keep Google Fonts CDN
        const key = canonicalUrl(absUrl);
        const local = assetMap.get(key) || assetMap.get(absUrl);
        if (local) {
          $(el).attr(attr, local);
        }
      } catch {}
    });
  }

  rewriteAttr('img', 'src');
  rewriteAttr('img', 'srcset');
  rewriteAttr('source', 'src');
  rewriteAttr('source', 'srcset');

  // Sync img[src] from rewritten srcset when src is still an external CDN URL.
  // Duda pattern: src=irp.cdn (original, not fetched), srcset=lirp.cdn (optimized, fetched).
  // After rewriteAttr, srcset may be local but src still CDN — use first srcset local path for src.
  $('img').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (!src.startsWith('/assets/') && (src.startsWith('http://') || src.startsWith('https://'))) {
      const srcset = $(el).attr('srcset') || '';
      // Extract first local path from srcset
      const localSrcset = srcset.split(',').map(s => s.trim().split(/\s+/)[0]).find(s => s.startsWith('/assets/'));
      if (localSrcset) {
        $(el).attr('src', localSrcset);
      }
    }
  });
  rewriteAttr('link[rel="stylesheet"]', 'href');
  rewriteAttr('link[rel="icon"]', 'href');
  rewriteAttr('link[rel="shortcut icon"]', 'href');
  rewriteAttr('link[rel="apple-touch-icon"]', 'href');
  rewriteAttr('video', 'poster');
  rewriteAttr('video', 'src');
  rewriteAttr('meta[property="og:image"]', 'content');
  rewriteAttr('meta[name="twitter:image"]', 'content');
  // Duda gallery lazy-load and data-image-url attributes
  rewriteAttr('img', 'data-src');
  rewriteAttr('[data-image-url]', 'data-image-url');
  rewriteAttr('[data-src]', 'data-src');
  rewriteAttr('[data-bg]', 'data-bg');
  // Rewrite logo source BEFORE nav extraction so built nav gets local path
  rewriteAttr('nav', 'data-logo-src');

  // Remove Duda CDN preconnect hints (irrelevant after localization)
  $('link[rel="preconnect"][href*="cdn-website.com"], link[rel="dns-prefetch"][href*="cdn-website.com"]').remove();

  // Strip Duda-internal data attributes that aren't used for display (keep HTML clean)
  $('[data-dm-image-path]').removeAttr('data-dm-image-path');
  $('[data-dm-multisize-attr]').removeAttr('data-dm-multisize-attr');

  // Rewrite inline style url()
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;
    style = style.replace(/url\(\s*['"]?\s*([^'")\s]+)\s*['"]?\s*\)/g, (full, ref) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return full;
      try {
        const absUrl = new URL(ref, pageUrl).href;
        if (assetMap.has(absUrl)) return `url('${assetMap.get(absUrl)}')`;
      } catch {}
      return full;
    });
    $(el).attr('style', style);
  });

  // Rewrite url() inside <style> tags
  $('style').each((_, el) => {
    let css = $(el).html();
    if (!css) return;
    css = css.replace(/url\(\s*['"]?\s*([^'")\s]+)\s*['"]?\s*\)/g, (full, ref) => {
      if (ref.startsWith('data:') || ref.startsWith('#')) return full;
      if (ref.includes('fonts.googleapis.com')) return full;
      try {
        const absUrl = new URL(ref, pageUrl).href;
        if (assetMap.has(absUrl)) return `url('${assetMap.get(absUrl)}')`;
      } catch {}
      return full;
    });
    $(el).html(css);
  });

  // Rewrite internal links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:') ||
        href.startsWith('javascript:') || href.startsWith('#')) return;
    try {
      const absUrl = new URL(href, pageUrl).href;
      if (isInternalUrl(absUrl)) {
        const u = new URL(absUrl);
        let path = u.pathname;
        if (path === '/' || path === '') {
          $(el).attr('href', `/${slug}/`);
        } else {
          path = path.replace(/\/+$/, '');
          $(el).attr('href', `/${slug}${path}/`);
        }
      }
    } catch {}
  });

  // Form replacement
  $('form').each((_, el) => {
    const $form = $(el);
    const action = ($form.attr('action') || '').toLowerCase();
    const html = $form.html() || '';
    const isContactForm =
      html.includes('name="name"') || html.includes('name="email"') ||
      html.includes('name="message"') || html.includes('name="phone"') ||
      html.includes('type="email"') ||
      action.includes('contact') || action.includes('submit') ||
      $form.find('textarea').length > 0;
    if (isContactForm) {
      $form.attr('action', 'https://forms.zingmigration.com/submit');
      $form.attr('method', 'POST');
      if ($form.find('input[name="site_id"]').length === 0) {
        $form.prepend(`<input type="hidden" name="site_id" value="${slug}">`);
      }
      if ($form.find('input[name="ownerEmail"]').length === 0) {
        $form.prepend(`<input type="hidden" name="ownerEmail" value="">`);
      }
    }
  });

  // Remove Duda popup overlays — these require JS to close; without it they block the page.
  // Use substring class matching to catch dmPopupPage, dmPopupInner, dmPopupMask, etc.
  $('#dmPopup').remove();
  $('[class*="dmPopupMask"]').remove();
  // Any element with dmPopup in the class that is position:fixed (the overlay)
  $('[class*="dmPopup"]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const cls = $(el).attr('class') || '';
    // Remove if it's a page-level popup (has position fixed inline OR is the mask)
    if (style.includes('fixed') || cls.includes('dmPopupMask') || cls.includes('dmPopupPage')) {
      $(el).remove();
    }
  });
  // Belt-and-suspenders: also hide via patch CSS (added at end of function)

  // Remove cookie banners
  ['#cookie-banner', '#cookie-consent', '#cookie-notice',
   '.cookie-banner', '.cookie-consent', '.cookie-notice', '.cookie-bar',
   '#gdpr', '.gdpr-banner', '#cc-banner',
   '#onetrust-banner', '.onetrust-consent', '#CybotCookiebotDialog',
   '[data-cookie-consent]', '[data-cookie-banner]',
  ].forEach(sel => $(sel).remove());

  // Remove chat widgets
  ['#tidio-chat', '#hubspot-messages-iframe-container',
   '#intercom-container', '.intercom-lightweight-app',
   '#drift-widget', '#tawk-widget',
   '[data-id="zsalesiq"]', '#livechat-compact-container',
  ].forEach(sel => $(sel).remove());

  // ── Rebuild nav — runs after all rewriteAttr so data-logo-src is already local ──
  const navData = extractNavData($);

  // Capture nav slugs from home page for the migration report
  if (homeNavSlugs === null) {
    const allNavItems = [...(navData.leftItems || []), ...(navData.rightItems || [])];
    const slugSet = new Set();
    const collectSlugs = (items) => {
      for (const item of items) {
        try {
          const path = new URL(item.href, rootUrl.origin).pathname.replace(/^\/|\/$/g, '');
          slugSet.add(path || ''); // '' = home
        } catch {}
        if (item.subs) collectSlugs(item.subs);
      }
    };
    collectSlugs(allNavItems);
    homeNavSlugs = [...slugSet];
  }
  const navEl = $('nav.main-navigation, nav.unifiednav, nav[class*="navigation"]').first();
  const navWrapper = navEl.parent().parent();
  const navWrapperTag = navWrapper.prop('tagName');
  const builtNav = buildCleanNav(navData, sitePrefix);
  if (navEl.length > 0) {
    if (navWrapperTag && ['DIV','SECTION','HEADER'].includes(navWrapperTag.toUpperCase())
        && navWrapper.find('nav').length === 1 && navWrapper.find('section, article').length === 0) {
      navWrapper.replaceWith(builtNav);
    } else {
      navEl.replaceWith(builtNav);
    }
  } else {
    $('body').prepend(builtNav);
  }

  // ── Duda patch CSS — fixes layout behaviors that relied on Duda JS ──
  // Injected last so it wins over Duda's inline styles.
  $('head').append(`<style id="px-duda-patch">
/* Fix: Duda sets overflow:hidden on body, preventing scroll */
body { overflow: auto !important; overflow-x: hidden !important; }
/* Fix: Duda sets body background to #eee; make transparent so page bg shows */
body { background-color: transparent !important; }
#dm DIV.dmOuter DIV.dmInner { background-color: rgba(255,255,255,1) !important; }
/* Fix: Duda gallery holder hidden until JS adds .photo-gallery-done — 
   Playwright adds it but just in case: */
.dmPhotoGalleryHolder { display: block !important; }
/* Fix: skrollr desktop class adds position:fixed to things — strip it */
html.skrollr { height: auto !important; overflow: auto !important; }
/* Fix: min-width:960px on dmInner clips narrow viewports */
.dmInner { min-width: 0 !important; }
/* Fix: Duda sometimes hides entire dmBody sections via JS classes */
.dmRespRow[style*="display:none"] { display: block !important; }
/* Rebuilt nav: remove any residual Duda nav spacing that conflicts */
.dmHeader .main-navigation, .dmHeader .unifiednav { display: none !important; }
/* Remove Duda popup overlays (position:fixed grey panels, require JS to dismiss) */
.dmPopup, .dmPopupMask, .dmPopupWrap { display: none !important; visibility: hidden !important; }
/* Rebuilt footer: reset Duda footer JS-dependent display */
.dmFooterContainer { display: block !important; }
.dmFooter { display: block !important; }
</style>`);

  return $.html();
}

/* ── Main ───────────────────────────────────────────────────────────── */

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ZING Duda Migration Tool v2 (Playwright)`);
  console.log(`  Source: ${rootUrl.href}`);
  console.log(`  Output: sites/${slug}/`);
  console.log(`  Max pages: ${maxPages} | Wait: ${waitMs}ms`);
  console.log(`${'='.repeat(60)}`);

  // Phase 1: Discover pages
  const pageUrls = await discoverPages();
  console.log(`  Will process up to ${Math.min(pageUrls.length, maxPages)} pages`);

  // Phase 2: Render pages with Playwright — 3 concurrent pages (was sequential)
  console.log('\n[2] Rendering pages with Playwright (3 concurrent)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });

  const CRAWL_CONCURRENCY = 3;
  const visited = new Set();
  const queue = [...pageUrls];
  let pageNum = 0;

  // Pre-open 3 browser pages with routing set up
  const pagePool = await Promise.all(
    Array.from({ length: CRAWL_CONCURRENCY }, async () => {
      const p = await context.newPage();
      await p.route('**/*', route => {
        if (isSkippableUrl(route.request().url())) return route.abort();
        return route.continue();
      });
      return p;
    })
  );

  // Pool worker — each holds a browser page and pulls URLs until queue is drained
  async function crawlWorker(page) {
    while (crawledPages.size < maxPages) {
      // Synchronously grab + mark next unvisited URL (no await = no race condition)
      let url = null;
      while (queue.length > 0) {
        const candidate = queue.shift();
        const norm = normalizeUrl(candidate);
        if (!norm || visited.has(norm) || redirectMap.has(norm)) continue;
        visited.add(norm); // mark before any await so other workers skip it
        url = candidate;
        break;
      }

      if (!url) {
        // Queue empty — wait briefly in case other workers add links, then exit
        await new Promise(r => setTimeout(r, 150));
        if (queue.length === 0) break;
        continue;
      }

      const myNum = ++pageNum;
      console.log(`  [${myNum}/${maxPages}] ${url}`);

      try {
        const { html, links, assetCount, finalUrl } = await renderPage(page, url);
        crawledPages.set(url, html);

        const normFinal = normalizeUrl(finalUrl || url);
        const normReq   = normalizeUrl(url);
        if (normFinal && normReq && normFinal !== normReq) {
          redirectMap.set(normFinal, normReq);
          console.log(`    ↳ redirected from ${finalUrl}`);
        }
        console.log(`    ${assetCount} assets captured`);

        for (const link of links) {
          const n = normalizeUrl(link);
          if (n && !visited.has(n) && isInternalUrl(link)) {
            queue.push(link);
          }
        }
      } catch (err) {
        console.log(`    ERROR: ${err.message}`);
        errors.push({ url, error: err.message });
      }
    }
  }

  // Run all 3 workers in parallel, close pages when done
  await Promise.all(pagePool.map(page =>
    crawlWorker(page).finally(() => page.close())
  ));

  await browser.close();
  console.log(`  Rendered ${crawledPages.size} pages, captured ${capturedAssets.size} unique assets`);

  // Phase 3: Save assets
  saveAssets();

  // Phase 3b: Secondary fetch pass — grab any images in crawled HTML that
  // network interception missed (lazy-loaded timing, etc.)
  console.log('\n[3b] Fetching missed images...');
  const missedUrls = new Set();
  for (const [, html] of crawledPages) {
    const $ = cheerio.load(html, { decodeEntities: false });
    // Scan all asset-bearing attributes, not just img[src]
    $('img[src], img[data-src], [data-image-url], [data-logo-src], [data-bg], link[rel="icon"], link[rel="apple-touch-icon"]').each((_, el) => {
      const candidates = [
        $(el).attr('src'),
        $(el).attr('data-src'),
        $(el).attr('data-image-url'),
        $(el).attr('data-logo-src'),
        $(el).attr('data-bg'),
        $(el).attr('href'),
      ].filter(Boolean);
      for (const src of candidates) {
        if (!src || src.startsWith('/') || src.startsWith('data:')) continue;
        try {
          const abs = new URL(src, rootUrl.href).href;
          const key = canonicalUrl(abs);
          if (!assetMap.has(key) && !assetMap.has(abs)) missedUrls.add(abs);
        } catch {}
      }
    });
  }
  console.log(`  Found ${missedUrls.size} missed image URLs — fetching...`);
  let fetched = 0;
  const missedArr = [...missedUrls];
  // Fetch in chunks of 5
  for (let i = 0; i < missedArr.length; i += 5) {
    await Promise.all(missedArr.slice(i, i + 5).map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'Referer': rootUrl.origin, 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('image') && !ct.includes('svg')) return;
        const buf = Buffer.from(await res.arrayBuffer());
        let ext = getExtension(url) || extFromContentType(ct) || '.jpg';
        const hash = hashUrl(url);
        const filename = hash + ext;
        const localPath = '/assets/' + filename;
        writeFileSync(join(assetsDir, filename), buf);
        assetMap.set(canonicalUrl(url), localPath);
        assetMap.set(url, localPath);
        fetched++;
      } catch { /* skip protected CDN images */ }
    }));
  }
  console.log(`  Fetched ${fetched} additional images`);

  // Phase 4: Process CSS
  await processCss();

  // Phase 5: Rewrite HTML and write output
  console.log('\n[5] Writing output...');
  mkdirSync(assetsDir, { recursive: true });

  let pagesWritten = 0;
  for (const [url, html] of crawledPages) {
    const filePath = urlToFilePath(url);
    const fullPath = join(siteDir, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });

    const rewritten = rewriteHtml(html, url, '/' + slug);
    // Fix asset paths: /assets/ is correct for CF Pages (site at root), but for
    // the local demo server (site at /slug/) we need relative paths so they resolve correctly.
    // Using relative paths works in BOTH contexts:
    //   index.html at root      → 'assets/hash.jpg' → resolves to /assets/hash.jpg (CF) or /slug/assets/hash.jpg (demo)
    //   about/index.html        → '../assets/hash.jpg' → same result in both contexts
    const depth = filePath.split('/').filter(p => p && p !== 'index.html').length;
    const relPrefix = depth > 0 ? '../'.repeat(depth) : '';
    const finalHtml = rewritten.replace(/(['"\(])\/assets\//g, `$1${relPrefix}assets/`);
    writeFileSync(fullPath, finalHtml);
    pagesWritten++;
    console.log(`  ${filePath}`);
  }

  // Phase 5b: Post-process output files — find any remaining external image/asset URLs
  // and fetch + inline them. Catches data-logo-src, srcset misses, query-string variants, etc.
  console.log('\n[5b] Post-processing: fetching remaining external assets...');
  const outputHtmlFiles = [];
  function collectHtmlFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'assets') collectHtmlFiles(p);
      else if (entry.isFile() && entry.name.endsWith('.html')) outputHtmlFiles.push(p);
    }
  }
  collectHtmlFiles(siteDir);

  // Match ANY external URL in HTML attributes that looks like an image/font/CSS
  const EXT_URL_RE = /(?:src|href|data-[a-z-]*src|data-logo-src|data-image-url|data-bg|data-background|content)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp|svg|ico|woff|woff2|ttf|css))(?:[^"]*)"/gi;

  let postFetched = 0;
  for (const filePath of outputHtmlFiles) {
    let content = readFileSync(filePath, 'utf8');
    const toFetch = new Map(); // originalMatch → url
    let m;
    EXT_URL_RE.lastIndex = 0;
    while ((m = EXT_URL_RE.exec(content)) !== null) {
      const url = m[1];
      if (isGoogleFont(url)) continue;
      if (!assetMap.has(url) && !assetMap.has(canonicalUrl(url))) toFetch.set(url, url);
    }

    if (toFetch.size === 0) continue;

    // Fetch each in parallel (limit 5)
    const toFetchArr = [...toFetch.keys()];
    for (let i = 0; i < toFetchArr.length; i += 5) {
      await Promise.all(toFetchArr.slice(i, i + 5).map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { 'Referer': rootUrl.origin, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) return;
          const buf = Buffer.from(await res.arrayBuffer());
          const ct = res.headers.get('content-type') || '';
          const ext = getExtension(url) || extFromContentType(ct) || '.bin';
          const hash = hashUrl(url);
          const filename = hash + ext;
          writeFileSync(join(assetsDir, filename), buf);
          const localPath = '/assets/' + filename;
          assetMap.set(url, localPath);
          assetMap.set(canonicalUrl(url), localPath);
          postFetched++;
        } catch { /* protected CDN asset — leave as-is */ }
      }));
    }

    // Replace all external asset URLs with local paths.
    // Build full assetMap including everything fetched in this pass, then
    // do plain string replacements (longest URL first to avoid partial matches).
    const sortedEntries = [...assetMap.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [origUrl, localPath] of sortedEntries) {
      if (content.includes(origUrl)) {
        // Plain string replace — safe with + and other special chars
        content = content.split(origUrl).join(localPath);
      }
    }
    writeFileSync(filePath, content);
  }
  console.log(`  Post-fetched ${postFetched} additional assets across ${outputHtmlFiles.length} pages`);

  // Write migration report
  const report = {
    slug,
    sourceUrl: rootUrl.href,
    crawledAt: new Date().toISOString(),
    approach: 'playwright-duda-v2',
    pagesWritten,
    assetsDownloaded: capturedAssets.size,
    assetsMapped: assetMap.size,
    durationMs: Date.now() - startTime,
    errors,
    // Nav slugs from the home page nav bar (path segments, '' = home).
    // Pixel uses this to distinguish primary nav pages from internal subpages.
    navSlugs: homeNavSlugs || [],
  };
  writeFileSync(join(siteDir, '_migrate-report.json'), JSON.stringify(report, null, 2));
  console.log('  _migrate-report.json');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Done in ${duration}s`);
  console.log(`  Pages: ${pagesWritten} | Assets: ${capturedAssets.size}`);
  if (errors.length > 0) console.log(`  Errors: ${errors.length}`);
  console.log(`  Output: sites/${slug}/`);
  console.log(`${'='.repeat(60)}\n`);

  return report;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
