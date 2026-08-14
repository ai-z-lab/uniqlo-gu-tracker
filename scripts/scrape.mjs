// Crawls each configured listing/category page (config/sources.json — e.g. a
// "sale" or "limited-time price" page), discovers every product linked from
// it, then renders each product page with a headless browser and extracts
// the price. Both UNIQLO and GU load price/stock client-side after the
// initial page load (confirmed for GU: it is not present in the static
// HTML), so plain HTML fetching cannot see it — Playwright actually runs
// the page's JavaScript first.
//
// Only inserts a new price_events row when the price differs from the most
// recently recorded one for that product. Run by .github/workflows/scrape.yml
// on a schedule (needs full internet access and a headless browser, so it
// must run in GitHub Actions rather than locally in a sandboxed shell).
//
// Debugging a single product: set DEBUG_URL to a product page URL and run
// this script. Instead of the normal sources.json loop, it renders just
// that one page and writes debug-output/page.html, debug-output/screenshot.png,
// and debug-output/responses.json (captured JSON network responses) so the
// actual DOM/API shape can be inspected without guessing.

import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEBUG_URL = process.env.DEBUG_URL || null;

if (!DEBUG_URL && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as environment variables.');
  process.exit(1);
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_MAX_PRODUCTS_PER_SOURCE = 200;
const REQUEST_DELAY_MS = 150;

// Hard time budgets. Every single Playwright call that touches the network
// or the browser process (goto, content, screenshot, context.close, even
// browser.launch) is wrapped in withTimeout below — not just goto — because
// any of them can hang indefinitely if the browser process or a page
// becomes unresponsive, and a page that never reaches "networkidle" (common
// with sites that keep analytics/polling connections open) must not be
// allowed to stall the whole run.
const PRODUCT_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 7_000;
const RENDER_SETTLE_MS = 1_000;
const CONTENT_TIMEOUT_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 8_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Races `promise` against a timer. Crucially, if `promise` loses the race
// and only rejects *later* (e.g. Playwright's own timeout fires after ours
// already did), that late rejection is swallowed here instead of becoming
// an unhandled promise rejection — which in Node can crash or wedge the
// process, and looks exactly like a silent hang in CI logs.
function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
    promise.catch(() => {});
  });
}

// --- Discovery: find product page links on a listing/category page ---
// (Listing pages have been confirmed to include product links in the
// server-rendered HTML, unlike price/stock, so a plain fetch is enough
// and much faster than rendering every listing page too.)

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja-JP,ja;q=0.9' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

function extractProductLinks(html, baseUrl) {
  const links = new Set();
  const hrefRegex = /href=["']([^"']*\/products\/[^"']*)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html))) {
    try {
      const absolute = new URL(match[1], baseUrl).toString().split('#')[0];
      links.add(absolute);
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...links];
}

