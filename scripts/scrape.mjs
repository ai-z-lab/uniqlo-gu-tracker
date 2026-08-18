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
// Debugging: set DEBUG_URL and run this script. Instead of the normal
// sources.json loop it renders just those pages and writes, per product,
// debug-output/page.html, screenshot.png, responses.json (captured JSON
// network responses) and extraction-trace.txt, so the actual DOM/API shape
// and every extraction decision can be inspected without guessing.
// DEBUG_URL takes one or more comma/whitespace-separated URLs, and each may
// be either a product page or a listing page (値下げ/期間限定価格一覧) — a
// listing is expanded into the first N products linked from it (N from a
// "sample=N" token anywhere in DEBUG_URL, or the DEBUG_SAMPLE env var,
// default 3), which is how "found on the 期間限定 listing but extracted the
// regular price" bugs get caught.

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
// Outer cap for one product. Kept at or above the sum of the individually
// bounded steps below (goto 7s +2s slack, price API 4s, settle 1s, content
// read 5s) — set any lower and it fires first on a merely slow page, which
// would make each of those inner budgets unreachable and turn "the price API
// was still in flight" into a failed product.
const PRODUCT_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 7_000;
const RENDER_SETTLE_MS = 1_000;
// How long to keep waiting, after navigation resolves, for the brand's own
// price API response to arrive — the member/期間限定 price exists nowhere else
// (see extractPriceFromPriceApiBody). The wait ends the moment that response
// lands, so a product whose price API is quick costs nothing extra; only
// products where it never arrives pay the full budget.
const PRICE_API_WAIT_MS = 4_000;
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

