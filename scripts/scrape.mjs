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

// Best-effort category classification from the product name alone (there is
// no dedicated category field available from discovery or the product page
// extraction). Ordered lists, first matching keyword wins; unmatched
// products fall back to a catch-all bucket. This is inherently approximate —
// see README for how to adjust it.
// 'ワンピース' is checked first in both brands' rule lists on purpose: real
// product names commonly prefix it with another garment word to describe the
// fabric/silhouette (e.g. "リブニットワンピース", "コットンシャツワンピース"),
// which would otherwise get caught by that other word's category (トップス,
// シャツ) before ever reaching a ワンピース rule later in the list.
const CATEGORY_KEYWORDS = {
  uniqlo: [
    ['ワンピース', ['ワンピース', 'オールインワン', 'サロペット', 'ジャンプスーツ']],
    ['インナー・ルームウェア', ['インナー', 'ルームウェア', 'パジャマ', '肌着', 'スリープ', 'ブラ', 'ショーツ', 'エアリズム', 'キャミソール']],
    ['アウター', ['ジャケット', 'コート', 'ブルゾン', 'ダウン', 'アウター', 'マウンテンパーカ', 'ベスト', 'フリース']],
    ['ビジネス', ['スーツ', 'セットアップ', 'スラックス', 'ビジネス', 'ネクタイ']],
    ['シャツ', ['シャツ', 'ブラウス']],
    ['パンツ', ['パンツ', 'デニム', 'ジーンズ', 'スカート', 'ショートパンツ', 'ジョガー', 'キュロット']],
    ['トップス', ['Tシャツ', 'カットソー', 'ニット', 'セーター', 'スウェット', 'パーカ', 'カーディガン', 'ポロシャツ', 'トップス', 'プルオーバー']],
  ],
  gu: [
    ['ワンピース', ['ワンピース', 'オールインワン', 'サロペット', 'ジャンプスーツ']],
    ['アウター・パンツ', ['ジャケット', 'コート', 'ブルゾン', 'ダウン', 'アウター', 'パンツ', 'デニム', 'ジーンズ', 'スカート', 'ショートパンツ', 'ショーツ', 'ベスト', 'フリース', 'キュロット']],
    ['トップス', ['Tシャツ', 'カットソー', 'ニット', 'セーター', 'スウェット', 'シャツ', 'ブラウス', 'パーカ', 'カーディガン', 'トップス', 'プルオーバー']],
  ],
};
const FALLBACK_CATEGORY = { uniqlo: 'その他', gu: 'グッズ・その他' };

function categorizeProduct(brand, name) {
  const fallback = FALLBACK_CATEGORY[brand] || 'その他';
  if (!name) return fallback;
  const rules = CATEGORY_KEYWORDS[brand] || [];
  for (const [category, keywords] of rules) {
    if (keywords.some((keyword) => name.includes(keyword))) return category;
  }
  return fallback;
}

// event_type priority: a product this tracker has never seen before, or one
// whose price just went up, is more notable than the default "why is this on
// the dashboard at all" bucket implied by which listing page it came from.
//
// This tracker only crawls the 値下げ一覧/期間限定価格一覧 listing pages, never
// an official new-arrivals page, so "never seen before" does NOT mean
// "genuinely just released" — it only means "first time this tracker
// happened to detect it". 'first_markdown'/'first_limited' name that
// honestly, split by which listing page it was first found on.
function classifyEventType({ isNewProduct, previousPrice, currentPrice, listingType }) {
  if (isNewProduct) return listingType === 'limited' ? 'first_limited' : 'first_markdown';
  if (previousPrice != null && currentPrice > previousPrice) return 'price_up';
  return listingType === 'limited' ? 'limited' : 'markdown';
}

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

// Matches schema.org Product *and* ProductGroup — the canonical schema.org
// pattern for a page with size/color variants is actually a root
// ProductGroup whose hasVariant array holds the individual Product entries,
// not a Product with hasVariant. Also tolerates @type being an array
// (some sites emit e.g. @type: ["Product"]).
function isProductLikeType(type) {
  const types = Array.isArray(type) ? type : [type];
  return types.includes('Product') || types.includes('ProductGroup');
}

