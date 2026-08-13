// Fetches each tracked product page (config/products.json), extracts the current
// price, and inserts a new row into price_events only when the price differs
// from the most recently recorded one for that product. Run by
// .github/workflows/scrape.yml on a schedule (needs full internet access,
// so it must run in GitHub Actions rather than locally in a sandboxed shell).

import { createClient } from '@supabase/supabase-js';
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

function findPriceInObject(obj, depth = 0) {
  if (depth > 8 || obj == null || typeof obj !== 'object') return null;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (/^(price|currentPrice|base)$/i.test(key) && typeof value === 'number' && value > 0 && value < 1_000_000) {
      return value;
    }
    if (value && typeof value === 'object') {
      const found = findPriceInObject(value, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

function extractPriceFromHtml(html) {
  // Strategy 1: schema.org JSON-LD (Product/Offers) — the most standardized signal.
  const ldMatches = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of ldMatches) {
    try {
      const data = JSON.parse(match[1].trim());
      const roots = Array.isArray(data) ? data : [data];
      for (const root of roots) {
        const candidates = root['@graph'] ? root['@graph'] : [root];
        for (const item of candidates) {
          if (item['@type'] !== 'Product' || !item.offers) continue;
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          for (const offer of offers) {
            const price = offer.price ?? offer.lowPrice;
            if (price != null) {
              return { price: Number(price), currency: offer.priceCurrency || 'JPY' };
            }
          }
        }
      }
    } catch {
      // malformed JSON-LD block, try the next one
    }
  }

  // Strategy 2: Open Graph price meta tags.
  const metaPrice =
    html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/i) ||
    html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+property=["']product:price:amount["']/i);
  if (metaPrice) {
    const currencyMatch = html.match(/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([A-Z]{3})["']/i);
    return { price: Number(metaPrice[1]), currency: currencyMatch ? currencyMatch[1] : 'JPY' };
  }

  // Strategy 3: Next.js __NEXT_DATA__ payload — search for a plausible price field.
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

async function processProduct(product) {
  const res = await fetch(product.url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja-JP,ja;q=0.9' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${product.url}`);
  }

  const html = await res.text();
  const result = extractPriceFromHtml(html);
  if (!result) {
    throw new Error('could not extract a price from the page');
  }

  const latest = await fetchLatestRecordedPrice(product.id);
  if (latest && latest.price === result.price && latest.currency === result.currency) {
    console.log(`[${product.id}] unchanged (${result.price} ${result.currency})`);
    return 'unchanged';
  }

  const { error: insertError } = await supabase.from('price_events').insert({
    product_id: product.id,
    product_name: product.name ?? null,
    brand: product.brand,
    url: product.url,
    price: result.price,
    currency: result.currency,
  });
  if (insertError) throw insertError;

  console.log(`[${product.id}] recorded new price event: ${result.price} ${result.currency}`);
  return 'changed';
}

async function main() {
  const raw = await readFile(new URL('../config/products.json', import.meta.url), 'utf-8');
  const products = JSON.parse(raw);

  if (products.length === 0) {
    console.log('No products configured in config/products.json — nothing to scrape.');
    return;
  }

  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const product of products) {
    try {
      const outcome = await processProduct(product);
      if (outcome === 'changed') changed++;
      else unchanged++;
    } catch (err) {
      failed++;
      console.error(`[${product.id ?? product.url}] failed: ${err.message}`);
    }
  }

  console.log(`Done. ${changed} changed, ${unchanged} unchanged, ${failed} failed (of ${products.length}).`);
  if (failed > 0 && failed === products.length) {
    process.exitCode = 1;
  }
}

main();
