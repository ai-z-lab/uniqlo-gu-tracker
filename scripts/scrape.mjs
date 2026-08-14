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

import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULT_MAX_PRODUCTS_PER_SOURCE = 200;
const REQUEST_DELAY_MS = 250;
const PAGE_NAVIGATION_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 8_000;
const RENDER_SETTLE_MS = 1_200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    if (
      /^(price|currentPrice|salePrice|sellingPrice|listPrice|base|amount)$/i.test(key) &&
      typeof value === 'number' &&
      value > 0 &&
      value < 1_000_000
    ) {
      return value;
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

function extractPriceFromRenderedHtml(html) {
  for (const product of parseJsonLdProducts(html)) {
    if (!product.offers) continue;
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const offer of offers) {
      const price = offer.price ?? offer.lowPrice;
      if (price != null) {
        return { price: Number(price), currency: offer.priceCurrency || 'JPY' };
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

async function renderAndExtract(browser, url) {
  const productCode = (url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1];

  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
  const page = await context.newPage();

  // The price/stock API response is sniffed as a fallback, restricted to
  // responses whose own URL mentions this product's code — otherwise a
  // recommendation/cross-sell widget's API call for a *different* product
  // could be mistaken for this one's price.
  const candidateJsonResponses = [];
  page.on('response', async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;
      if (productCode && !response.url().includes(productCode)) return;
      const json = await response.json();
      candidateJsonResponses.push(json);
    } catch {
      // response body not readable as JSON, or already consumed — ignore
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_NAVIGATION_TIMEOUT_MS });
    try {
      await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
    } catch {
      // some pages keep background polling alive and never go idle; that's fine
    }
    await page.waitForTimeout(RENDER_SETTLE_MS);

    const renderedHtml = await page.content();

    let result = extractPriceFromRenderedHtml(renderedHtml);
    if (!result) {
      for (const json of candidateJsonResponses) {
        const price = findPriceInObject(json);
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
    await context.close();
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

async function main() {
  const raw = await readFile(new URL('../config/sources.json', import.meta.url), 'utf-8');
  const sources = JSON.parse(raw);

  if (sources.length === 0) {
    console.log('No sources configured in config/sources.json — nothing to scrape.');
    return;
  }

  const browser = await chromium.launch();
  const totals = { discovered: 0, changed: 0, unchanged: 0, failed: 0 };

  try {
    for (const source of sources) {
      const result = await processSource(browser, source);
      totals.discovered += result.discovered;
      totals.changed += result.changed;
      totals.unchanged += result.unchanged;
      totals.failed += result.failed;
    }
  } finally {
    await browser.close();
  }

  console.log(
    `Done. ${totals.discovered} discovered, ${totals.changed} changed, ${totals.unchanged} unchanged, ${totals.failed} failed.`
  );
  if (totals.discovered > 0 && totals.failed === totals.discovered) {
    process.exitCode = 1;
  }
}

main();