function parseJsonLdProducts(html, log = () => {}) {
  const products = [];
  const scriptMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  log(`found ${scriptMatches.length} <script type="application/ld+json"> block(s)`);

  scriptMatches.forEach((match, i) => {
    let data;
    try {
      data = JSON.parse(match[1].trim());
    } catch (err) {
      log(`  [ld+json #${i}] JSON.parse failed: ${err.message}`);
      return;
    }
    const roots = Array.isArray(data) ? data : [data];
    for (const root of roots) {
      const candidates = root['@graph'] ? root['@graph'] : [root];
      for (const item of candidates) {
        const type = item && item['@type'];
        if (isProductLikeType(type)) {
          products.push(item);
          log(
            `  [ld+json #${i}] found @type=${JSON.stringify(type)}, ` +
              `has offers=${Boolean(item.offers)}, hasVariant=${Array.isArray(item.hasVariant) ? item.hasVariant.length : false}`
          );
        } else if (type) {
          log(`  [ld+json #${i}] skipping @type=${JSON.stringify(type)} (not Product/ProductGroup)`);
        }
      }
    }
  });

  return products;
}

// schema.org's Offer.priceValidUntil is exactly "the date after which the
// price is no longer available" — precisely what a UNIQLO/GU "期間限定価格"
// end date is. Returned as a plain YYYY-MM-DD string (postgres `date`
// column), or null if absent/unparseable.
function parsePriceValidUntil(value) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function extractPriceFromOffers(offersLike, log = () => {}, source = 'offers') {
  if (!offersLike) {
    log(`    ${source}: absent`);
    return null;
  }
  const offers = Array.isArray(offersLike) ? offersLike : [offersLike];
  for (const [i, offer] of offers.entries()) {
    if (!offer) continue;
    const price = offer.price ?? offer.lowPrice;
    if (price != null && !Number.isNaN(Number(price))) {
      const priceValidUntil = parsePriceValidUntil(offer.priceValidUntil);
      log(
        `    ${source}[${i}]: price=${JSON.stringify(price)} (type ${typeof price}), ` +
          `priceValidUntil=${JSON.stringify(offer.priceValidUntil ?? null)} -> using price` +
          (priceValidUntil ? ` (end date ${priceValidUntil})` : '')
      );
      return { price: Number(price), currency: offer.priceCurrency || 'JPY', limitedPriceEndDate: priceValidUntil };
    }
    log(`    ${source}[${i}]: no usable price field (keys: ${Object.keys(offer).join(', ')})`);
  }
  return null;
}

// Fallback when JSON-LD has no priceValidUntil at all: look for a Japanese
// "◯月◯日まで" phrase anywhere in the rendered page. Approximate on purpose
// (no year is usually given on-page) — assumes the *next* upcoming
// occurrence of that month/day from today, which is the only sane reading
// of a listing that says e.g. "5月20日まで" without a year.
function extractLimitedPriceEndDateFromText(html, log = () => {}) {
  const match = html.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d<]{0,6}まで/);
  if (!match) {
    log('  no "◯月◯日まで" text pattern found either');
    return null;
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const now = new Date();
  let year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  // If that month/day already passed (with a day of slack), it must mean
  // next year's occurrence.
  if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) year += 1;

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  log(`  fallback text pattern matched "${match[0].trim()}" -> ${iso}`);
  return iso;
}

// Applies the "◯月◯日まで" text fallback whenever JSON-LD didn't already
// give us an end date, regardless of which strategy found the price itself.
function withLimitedPriceEndDateFallback(result, html, log) {
  if (!result) return result;
  if (result.limitedPriceEndDate) return result;
  return { ...result, limitedPriceEndDate: extractLimitedPriceEndDateFromText(html, log) };
}