// A single Offer, or an ARRAY of them — UNIQLO/GU product pages can list
// more than one Offer for the same item (observed: a regular price and a
// lower "アプリ会員特別価格"/period-limited member price as separate Offer
// entries). Scans *every* offer and keeps the lowest valid price rather than
// stopping at the first one found — taking "whichever offer happens to be
// first in the array" previously meant the reported price depended on array
// order, not on which price a shopper would actually pay, and could surface
// the higher regular price instead of the actual current lowest one. This
// matches the rest of the tracker's philosophy of always recording the
// lowest currently-available price (see the cross-source dedup in
// processProductUrl).
function extractPriceFromOffers(offersLike, log = () => {}, source = 'offers') {
  if (!offersLike) {
    log(`    ${source}: absent`);
    return null;
  }
  const offers = Array.isArray(offersLike) ? offersLike : [offersLike];
  let best = null;
  for (const [i, offer] of offers.entries()) {
    if (!offer) continue;
    const price = offer.price ?? offer.lowPrice;
    const numeric = price != null ? Number(price) : NaN;
    // Reject non-positive/absurd values the same way findPriceInObject does,
    // so a $0 "問い合わせ" placeholder offer can't win by virtue of being
    // numerically the lowest.
    if (Number.isNaN(numeric) || numeric <= 0 || numeric >= 1_000_000) {
      log(`    ${source}[${i}]: no usable price field (keys: ${Object.keys(offer).join(', ')})`);
      continue;
    }
    const priceValidUntil = parsePriceValidUntil(offer.priceValidUntil);
    log(
      `    ${source}[${i}]: price=${JSON.stringify(price)} (type ${typeof price}), ` +
        `priceValidUntil=${JSON.stringify(offer.priceValidUntil ?? null)}` +
        (priceValidUntil ? ` (end date ${priceValidUntil})` : '')
    );
    if (!best || numeric < best.price) {
      best = { price: numeric, currency: offer.priceCurrency || 'JPY', limitedPriceEndDate: priceValidUntil };
    }
  }
  if (best) {
    log(`    ${source}: using lowest of ${offers.length} offer(s): ${best.price} ${best.currency}`);
  } else {
    log(`    ${source}: no usable price found among ${offers.length} offer(s)`);
  }
  return best;
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

// --- The brand's own price API (the only place a member/限定 price exists) ---
//
// Both uniqlo.com and gu-global.com render the price client-side from
//   /api/commerce/v5/ja/products/<code>/price-groups/00/l2s?withPrices=true&withMemberPricing=true
// whose payload is:
//   result.l2s:    [{ l2Id, color: { code, displayCode }, size: { code, displayCode }, … }]
//   result.prices: { <l2Id>: { guest:  { base: { currency, value }, promo: { … } },
//                              member: { base: { currency, value }, promo: { … } } } }
//
// The JSON-LD embedded in the page only ever carries the *guest* price. When a
// product is on 期間限定価格/アプリ会員特別価格, the discounted amount the site
// actually advertises exists solely in `member` here — confirmed on GU
// サテンキャミソール E361445-000, where the page shows「¥1,490 アプリ会員特別価格
// ¥990」, JSON-LD says 1490, and this API says guest.base=1490, member.base=990.
// Reading only the JSON-LD is what made the dashboard show regular prices for
// products found on the 期間限定価格一覧.
function isPriceApiBody(body) {
  const result = body?.result;
  return Boolean(result && Array.isArray(result.l2s) && result.prices && typeof result.prices === 'object');
}

// Unlike JSON-LD's `priceCurrency`, which is the plain string "JPY", the
// price API nests currency as its own object next to `value`. Stringifying
// that object straight into the row would put "[object Object]" in
// price_events.currency (and into every price the dashboard formats), so
// only a real string is ever accepted and anything else falls back to JPY —
// both storefronts this tracker crawls are the Japanese ones.
function currencyCodeFromPriceNode(node) {
  const currency = node?.currency;
  if (typeof currency === 'string' && currency) return currency;
  if (currency && typeof currency === 'object') {
    for (const key of ['code', 'currencyCode', 'isoCode', 'symbol']) {
      if (typeof currency[key] === 'string' && currency[key]) return currency[key];
    }
  }
  return 'JPY';
}

// Every price a single l2Id (one purchasable colour+size) carries. `member`
// is absent for products with no app-member price, which is why an ordinary
// full-price product is unaffected by any of this.
function priceValuesFromPriceEntry(entry) {
  const values = [];
  for (const audience of ['guest', 'member']) {
    const group = entry?.[audience];
    if (!group || typeof group !== 'object') continue;
    for (const kind of ['base', 'promo']) {
      const node = group[kind];
      if (!node || typeof node !== 'object') continue;
      const numeric = typeof node.value === 'number' ? node.value : Number(node.value);
      // Same sanity bounds the JSON-LD path applies, so a 0-yen placeholder
      // can't win by being numerically the lowest.
      if (Number.isNaN(numeric) || numeric <= 0 || numeric >= 1_000_000) continue;
      values.push({ price: numeric, currency: currencyCodeFromPriceNode(node), label: `${audience}.${kind}` });
    }
  }
  return values;
}

// Narrows result.l2s down to the SKUs the requested URL is actually showing,
// then returns the lowest price any of them can be bought at today.
//
// Narrowing matters because result.prices covers *every* colour and size of
// the product, and colours routinely sit at different prices (one colourway
// on clearance while the rest are full price). Two filters, in order:
//  1. the colour/size display codes in the URL's query string, which is the
//     precise answer whenever the URL carries them;
//  2. failing that (or in addition), SKUs whose guest price equals the price
//     already read from this URL's JSON-LD variant — i.e. the same price tier
//     as the variant the page is displaying. This is what keeps a URL with no
//     colour code from picking up some other colour's deeper discount.
// If a filter would leave nothing, it is skipped rather than applied, so a
// site-side change to the code format degrades to a broader match instead of
// dropping the price entirely.
function extractPriceFromPriceApiBody(body, url, jsonLdPrice, log = () => {}, source = 'price API') {
  const { l2s, prices } = body.result;

  let colorCode = null;
  let sizeCode = null;
  try {
    const params = new URL(url).searchParams;
    colorCode = params.get('colorDisplayCode');
    sizeCode = params.get('sizeDisplayCode');
  } catch {
    // malformed URL — fall through with no variant filter
  }

  let selected = l2s.filter(
    (l2) =>
      (!colorCode || l2?.color?.displayCode === colorCode) && (!sizeCode || l2?.size?.displayCode === sizeCode)
  );
  if (selected.length === 0) {
    log(
      `    ${source}: no l2s entry matches colorDisplayCode=${JSON.stringify(colorCode)} ` +
        `sizeDisplayCode=${JSON.stringify(sizeCode)} — considering all ${l2s.length} of them`
    );
    selected = l2s;
  } else {
    log(
      `    ${source}: ${selected.length}/${l2s.length} l2s entries match colorDisplayCode=${JSON.stringify(colorCode)} ` +
        `sizeDisplayCode=${JSON.stringify(sizeCode)}`
    );
  }

  if (jsonLdPrice != null) {
    const sameTier = selected.filter((l2) =>
      priceValuesFromPriceEntry(prices[l2?.l2Id]).some(
        (value) => value.label.startsWith('guest.') && value.price === jsonLdPrice
      )
    );
    if (sameTier.length > 0) {
      log(`    ${source}: ${sameTier.length} of those have guest price ${jsonLdPrice} (the JSON-LD variant's tier)`);
      selected = sameTier;
    } else {
      log(`    ${source}: none of those have guest price ${jsonLdPrice}, keeping the wider set`);
    }
  }

  let best = null;
  // The regular price to show a discount against. `guest.base` is what a
  // non-member pays before any app-member price applies, so it is the only
  // node that means "list price"; the highest one across the selected SKUs
  // is taken so a partially-discounted colour still reports the undiscounted
  // amount. Note both brands' payloads are requested with
  // includePreviousPrice=false, so this is NOT the pre-markdown price — for a
  // product that is simply marked down (UNIQLO 期間限定価格 included) base and
  // promo are equal and there is no discount to show. It is the GU
  // アプリ会員特別価格 case where the two genuinely differ.
  let listPrice = null;
  for (const l2 of selected) {
    for (const value of priceValuesFromPriceEntry(prices[l2?.l2Id])) {
      if (!best || value.price < best.price) best = { ...value, l2Id: l2?.l2Id };
      if (value.label === 'guest.base' && (listPrice == null || value.price > listPrice)) listPrice = value.price;
    }
  }

  if (!best) {
    log(`    ${source}: no usable price among ${selected.length} l2s entry/entries`);
    return null;
  }

  const stock = stockAcrossEntries(body.result.stocks, selected);
  log(
    `    ${source}: lowest purchasable price is ${best.price} ${best.currency} (${best.label} of l2Id ${best.l2Id}), ` +
      `list price ${listPrice ?? 'unknown'}, stock ${stock.status} (${stock.inStockCount}/${selected.length} SKU in stock)`
  );
  return {
    price: best.price,
    currency: best.currency,
    listPrice,
    priceLabel: best.label,
    stockStatus: stock.status,
    inStockSizeCount: stock.inStockCount,
  };
}

// Stock for the SKUs we selected, from the `result.stocks` map that rides
// along in the same price API response (keyed by l2Id, like result.prices).
// Two things are recorded: whether the product is buyable at all in the
// colour the URL is showing — so the dashboard can stop advertising a price
// nobody can act on — and how many sizes are left, which is the signal worth
// having later, since a 通常値下げ runs "until it sells out" and a thinning
// size run is what precedes the next markdown.
function stockAcrossEntries(stocks, selected) {
  if (!stocks || typeof stocks !== 'object') return { status: null, inStockCount: null };
  let known = 0;
  let inStockCount = 0;
  for (const l2 of selected) {
    const statusCode = stocks[l2?.l2Id]?.statusCode;
    if (typeof statusCode !== 'string' || statusCode === '') continue;
    known++;
    if (statusCode !== 'STOCK_OUT') inStockCount++;
  }
  if (known === 0) return { status: null, inStockCount: null };
  return { status: inStockCount > 0 ? 'in_stock' : 'stock_out', inStockCount };
}

// Scans the JSON responses the page fetched for the price API above. Only
// responses whose own URL carries this product's code are considered, so a
// recommendation widget's payload for other products can never be mistaken
// for this one's price.
function extractPriceFromPriceApiResponses(responses, url, jsonLdPrice, log = () => {}) {
  const productCode = (url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1];
  let best = null;
  for (const { url: responseUrl, body } of responses) {
    if (productCode && !responseUrl.includes(productCode)) continue;
    if (!isPriceApiBody(body)) continue;
    log(`  price API response ${responseUrl}`);
    const found = extractPriceFromPriceApiBody(body, url, jsonLdPrice, log);
    if (found && (!best || found.price < best.price)) best = found;
  }
  if (!best) log('  no l2s price API response found among the sniffed JSON responses');
  return best;
}

// The single entry point both the real scraper and the debug dump use, so a
// debug trace can never disagree with what a scheduled run would record.
//
// The JSON-LD is still what identifies the product (its name, its
// priceValidUntil end date, and the per-variant regular price); the price API
// can only *lower* the price from there, which is exactly the member/期間限定
// case. Falling back to a blind search of the sniffed JSON stays last: it can
// pick up any number that merely looks like a price, so it must not get the
// chance to override a price that one of the structured paths understood.
function extractPriceAndName(html, url, candidateJsonResponses, log = () => {}) {
  log('--- price extraction from rendered HTML (JSON-LD / meta / __NEXT_DATA__) ---');
  let result = extractPriceFromRenderedHtml(html, url, log);
  // Kept separately because `result.price` is overwritten below when the API
  // undercuts it, and the pre-API figure is the list price we want to report.
  const jsonLdPrice = result?.price ?? null;

  log(`--- brand price API, across ${candidateJsonResponses.length} sniffed JSON response(s) ---`);
  const apiPrice = extractPriceFromPriceApiResponses(candidateJsonResponses, url, jsonLdPrice, log);
  if (apiPrice && (!result || apiPrice.price < result.price)) {
    log(
      `  price API price ${apiPrice.price} is lower than ` +
        `${result ? `the JSON-LD price ${result.price}` : 'anything the rendered HTML gave'} — using it`
    );
    // Only the price moves: the JSON-LD's own priceCurrency is the more
    // trustworthy currency of the two (a plain ISO string, straight off the
    // page being recorded), so it is kept whenever the page had one.
    result = withLimitedPriceEndDateFallback(
      { ...(result ?? {}), price: apiPrice.price, currency: result?.currency ?? apiPrice.currency },
      html,
      log
    );
  } else if (apiPrice) {
    log(`  price API price ${apiPrice.price} is not lower than the JSON-LD price ${result.price} — keeping the latter`);
  }

  if (!result) {
    log(`--- nothing structured matched, blind-searching ${candidateJsonResponses.length} sniffed JSON response(s) ---`);
    for (const { url: responseUrl, body } of candidateJsonResponses) {
      const price = findPriceInObject(body);
      log(`  response ${responseUrl}: ${price != null ? `found price=${price}` : 'no plausible price field'}`);
      if (price != null) {
        result = withLimitedPriceEndDateFallback({ price, currency: 'JPY' }, html, log);
        break;
      }
    }
  }

  if (!result) return null;

  // Prefer the name captured from the exact same JSON-LD candidate as the
  // price (see extractPriceFromRenderedHtml); only fall back to an
  // independent og:title/<title> scan when the price came from a path that
  // has no associated name of its own.
  const name = result.name ?? extractNameFromRenderedHtml(html);

  // The regular price this one is discounted from, so a row can say "¥3,990
  // → ¥2,990" rather than only the amount paid. Two independent readings of
  // it exist — the JSON-LD variant's own price and the price API's
  // guest.base — and the higher wins, since a discount is only understated,
  // never overstated, by taking the larger reference. Left null when neither
  // is above the price actually recorded: there is then no discount to show,
  // which is the honest answer rather than a 0% one.
  const listPriceCandidates = [jsonLdPrice, apiPrice?.listPrice].filter((value) => value != null);
  const listPrice = listPriceCandidates.length > 0 ? Math.max(...listPriceCandidates) : null;

  // What kind of price this is, read off the page's own data instead of
  // inferred from which listing page the product turned up on (which is all
  // event_type has ever known). 'member' is claimed only when the API price
  // actually won *and* came from a member node — if the member price merely
  // ties the guest one there is no member discount to speak of.
  const usedApiPrice = apiPrice != null && result.price === apiPrice.price && apiPrice.price < (jsonLdPrice ?? Infinity);
  let priceType;
  if (usedApiPrice && apiPrice.priceLabel?.startsWith('member.')) priceType = 'member';
  else if (result.limitedPriceEndDate) priceType = 'limited';
  else priceType = 'markdown';

  log(
    `resolved: price=${result.price}, listPrice=${listPrice ?? 'null'}, priceType=${priceType}, ` +
      `stock=${apiPrice?.stockStatus ?? 'unknown'} (${apiPrice?.inStockSizeCount ?? '?'} size(s) in stock)`
  );

  return {
    price: result.price,
    currency: result.currency,
    name,
    limitedPriceEndDate: result.limitedPriceEndDate ?? null,
    // Recorded whenever it is known, even when it equals the price paid.
    // "There is no member discount today" is itself a fact worth keeping —
    // nulling it would make a full-price observation indistinguishable from
    // one where the guest price could not be read at all. Deciding whether a
    // discount exists is then the reader's job: it does, exactly when
    // list_price > price.
    listPrice,
    priceType,
    // Stock is independent of which price won, so it is taken from the API
    // response whenever there was one — including when its price lost.
    stockStatus: apiPrice?.stockStatus ?? null,
    inStockSizeCount: apiPrice?.inStockSizeCount ?? null,
  };
}

// --- Rendering a product page and extracting price/name from it ---

async function collectRenderedPage(
  page,
  url,
  productCode,
  candidateJsonResponses,
  {
    navTimeoutMs = NAV_TIMEOUT_MS,
    settleMs = RENDER_SETTLE_MS,
    priceApiWaitMs = PRICE_API_WAIT_MS,
    onlyMatchingProductCode = true,
    log = () => {},
  } = {}
) {
  // Resolved as soon as a captured response turns out to be the price API,
  // so the settle below can stop early instead of always burning its full
  // budget. Waiting for it is not optional: the price API is fetched by the
  // page's own JavaScript *after* domcontentloaded, so a fixed short settle
  // would sometimes read the DOM before the member/期間限定 price exists and
  // silently record the regular price instead.
  let resolvePriceApiSeen;
  const priceApiSeen = new Promise((resolve) => {
    resolvePriceApiSeen = resolve;
  });

  page.on('response', async (response) => {
    try {
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;
      if (onlyMatchingProductCode && productCode && !response.url().includes(productCode)) return;
      const json = await response.json();
      candidateJsonResponses.push({ url: response.url(), body: json });
      if ((!productCode || response.url().includes(productCode)) && isPriceApiBody(json)) {
        log(`price API response captured: ${response.url()}`);
        resolvePriceApiSeen();
      }
    } catch {
      // response body not readable as JSON, or already consumed — ignore
    }
  });

  log(`goto start (timeout ${navTimeoutMs}ms)`);
  await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs }), navTimeoutMs + 2_000, 'goto');
  log('goto done, waiting for the price API');
  await withTimeout(priceApiSeen, priceApiWaitMs, 'price API response').catch(() => {
    log(`no price API response within ${priceApiWaitMs}ms — continuing with whatever the page rendered`);
  });
  log('settling');
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

  // The JSON responses the page fetches are captured because the member/
  // 期間限定 price lives only in one of them (the l2s price API). Capture is
  // restricted to responses whose own URL mentions this product's code —
  // otherwise a recommendation/cross-sell widget's API call for a *different*
  // product could be mistaken for this one's price.
  const candidateJsonResponses = [];

  try {
    const renderedHtml = await withTimeout(
      collectRenderedPage(page, url, productCode, candidateJsonResponses, { log, ...renderOptions }),
      outerTimeoutMs,
      url
    );

    const result = extractPriceAndName(renderedHtml, url, candidateJsonResponses, log);
    if (!result) {
      log('extraction FAILED: no price found via any strategy');
      return null;
    }

    log(
      `extraction SUCCEEDED: price=${result.price} ${result.currency}, name=${JSON.stringify(result.name)}, ` +
        `limitedPriceEndDate=${JSON.stringify(result.limitedPriceEndDate)}`
    );
    return result;
  } finally {
    await closeContextSafely(context, log);
  }
}