async function discoverProductUrls(source) {
  const listingUrls = source.urls ?? (source.url ? [source.url] : []);
  const discovered = new Set();

  for (const listingUrl of listingUrls) {
    try {
      const html = await fetchHtml(listingUrl);
      for (const link of extractProductLinks(html, listingUrl)) discovered.add(link);
    } catch (err) {
      console.error(`[${source.id}] failed to load listing page ${listingUrl}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return [...discovered];
}

// --- Extraction helpers shared between rendered-DOM HTML and sniffed JSON ---

function findPriceInObject(obj, depth = 0) {
  if (depth > 8 || obj == null || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (/^(price|currentPrice|salePrice|sellingPrice|listPrice|base|amount)$/i.test(key)) {
      // UNIQLO/GU's own JSON-LD encodes price as a numeric *string*
      // (e.g. "1990"), so plain typeof-number checks miss it — accept
      // any value that cleanly parses to a plausible JPY amount.
      const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isNaN(numeric) && numeric > 0 && numeric < 1_000_000) {
        return numeric;
      }
    }
    if (value && typeof value === 'object') {
      const found = findPriceInObject(value, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

function parseJsonLdProducts(html) {
  const products = [];
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1].trim());
      const roots = Array.isArray(data) ? data : [data];
      for (const root of roots) {
        const candidates = root['@graph'] ? root['@graph'] : [root];
        for (const item of candidates) {
          if (item['@type'] === 'Product') products.push(item);
        }
      }
    } catch {
      // malformed JSON-LD block, try the next one
    }
  }
  return products;
}

function extractPriceFromOffers(offersLike) {
  if (!offersLike) return null;
  const offers = Array.isArray(offersLike) ? offersLike : [offersLike];
  for (const offer of offers) {
    if (!offer) continue;
    const price = offer.price ?? offer.lowPrice;
    if (price != null && !Number.isNaN(Number(price))) {
      return { price: Number(price), currency: offer.priceCurrency || 'JPY' };
    }
  }
  return null;
}

function extractPriceFromRenderedHtml(html) {
  for (const product of parseJsonLdProducts(html)) {
    // The price is usually on the product's own `offers`, but UNIQLO/GU put
    // it one level down instead: each color/size combination is a separate
    // entry in `hasVariant`, and *that* variant carries `offers.price`.
    const direct = extractPriceFromOffers(product.offers);
    if (direct) return direct;

    if (Array.isArray(product.hasVariant)) {
      for (const variant of product.hasVariant) {
        const variantPrice = extractPriceFromOffers(variant?.offers);
        if (variantPrice) return variantPrice;
      }
    }
  }

  const metaPrice =
    html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i) ||
    html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+property=["']product:price:amount["']/i);
  if (metaPrice) {
    const currencyMatch = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i);
    return { price: Number(metaPrice[1]), currency: currencyMatch ? currencyMatch[1] : 'JPY' };
  }

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const price = findPriceInObject(data);
      if (price != null) return { price, currency: 'JPY' };
    } catch {
      // ignore malformed payload
    }
  }

  return null;
}

function extractNameFromRenderedHtml(html) {
  for (const product of parseJsonLdProducts(html)) {
    if (product.name) return product.name;
  }
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1];
  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  if (titleTag) return titleTag[1].trim();
  return null;
}

function productIdFromUrl(url, brand) {
  const match = url.match(/\/products\/([A-Za-z0-9-]+)/);
  const code = match ? match[1] : Buffer.from(url).toString('base64url').slice(0, 24);
  return `${brand}-${code}`;
}

// --- Rendering a product page and extracting price/name from it ---

async function collectRenderedPage(
  page,
  url,
  productCode,
  candidateJsonResponses,
  { navTimeoutMs = NAV_TIMEOUT_MS, settleMs = RENDER_SETTLE_MS, onlyMatchingProductCode = true, log = () => {} } = {}
) {
  page.on('response', async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;
      if (onlyMatchingProductCode && productCode && !response.url().includes(productCode)) return;
      const json = await response.json();
      candidateJsonResponses.push({ url: response.url(), body: json });
    } catch {
      // response body not readable as JSON, or already consumed — ignore
    }
  });

  log(`goto start (timeout ${navTimeoutMs}ms)`);
  await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }), navTimeoutMs + 2_000, 'goto');
  log('goto done, settling');
  await page.waitForTimeout(settleMs);
  log('reading rendered content');
  const html = await withTimeout(page.content(), CONTENT_TIMEOUT_MS, 'page.content');
  log('content read');
  return html;
}

async function closeContextSafely(context, log = () => {}) {
  try {
    await withTimeout(context.close(), CONTEXT_CLOSE_TIMEOUT_MS, 'context.close');
  } catch (err) {
    log(`context.close did not finish cleanly: ${err.message}`);
  }
}

async function renderAndExtract(browser, url) {
  const productCode = (url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1];
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
  const page = await context.newPage();

  // The price/stock API response is sniffed as a fallback, restricted to
  // responses whose own URL mentions this product's code — otherwise a
  // recommendation/cross-sell widget's API call for a *different* product
  // could be mistaken for this one's price.
  const candidateJsonResponses = [];

  try {
    const renderedHtml = await withTimeout(
      collectRenderedPage(page, url, productCode, candidateJsonResponses),
      PRODUCT_TIMEOUT_MS,
      url
    );

    let result = extractPriceFromRenderedHtml(renderedHtml);
    if (!result) {
      for (const { body } of candidateJsonResponses) {
        const price = findPriceInObject(body);
        if (price != null) {
          result = { price, currency: 'JPY' };
          break;
        }
      }
    }

    if (!result) return null;

    const name = extractNameFromRenderedHtml(renderedHtml);
    return { price: result.price, currency: result.currency, name };
  } finally {
    await closeContextSafely(context);
  }
}

// --- Recording price events ---

async function fetchLatestRecordedPrice(productId) {
  const { data, error } = await supabase
    .from('price_events')
    .select('price, currency')
    .eq('product_id', productId)
    .order('scraped_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function processProductUrl(browser, url, brand) {
  const extracted = await renderAndExtract(browser, url);
  if (!extracted) {
    throw new Error('could not extract a price from the rendered page');
  }

  const productId = productIdFromUrl(url, brand);
  const latest = await fetchLatestRecordedPrice(productId);
  if (latest && latest.price === extracted.price && latest.currency === extracted.currency) {
    return { productId, outcome: 'unchanged' };
  }

  const { error: insertError } = await supabase.from('price_events').insert({
    product_id: productId,
    product_name: extracted.name,
    brand,
    url,
    price: extracted.price,
    currency: extracted.currency,
  });
  if (insertError) throw insertError;

  return { productId, outcome: 'changed', price: extracted.price, currency: extracted.currency };
}

async function processSource(browser, source) {
  const productUrls = await discoverProductUrls(source);
  console.log(`[${source.id}] discovered ${productUrls.length} product page(s)`);

  const cap = source.maxProducts ?? DEFAULT_MAX_PRODUCTS_PER_SOURCE;
  const targets = productUrls.slice(0, cap);
  if (productUrls.length > cap) {
    console.log(`[${source.id}] capping to first ${cap} product(s) (maxProducts)`);
  }

  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const url of targets) {
    try {
      const result = await processProductUrl(browser, url, source.brand);
      if (result.outcome === 'changed') {
        changed++;
        console.log(`[${source.id}] [${result.productId}] recorded new price event: ${result.price} ${result.currency}`);
      } else {
        unchanged++;
      }
    } catch (err) {
      failed++;
      console.error(`[${source.id}] failed for ${url}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return { discovered: productUrls.length, changed, unchanged, failed };
}

// --- Debug mode: render exactly one product and dump what we saw ---

async function debugSingleProduct(browser, url) {
  const outDir = path.join(SCRIPT_DIR, '..', 'debug-output');
  await mkdir(outDir, { recursive: true });

  const log = (msg) => console.log(`[debug] ${msg}`);

  const productCode = (url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1];
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
  const page = await context.newPage();
  const candidateJsonResponses = [];

  log(`navigating to ${url}`);

  // A per-step nav timeout of 15s, as requested, with a slightly larger
  // outer ceiling as a second line of defense — every step below (goto,
  // content, screenshot, context.close) is individually bounded too, so
  // nothing here can hang past its own explicit timeout even if this outer
  // one is somehow skipped.
  const DEBUG_NAV_TIMEOUT_MS = 15_000;
  let html = null;

  try {
    html = await withTimeout(
      collectRenderedPage(page, url, productCode, candidateJsonResponses, {
        navTimeoutMs: DEBUG_NAV_TIMEOUT_MS,
        settleMs: 2_000,
        onlyMatchingProductCode: false,
        log,
      }),
      DEBUG_NAV_TIMEOUT_MS + 5_000,
      url
    );
  } catch (err) {
    console.error(`[debug] navigation/render failed: ${err.message} — continuing to dump whatever state we have`);
  }

  if (html == null) {
    log('attempting a best-effort content read after the failure above');
    html = await withTimeout(page.content(), CONTENT_TIMEOUT_MS, 'page.content (fallback)').catch((err) => {
      console.error(`[debug] fallback content read also failed: ${err.message}`);
      return '<failed to read page content>';
    });
  }

  await writeFile(path.join(outDir, 'page.html'), html, 'utf-8');
  log('wrote page.html');

  await withTimeout(
    page.screenshot({ path: path.join(outDir, 'screenshot.png'), fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS }),
    SCREENSHOT_TIMEOUT_MS + 2_000,
    'screenshot'
  )
    .then(() => log('wrote screenshot.png'))
    .catch((err) => console.error(`[debug] screenshot failed: ${err.message}`));

  await writeFile(path.join(outDir, 'responses.json'), JSON.stringify(candidateJsonResponses, null, 2), 'utf-8');
  log('wrote responses.json');

  const matchingCount = productCode
    ? candidateJsonResponses.filter((r) => r.url.includes(productCode)).length
    : 0;
  log(
    `done: ${candidateJsonResponses.length} JSON response(s) captured, ${matchingCount} with the product code "${productCode}" in their URL`
  );

  await closeContextSafely(context, log);
}

async function main() {
  console.log('launching browser');
  const browser = await withTimeout(
    chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
    BROWSER_LAUNCH_TIMEOUT_MS,
    'chromium.launch'
  );
  console.log('browser launched');

  try {
    if (DEBUG_URL) {
      await debugSingleProduct(browser, DEBUG_URL);
      return;
    }

    const raw = await readFile(new URL('../config/sources.json', import.meta.url), 'utf-8');
    const sources = JSON.parse(raw);

    if (sources.length === 0) {
      console.log('No sources configured in config/sources.json — nothing to scrape.');
      return;
    }

    const totals = { discovered: 0, changed: 0, unchanged: 0, failed: 0 };

    for (const source of sources) {
      const result = await processSource(browser, source);
      totals.discovered += result.discovered;
      totals.changed += result.changed;
      totals.unchanged += result.unchanged;
      totals.failed += result.failed;
    }

    console.log(
      `Done. ${totals.discovered} discovered, ${totals.changed} changed, ${totals.unchanged} unchanged, ${totals.failed} failed.`
    );
    if (totals.discovered > 0 && totals.failed === totals.discovered) {
      process.exitCode = 1;
    }
  } finally {
    await withTimeout(browser.close(), 10_000, 'browser.close').catch((err) => {
      console.error(`browser.close did not finish cleanly: ${err.message}`);
    });
  }
}

main()
  .catch((err) => {
    console.error(`fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Playwright/Chromium can occasionally leave a stray handle open even
    // after browser.close() resolves, which would otherwise keep the Node
    // process (and the CI job) alive indefinitely. Force a clean exit.
    process.exit(process.exitCode ?? 0);
  });