// Extracts plausible variant-identifying tokens from a product URL: every
// query-string value (colorDisplayCode, sizeDisplayCode, etc. — the exact
// param names vary by site/brand and aren't worth hardcoding) plus any path
// segment after "/products/<code>" (some product pages encode the variant
// there instead of, or in addition to, query params). Short tokens are
// dropped since they're too likely to false-positive match unrelated JSON
// fields elsewhere in a variant object.
function variantTokensFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const tokens = new Set();
  for (const value of parsed.searchParams.values()) {
    if (value.length >= 2) tokens.add(value);
  }
  const pathMatch = parsed.pathname.match(/\/products\/[A-Za-z0-9-]+(\/.*)?$/);
  if (pathMatch?.[1]) {
    for (const segment of pathMatch[1].split('/').filter(Boolean)) {
      if (segment.length >= 2) tokens.add(segment);
    }
  }
  return [...tokens];
}

// Best-effort: among a ProductGroup's hasVariant entries, find the one that
// actually corresponds to the requested URL, by looking for its identifying
// tokens (see variantTokensFromUrl) inside that variant's own serialized
// JSON-LD — schema.org doesn't fix which field (sku, url, gtin13, color, ...)
// carries the color/size code, so this searches the whole object rather than
// a hardcoded field name. Requires *every* token to be present (not just
// any one): a size code alone is typically shared across every color, so
// matching on that in isolation would happily "match" the wrong color's
// variant as long as it has the right size — only a variant carrying the
// full combination (e.g. both color AND size code) is treated as identified.
// Returns null (never a guess) when no variant satisfies all tokens, so the
// caller can fall back to its own explicit default instead of silently
// trusting a coincidental partial match.
function findMatchingVariant(hasVariant, url) {
  const tokens = variantTokensFromUrl(url);
  if (tokens.length === 0) return null;
  return (
    hasVariant.find((variant) => {
      if (!variant) return false;
      const haystack = JSON.stringify(variant);
      return tokens.every((token) => haystack.includes(token));
    }) ?? null
  );
}