// --- Recording price events ---

async function fetchLatestRecordedPrice(productId) {
  const { data, error } = await supabase
    .from('price_events')
    .select('id, price, currency, price_type, limited_price_end_date, scraped_at')
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

// 再値下げ — a 期間限定価格 stacked on top of a product that was *already*
// permanently marked down — is the one price "型" the product page cannot
// tell you about. The page shows today's price and today's flags; that this
// same product sat at a plain 値下げ price last week exists only in our own
// history. So unlike member/limited/markdown, which are read straight off the
// page, this one is decided by comparing against the previous recorded row.
//
// It refines 'limited' only. A GU アプリ会員特別価格 is a different mechanism
// (a membership price, not a further markdown), and 再値下げ as the reference
// material defines it is specifically 通常値下げ→期間限定価格, so 'member' is
// left alone rather than being overwritten and losing that distinction.
//
// Rows written before price_type existed still carry limited_price_end_date,
// which is enough to tell whether that observation was a period-limited price
// — so the check works against history already in the table instead of
// needing two fresh scrapes to become useful.
function previousPriceTypeOf(latest) {
  if (!latest) return null;
  if (latest.price_type) return latest.price_type;
  return latest.limited_price_end_date ? 'limited' : 'markdown';
}

function applyRemarkdown(priceType, previousPriceType, log = () => {}) {
  if (priceType !== 'limited') return priceType;
  if (previousPriceType !== 'markdown' && previousPriceType !== 'remarkdown') return priceType;
  log(`price type refined to 'remarkdown' (previous observation was '${previousPriceType}')`);
  return 'remarkdown';
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
// kept. An equal-priced occurrence still supersedes the stored one when it
// comes from a 'limited' source and the stored one did not, because at equal
// price the listing the product was found on is the only thing that differs
// and 期間限定価格一覧 is the more specific statement (see below). isNewProduct/previousPrice for a superseding (lower-
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
  if (existing) {
    const isCheaper = extracted.price < existing.price;
    // A tie between a 'sale' occurrence and a 'limited' one is not arbitrary,
    // even though the price is identical. The same product is routinely
    // listed on both 値下げ一覧 and 期間限定価格一覧, and both listings link the
    // same product page, so both occurrences now extract the same price —
    // which means "keep the lowest, first one wins ties" was really "whichever
    // source happens to come first in sources.json wins", and sale sources are
    // listed first. The stored row's event_type is what the dashboard
    // sections on, so every such product landed under 値下げ and none of them
    // under 期間限定. Let a 'limited' occurrence supersede an equal-priced
    // non-limited one so the more specific listing decides the section. The
    // reverse never applies, so this cannot oscillate.
    const upgradesToLimited =
      extracted.price === existing.price && source.listingType === 'limited' && existing.listingType !== 'limited';
    if (!isCheaper && !upgradesToLimited) {
      return { productId, skipped: true };
    }
  }

  const nowIso = new Date().toISOString();

  let isNewProduct;
  let previousPrice;
  let previousCurrency;
  let previousPriceType;
  let existingRowId;
  if (existing) {
    ({ isNewProduct, previousPrice, previousCurrency, previousPriceType } = existing);
    existingRowId = existing.rowId;
  } else {
    const latest = await fetchLatestRecordedPrice(productId);
    isNewProduct = !latest;
    previousPrice = latest?.price ?? null;
    previousCurrency = latest?.currency ?? null;
    previousPriceType = previousPriceTypeOf(latest);
    existingRowId = latest && isSameUtcCalendarDay(latest.scraped_at, nowIso) ? latest.id : null;
  }

  // Read off the page, then refined against this product's own history.
  const priceType = applyRemarkdown(extracted.priceType, previousPriceType, (msg) =>
    console.log(`[${source.id}] [${productId}] ${msg}`)
  );

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
    list_price: extracted.listPrice ?? null,
    currency: extracted.currency,
    price_type: priceType ?? null,
    stock_status: extracted.stockStatus ?? null,
    in_stock_size_count: extracted.inStockSizeCount ?? null,
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
  productRunState.set(productId, {
    price: extracted.price,
    currency: extracted.currency,
    listingType: source.listingType,
    rowId,
    isNewProduct,
    previousPrice,
    previousCurrency,
    // The *pre-run* type, deliberately — not the one just written — so a
    // later occurrence of the same product this run compares against the same
    // baseline the first one did (see the note above processProductUrl).
    previousPriceType,
  });

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

// --- Debug mode: render one or more products and dump what we saw ---

// Every key that could plausibly hold a JPY amount somewhere in a sniffed
// API payload. Deliberately much wider than the extractor's own accepted
// key list: the point of the debug dump is to reveal fields the extractor
// does NOT yet know about (a promo/member price sitting next to the base
// price, say), so it must not be filtered by the extractor's assumptions.
const DEBUG_PRICE_KEY_RE = /(price|amount|value|base|promo|discount|sale|list|original|member|app|limited)/i;

function collectPriceCandidates(obj, { path = '$', depth = 0, out = [], limit = 300 } = {}) {
  if (out.length >= limit || obj == null || depth > 12) return out;
  if (Array.isArray(obj)) {
    obj.forEach((value, i) => collectPriceCandidates(value, { path: `${path}[${i}]`, depth: depth + 1, out, limit }));
    return out;
  }
  if (typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (out.length >= limit) break;
    const childPath = `${path}.${key}`;
    const numeric =
      typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (DEBUG_PRICE_KEY_RE.test(key) && !Number.isNaN(numeric) && numeric > 0 && numeric < 1_000_000) {
      out.push({ path: childPath, value: numeric });
    } else if (value && typeof value === 'object') {
      collectPriceCandidates(value, { path: childPath, depth: depth + 1, out, limit });
    }
  }
  return out;
}

// Compact structural view of a JSON payload: which keys exist at each level,
// with one sample child expanded for maps keyed by opaque ids (the price map
// is keyed by SKU-level l2Id, so every entry has the same shape and dumping
// all of them says nothing extra). Used to work out how a price API actually
// nests its member/promo prices before writing an extractor against it.
function describeJsonShape(value, { path = '$', depth = 0, maxDepth = 5, out = [], limit = 80 } = {}) {
  if (out.length >= limit) return out;
  if (Array.isArray(value)) {
    out.push(`${path}: array(${value.length})`);
    if (value.length > 0 && depth < maxDepth) {
      describeJsonShape(value[0], { path: `${path}[0]`, depth: depth + 1, maxDepth, out, limit });
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    out.push(`${path}: object{${keys.slice(0, 25).join(', ')}${keys.length > 25 ? `, …+${keys.length - 25}` : ''}}`);
    if (depth < maxDepth) {
      const sampleKeys = keys.length > 6 ? keys.slice(0, 1) : keys;
      for (const key of sampleKeys) {
        describeJsonShape(value[key], { path: `${path}.${key}`, depth: depth + 1, maxDepth, out, limit });
      }
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(value)}`);
  return out;
}

// Pulls the human-visible "¥1,234" strings out of the rendered DOM along
// with the words around them, so the trace shows what a shopper actually
// sees on the page ("期間限定価格 ¥2,990" / "通常価格 ¥3,990") right next to
// what the extractor picked. Without this, deciding whether an extracted
// number is the right one means trusting the artifact HTML by eye.
function extractPriceTextSnippets(html, limit = 15) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&yen;/gi, '¥')
    .replace(/\s+/g, ' ');
  const snippets = [];
  const seen = new Set();
  const re = /[¥￥]\s?[\d,]{3,9}/g;
  let match;
  while ((match = re.exec(text)) && snippets.length < limit) {
    const start = Math.max(0, match.index - 40);
    const snippet = text.slice(start, match.index + match[0].length + 20).trim();
    if (seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet);
  }
  return snippets;
}

// Condensed structural view of one JSON-LD Product/ProductGroup: enough to
// see how many offers/variants there are and every price they carry,
// without printing a hasVariant array with hundreds of entries into the
// CI log.
function summarizeJsonLdProduct(product, index, trace) {
  trace(`  jsonld[#${index}] @type=${JSON.stringify(product['@type'])} name=${JSON.stringify(product.name ?? null)}`);
  const offers = product.offers ? (Array.isArray(product.offers) ? product.offers : [product.offers]) : [];
  trace(`    .offers: ${offers.length} entry/entries`);
  offers.slice(0, 10).forEach((offer, i) => {
    trace(`      offers[${i}] = ${JSON.stringify(offer)}`);
  });
  if (offers.length > 10) trace(`      ... ${offers.length - 10} more offer(s) not printed`);

  const variants = Array.isArray(product.hasVariant) ? product.hasVariant : [];
  trace(`    .hasVariant: ${variants.length} entry/entries`);
  variants.slice(0, 5).forEach((variant, v) => {
    const variantOffers = variant?.offers
      ? Array.isArray(variant.offers)
        ? variant.offers
        : [variant.offers]
      : [];
    trace(
      `      hasVariant[${v}] name=${JSON.stringify(variant?.name ?? null)} sku=${JSON.stringify(variant?.sku ?? null)} ` +
        `offers=${JSON.stringify(variantOffers)}`
    );
  });
  if (variants.length > 5) trace(`      ... ${variants.length - 5} more variant(s) not printed`);
}

async function debugSingleProduct(browser, url, outDir, { via = 'direct' } = {}) {
  await mkdir(outDir, { recursive: true });

  const log = (msg) => console.log(`[debug] ${msg}`);

  const productCode = (url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1];
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
  const page = await context.newPage();
  const candidateJsonResponses = [];

  log(`navigating to ${url} (discovered via ${via})`);

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
        settleMs: 3_500,
        onlyMatchingProductCode: false,
        log,
      }),
      DEBUG_NAV_TIMEOUT_MS + 8_000,
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

  trace(`=== ${url}`);
  trace(`discovered via: ${via}`);

  // Everything below the extraction trace proper is raw evidence, printed
  // *before* the extractor's own decisions so a wrong answer can be
  // compared against what was actually on the page.
  trace('--- prices visible in the rendered DOM text ---');
  const snippets = extractPriceTextSnippets(html);
  if (snippets.length === 0) trace('  (no "¥N,NNN" text found in the rendered DOM)');
  for (const snippet of snippets) trace(`  ${snippet}`);

  trace('--- JSON-LD Product/ProductGroup blocks ---');
  const jsonLdProducts = parseJsonLdProducts(html);
  if (jsonLdProducts.length === 0) trace('  (none)');
  jsonLdProducts.forEach((product, i) => summarizeJsonLdProduct(product, i, trace));

  // Only responses whose own URL carries this product's code can be about
  // this product — a recommendation/cross-sell widget's payload is full of
  // other products' prices and would only add noise here.
  const ownResponses = productCode ? candidateJsonResponses.filter((r) => r.url.includes(productCode)) : [];
  trace(
    `--- ${ownResponses.length} of the ${candidateJsonResponses.length} sniffed JSON response(s) mention ` +
      `the product code "${productCode}" ---`
  );
  for (const { url: responseUrl, body } of ownResponses) {
    trace(`  ${responseUrl}`);
    for (const line of describeJsonShape(body)) trace(`    shape ${line}`);
    const candidates = collectPriceCandidates(body);
    for (const { path: fieldPath, value } of candidates.slice(0, 24)) trace(`    ${fieldPath} = ${value}`);
    if (candidates.length > 24) trace(`    ... ${candidates.length - 24} more price-shaped field(s) not printed`);
  }

  // Exactly the function the scheduled scraper calls, so this trace always
  // reflects what a real run would record rather than a parallel reading of
  // the same page.
  const result = extractPriceAndName(html, url, candidateJsonResponses, trace);
  // The summary line carries every field that ends up in the price_events
  // row, so a debug run can be checked against the site at a glance without
  // digging back into each product's own trace.
  const summary = result
    ? `RESULT: price=${result.price} ${result.currency}` +
      ` (list ${result.listPrice ?? 'n/a'}, ${result.priceType}),` +
      ` stock=${result.stockStatus ?? 'unknown'} ${result.inStockSizeCount ?? '?'} size(s),` +
      ` name=${JSON.stringify(result.name)},` +
      ` limitedPriceEndDate=${JSON.stringify(result.limitedPriceEndDate)}`
    : 'RESULT: no price found via any strategy';
  trace(summary);

  await writeFile(path.join(outDir, 'extraction-trace.txt'), traceLines.join('\n'), 'utf-8');
  log('wrote extraction-trace.txt');

  await closeContextSafely(context, log);

  return { url, via, summary, domPrices: snippets };
}

// DEBUG_URL accepts more than one target, separated by commas/whitespace,
// and each target may be either a product page URL or a *listing* page
// (値下げ/期間限定価格一覧). Listing pages are expanded into their first N
// products: the interesting extraction bugs are exactly the "found on the
// 期間限定 listing but extracted the regular price" kind, which can only be
// caught by starting from the listing the real scraper starts from, rather
// than from a URL picked by hand.
//
// N comes from a bare "sample=N" token inside DEBUG_URL itself (or the
// DEBUG_SAMPLE env var). It rides along in DEBUG_URL rather than being its
// own workflow input because the scrape workflow only forwards debug_url,
// and adding an input there would mean editing .github/workflows/, which
// needs a token scope this project's automation does not have.
async function resolveDebugTargets(raw) {
  const tokens = raw.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  const sampleToken = tokens.find((token) => /^sample=\d+$/.test(token));
  const entries = tokens.filter((token) => token !== sampleToken);
  const sampleRaw = sampleToken ? sampleToken.slice('sample='.length) : process.env.DEBUG_SAMPLE;
  const sample = Number(sampleRaw) > 0 ? Number(sampleRaw) : 3;
  const targets = [];

  for (const entry of entries) {
    if (/\/products\//.test(entry)) {
      targets.push({ url: entry, via: 'direct' });
      continue;
    }
    try {
      const html = await fetchHtml(entry);
      const links = extractProductLinks(html, entry);
      console.log(`[debug] listing ${entry}: discovered ${links.length} product link(s), sampling first ${sample}`);
      for (const link of links.slice(0, sample)) targets.push({ url: link, via: entry });
    } catch (err) {
      console.error(`[debug] failed to expand listing ${entry}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // The same product can be linked from more than one listing; debugging it
  // twice would just double the run time.
  const seen = new Set();
  return targets.filter((target) => (seen.has(target.url) ? false : (seen.add(target.url), true)));
}

async function debugProducts(browser, raw) {
  const rootDir = path.join(SCRIPT_DIR, '..', 'debug-output');
  await mkdir(rootDir, { recursive: true });

  const targets = await resolveDebugTargets(raw);
  if (targets.length === 0) {
    console.error('[debug] no debug targets could be resolved from DEBUG_URL');
    return;
  }
  console.log(`[debug] debugging ${targets.length} product page(s)`);

  const summaries = [];
  for (const [i, target] of targets.entries()) {
    const code = (target.url.match(/\/products\/([A-Za-z0-9-]+)/) || [])[1] || 'unknown';
    // A single target keeps writing straight into debug-output/ so the
    // existing "look at debug-output/page.html" workflow is unchanged.
    const outDir = targets.length === 1 ? rootDir : path.join(rootDir, `${String(i + 1).padStart(2, '0')}-${code}`);
    console.log(`[debug] === (${i + 1}/${targets.length}) ${target.url}`);
    try {
      summaries.push(await debugSingleProduct(browser, target.url, outDir, { via: target.via }));
    } catch (err) {
      console.error(`[debug] ${target.url} failed: ${err.message}`);
      summaries.push({ url: target.url, via: target.via, summary: `FAILED: ${err.message}`, domPrices: [] });
    }
  }

  const summaryText = summaries
    .map(
      (entry) =>
        `${entry.url}\n  via: ${entry.via}\n  ${entry.summary}\n` +
        `  DOM prices: ${entry.domPrices.slice(0, 6).join(' | ') || '(none)'}`
    )
    .join('\n\n');
  await writeFile(path.join(rootDir, 'summary.txt'), summaryText, 'utf-8');
  console.log(`[debug] ===== summary =====\n${summaryText}`);
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
      await debugProducts(browser, DEBUG_URL);
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
