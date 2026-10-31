// 価格判定の純粋関数。DOM/Supabase に依存しないため、Node.js 上でテスト可能。
// インポート: import { riseOf, ... } from "./price-logic.js";

export const MARKDOWN_EVENT_TYPES = new Set(["first_markdown", "markdown"]);
export const LIMITED_EVENT_TYPES = new Set(["first_limited", "limited"]);

// The points at which this product's price actually changed, keeping only rows
// whose event_type is in `eventTypes` (pass null to keep every row).
//
// The scraper writes a fresh row every scrape even when the price hasn't moved
// (see scripts/scrape.mjs), so same-price rows collapse into a single point
// here. Rows outside `eventTypes` are skipped rather than breaking the
// sequence, so an observation of a different kind in the middle doesn't split
// one run of markdowns into two.
export function priceStagePoints(history, eventTypes) {
  const points = [];
  for (const row of history) {
    if (eventTypes && !eventTypes.has(row.event_type)) continue;
    const last = points[points.length - 1];
    if (!last || last.price !== row.price) {
      points.push({ price: row.price, currency: row.currency, scraped_at: row.scraped_at, event_type: row.event_type, price_type: row.price_type ?? null });
    }
  }
  return points;
}

// A distinct "値下げ段階" — "3段階目" means "the 3rd distinct price this
// product has had while markdown-listed", not "3 rows in the DB".
//
// 値上げの行(price_up)も系列に含め、価格が上がった時点で段階を数え直す。
// 値上げで始まった系列は先頭に risen を立て、その点は段階に数えない
// (markdownStageCount)。値上げ後にまだ下がっていない商品は0段階＝「値上げ後」。
export const MARKDOWN_SEQUENCE_TYPES = new Set([...MARKDOWN_EVENT_TYPES, "price_up"]);

export function markdownStagePoints(history) {
  const points = priceStagePoints(history, MARKDOWN_SEQUENCE_TYPES);
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].price > points[i - 1].price) start = i;
  }
  const current = points.slice(start);
  current.risen = start > 0 || current[0]?.event_type === "price_up";
  return current;
}

export function markdownStageCount(points) {
  return points.length - (points.risen ? 1 : 0);
}

// 一時的な価格かどうか。LIMITED_EVENT_TYPES に加え、値下げ棚で会員 API 価格が
// 勝った場合は event_type=markdown のまま price_type=member になる
// (scrape.mjs の classifyEventType は listingType で event_type を決め、
// price_type とは独立)。どちらの記録形式でも「期間が来れば戻る価格」として扱う。
function isTemporaryPrice(row) {
  return LIMITED_EVENT_TYPES.has(row.event_type) || row.price_type === "member";
}

// 価格が上がって、まだ下がっていない(いま効いている)値上げ。無ければ null。
// { from: 上がる前の価格(不明なら null), to: 上がった後の価格, at: 確認した日時 }
//
// 期間限定が終わって元の価格に戻ったものは値上げに数えない(直前が期間限定の
// 行なら、それは戻りであって値上げではない)。値上げのあとに期間限定または会員価格で
// 一時的に下がっても、その値引きは終われば戻るので値上げは効いたままとみなす。
// 値下げ一覧経由で下がったら、その値上げはもう効いていない。
export function riseOf(history) {
  const latest = history[history.length - 1];
  const points = priceStagePoints(history, null);
  let rise = null;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (cur.price > prev.price) {
      if (!isTemporaryPrice(prev)) rise = { from: prev.price, to: cur.price, at: cur.scraped_at };
    } else if (rise && !isTemporaryPrice(cur)) {
      rise = null;
    }
  }
  // 値上げ後に一時的な価格へ下がると latest.price < rise.to になるが、
  // 一時価格は終われば rise.to に戻るので値上げは効いたままとみなす。
  if (rise && (latest.price >= rise.to || isTemporaryPrice(latest))) return rise;

  // 上の判定で拾えないが、値下げの段階が値上げから始まっていて、まだ下がって
  // いない商品(値下げの段階では「値上げ後」)。値下げセクションから外すぶん、
  // ここで必ず拾う — どのセクションにも出ない商品を作らないため。
  if (MARKDOWN_SEQUENCE_TYPES.has(latest.event_type)) {
    const md = markdownStagePoints(history);
    if (md.risen && markdownStageCount(md) === 0) {
      const at = md[0].scraped_at;
      const i = history.findIndex((row) => row.scraped_at === at);
      return { from: i > 0 ? history[i - 1].price : null, to: md[0].price, at };
    }
  }
  return null;
}