function extractPriceFromRenderedHtml(html, url, log = () => {}) {
  const products = parseJsonLdProducts(html, log);
  log(`extractPriceFromRenderedHtml: ${products.length} Product/ProductGroup candidate(s) from JSON-LD`);

  for (const [i, product] of products.entries()) {
    log(`  candidate #${i} (@type=${JSON.stringify(product['@type'])}):`);
    // name is taken from this SAME candidate the price is about to come from
    // (falling back to the containing product's own name for a variant that
    // doesn't carry its own) — a page can legitimately have more than one
    // Product/ProductGroup JSON-LD block (e.g. a "related products" widget
    // also emits one for SEO), and independently re-scanning parseJsonLdProducts()
    // for "the first entry with a .name" would risk returning a name from a
    // *different* block than the one the price was actually taken from.
    const direct = extractPriceFromOffers(product.offers, log, `candidate #${i} .offers`);
    if (direct) return withLimitedPriceEndDateFallback({ ...direct, name: product.name ?? null }, html, log);

    if (Array.isArray(product.hasVariant)) {
      log(`  candidate #${i}: checking ${product.hasVariant.length} hasVariant entries`);

      // A ProductGroup's root .offers (checked above) is often absent, in
      // which case the color/size actually requested by `url` only exists
      // inside one specific hasVariant entry. Try to find *that* entry
      // first — otherwise the loop below just takes whichever variant
      // happens to be array index 0, which silently returns a real price
      // for the WRONG color/size whenever that isn't the one being viewed
      // (e.g. a wide-leg cargo pants page where one colorway has its own
      // clearance markdown and others don't).
      const matched = findMatchingVariant(product.hasVariant, url);
      if (matched) {
        log(`  candidate #${i}: matched a hasVariant entry to the requested URL (shared identifying token)`);
        const matchedPrice = extractPriceFromOffers(matched.offers, log, `candidate #${i} .hasVariant[matched].offers`);
        if (matchedPrice) {
          return withLimitedPriceEndDateFallback({ ...matchedPrice, name: matched.name ?? product.name ?? null }, html, log);
        }
        log(`  candidate #${i}: matched variant had no usable price, falling back to first-available`);
      } else {
        log(
          `  candidate #${i}: could not match any hasVariant entry to the requested URL — falling back to the ` +
            `first variant with a usable price, which may not be the color/size this URL actually shows`
        );
      }

      for (const [v, variant] of product.hasVariant.entries()) {
        const variantPrice = extractPriceFromOffers(variant?.offers, log, `candidate #${i} .hasVariant[${v}].offers`);
        if (variantPrice) {
          return withLimitedPriceEndDateFallback({ ...variantPrice, name: variant?.name ?? product.name ?? null }, html, log);
        }
      }
    } else {
      log(`  candidate #${i}: no hasVariant array`);
    }
  }

  const metaPrice =
    html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i) ||
    html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+property=["']product:price:amount["']/i);
  if (metaPrice) {
    log(`falling back to product:price:amount meta tag: ${metaPrice[1]}`);
    const currencyMatch = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i);
    return withLimitedPriceEndDateFallback(
      { price: Number(metaPrice[1]), currency: currencyMatch ? currencyMatch[1] : 'JPY' },
      html,
      log
    );
  }
  log('no product:price:amount meta tag found');

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    log('found __NEXT_DATA__ script, searching it for a price field');
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const price = findPriceInObject(data);
      if (price != null) {
        log(`__NEXT_DATA__: found price=${price}`);
        return withLimitedPriceEndDateFallback({ price, currency: 'JPY' }, html, log);
      }
      log('__NEXT_DATA__: parsed OK but no plausible price field found');
    } catch (err) {
      log(`__NEXT_DATA__: JSON.parse failed: ${err.message}`);
    }
  } else {
    log('no __NEXT_DATA__ script found');
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

async function renderAndExtract(browser, url, { log = () => {}, renderOptions = {}, outerTimeoutMs = PRODUCT_TIMEOUT_MS } = {}) {
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
      collectRenderedPage(page, url, productCode, candidateJsonResponses, { log, ...renderOptions }),
      outerTimeoutMs,
      url
    );

    log('--- price extraction from rendered HTML (JSON-LD / meta / __NEXT_DATA__) ---');
    let result = extractPriceFromRenderedHtml(renderedHtml, url, log);
    if (!result) {
      log(`--- rendered HTML gave nothing, trying ${candidateJsonResponses.length} sniffed JSON response(s) ---`);
      for (const { url: responseUrl, body } of candidateJsonResponses) {
        const price = findPriceInObject(body);
        log(`  response ${responseUrl}: ${price != null ? `found price=${price}` : 'no plausible price field'}`);
        if (price != null) {
          result = { price, currency: 'JPY' };
          break;
        }
      }
    }

    if (!result) {
      log('extraction FAILED: no price found via any strategy');
      return null;
    }

    // Prefer the name captured from the exact same JSON-LD candidate as the
    // price (see extractPriceFromRenderedHtml); only fall back to an
    // independent og:title/<title> scan when the price came from a path
    // that has no associated name of its own (meta tag / __NEXT_DATA__ /
    // sniffed JSON response).
    const name = result.name ?? extractNameFromRenderedHtml(renderedHtml);
    log(
      `extraction SUCCEEDED: price=${result.price} ${result.currency}, name=${JSON.stringify(name)}, ` +
        `limitedPriceEndDate=${JSON.stringify(result.limitedPriceEndDate ?? null)}`
    );
    return { price: result.price, currency: result.currency, name, limitedPriceEndDate: result.limitedPriceEndDate ?? null };
  } finally {
    await closeContextSafely(context, log);
  }
}

// --- Recording price events ---

async function fetchLatestRecordedPrice(productId) {
  const { data, error } = await supabase
    .from('price_events')
    .select('id, price, currency, scraped_at')
    .eq('product_id', productId)
    .order('scraped_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

// Same UTC calendar day, i.e. was the last row for this product recorded on
// today's date already? Used to collapse re-runs (manual re-triggers,
// testing, etc.) onto a single row per product per day instead of piling up
// multiple same-day points that make the price-history chart look jagged
// for no real reason.
function isSameUtcCalendarDay(isoA, isoB) {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

// Records one observation per product on *every* scrape (not only when the
// price changes): the dashboard reads only the latest row per product_id to
// decide which section/category it currently belongs to, so a product that
// is still discounted-but-unchanged must keep producing a fresh 'markdown'/
// 'limited' row, or it would silently vanish from the dashboard after its
// first price drop. Price history for the sparkline chart is a side benefit
// of the same rows. If a row for this product already exists from *today*,
// it is updated in place rather than inserted again (see
// isSameUtcCalendarDay) so repeated runs on the same day don't create
// multiple points on the same day.
//
// `productRunState` is shared across the *entire* run (every source), not
// just this one. discoverProductUrls dedupes by exact URL, but listing pages
// commonly link the same base product once per color/size variant
// (?colorDisplayCode=... etc.), and productIdFromUrl collapses all of those
// down to one product_id. Different variants of the same product_id can
// genuinely carry different real prices — most commonly because the same
// product is cross-listed on both the "sale" and "limited-time-price"
// sources at once, each showing its own price for that context. Recording
// whichever occurrence happened to be discovered/processed first made the
// price history flip-flop between the two depending on iteration order,
// which looked like spurious 'price_up' swings on the dashboard. Instead,
// every occurrence is rendered, and only the lowest price seen this run is
// kept — ties keep whichever was recorded first, since it makes no
// difference which. isNewProduct/previousPrice for a superseding (lower-
// price) occurrence reuse what the *first* occurrence this run already
// determined from the pre-run DB state, rather than re-querying (which would
// now see that first occurrence's own just-written row and wrongly treat the
// product as not-new / already-tracked).
async function processProductUrl(browser, url, source, productRunState) {
  const productId = productIdFromUrl(url, source.brand);

  const extracted = await renderAndExtract(browser, url);
  if (!extracted) {
    throw new Error('could not extract a price from the rendered page');
  }

  const existing = productRunState.get(productId);
  if (existing && extracted.price >= existing.price) {
    return { productId, skipped: true };
  }

  const nowIso = new Date().toISOString();

  let isNewProduct;
  let previousPrice;
  let previousCurrency;
  let existingRowId;
  if (existing) {
    ({ isNewProduct, previousPrice, previousCurrency } = existing);
    existingRowId = existing.rowId;
  } else {
    const latest = await fetchLatestRecordedPrice(productId);
    isNewProduct = !latest;
    previousPrice = latest?.price ?? null;
    previousCurrency = latest?.currency ?? null;
    existingRowId = latest && isSameUtcCalendarDay(latest.scraped_at, nowIso) ? latest.id : null;
  }

  const category = categorizeProduct(source.brand, extracted.name);
  const eventType = classifyEventType({
    isNewProduct,
    previousPrice,
    currentPrice: extracted.price,
    listingType: source.listingType,
  });

  const row = {
    product_id: productId,
    product_name: extracted.name,
    brand: source.brand,
    gender: source.gender ?? null,
    category,
    event_type: eventType,
    url,
    price: extracted.price,
    currency: extracted.currency,
    limited_price_end_date: extracted.limitedPriceEndDate ?? null,
    scraped_at: nowIso,
  };

  let rowId;
  if (existingRowId) {
    const { error: updateError } = await supabase.from('price_events').update(row).eq('id', existingRowId);
    if (updateError) throw updateError;
    rowId = existingRowId;
  } else {
    const { data, error: insertError } = await supabase.from('price_events').insert(row).select('id').single();
    if (insertError) throw insertError;
    rowId = data.id;
  }

  // Only recorded as done-this-run on success, so if this attempt failed a
  // later occurrence of the same product still gets a chance.
  productRunState.set(productId, { price: extracted.price, currency: extracted.currency, rowId, isNewProduct, previousPrice, previousCurrency });

  const priceChanged = isNewProduct || previousPrice !== extracted.price || previousCurrency !== extracted.currency;
  return { productId, eventType, priceChanged, price: extracted.price, currency: extracted.currency };
}

async function processSource(browser, source, productRunState) {
  const productUrls = await discoverProductUrls(source);
  console.log(`[${source.id}] discovered ${productUrls.length} product page(s)`);

  const cap = source.maxProducts ?? DEFAULT_MAX_PRODUCTS_PER_SOURCE;
  const targets = productUrls.slice(0, cap);
  if (productUrls.length > cap) {
    console.log(`[${source.id}] capping to first ${cap} product(s) (maxProducts)`);
  }

  let recorded = 0;
  let priceChanged = 0;
  let failed = 0;
  let skipped = 0;
  const byEventType = { first_markdown: 0, first_limited: 0, markdown: 0, limited: 0, price_up: 0 };

  for (const url of targets) {
    try {
      const result = await processProductUrl(browser, url, source, productRunState);
      if (result.skipped) {
        skipped++;
      } else {
        recorded++;
        byEventType[result.eventType] = (byEventType[result.eventType] ?? 0) + 1;
        if (result.priceChanged) {
          priceChanged++;
          console.log(
            `[${source.id}] [${result.productId}] ${result.eventType}: ${result.price} ${result.currency}`
          );
        }
      }
    } catch (err) {
      failed++;
      console.error(`[${source.id}] failed for ${url}: ${err.message}`);
    }
    // A render/request always happens above (success, skip-after-render, or
    // failure alike), so always rate-limit before the next one.
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `[${source.id}] recorded ${recorded}/${productUrls.length} ` +
      `(first_markdown=${byEventType.first_markdown}, first_limited=${byEventType.first_limited}, ` +
      `markdown=${byEventType.markdown}, limited=${byEventType.limited}, price_up=${byEventType.price_up}), ` +
      `${priceChanged} price change(s), ${skipped} skipped (equal-or-higher price than an earlier occurrence this run), ${failed} failed`
  );

  return { discovered: productUrls.length, recorded, priceChanged, skipped, failed };
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
    `captured ${candidateJsonResponses.length} JSON response(s), ${matchingCount} with the product code "${productCode}" in their URL`
  );

  // Run the *actual* extraction logic (same functions the real scraper
  // uses) against what we just rendered, logging every decision point, so
  // a mismatch between "the data is clearly in page.html" and "the script
  // still says it can't find it" is visible directly instead of guessed at.
  const traceLines = [];
  const trace = (msg) => {
    traceLines.push(msg);
    log(`[extract] ${msg}`);
  };

  trace('--- price extraction from rendered HTML (JSON-LD / meta / __NEXT_DATA__) ---');
  let result = extractPriceFromRenderedHtml(html, url, trace);
  if (!result) {
    trace(`--- rendered HTML gave nothing, trying ${candidateJsonResponses.length} sniffed JSON response(s) ---`);
    for (const { url: responseUrl, body } of candidateJsonResponses) {
      const price = findPriceInObject(body);
      trace(`  response ${responseUrl}: ${price != null ? `found price=${price}` : 'no plausible price field'}`);
      if (price != null) {
        result = { price, currency: 'JPY' };
        break;
      }
    }
  }

  if (result) {
    const name = result.name ?? extractNameFromRenderedHtml(html);
    trace(
      `RESULT: price=${result.price} ${result.currency}, name=${JSON.stringify(name)}, ` +
        `limitedPriceEndDate=${JSON.stringify(result.limitedPriceEndDate ?? null)}`
    );
  } else {
    trace('RESULT: no price found via any strategy');
  }

  await writeFile(path.join(outDir, 'extraction-trace.txt'), traceLines.join('\n'), 'utf-8');
  log('wrote extraction-trace.txt');

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

    const totals = { discovered: 0, recorded: 0, priceChanged: 0, skipped: 0, failed: 0 };
    // Shared across every source in this run — see processProductUrl for why.
    const productRunState = new Map();

    for (const source of sources) {
      const result = await processSource(browser, source, productRunState);
      totals.discovered += result.discovered;
      totals.recorded += result.recorded;
      totals.priceChanged += result.priceChanged;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
    }

    console.log(
      `Done. ${totals.discovered} discovered, ${totals.recorded} recorded ` +
        `(${totals.priceChanged} with a price change), ${totals.skipped} skipped as duplicates, ${totals.failed} failed.`
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
