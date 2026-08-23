import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const brandTabsEl = document.getElementById("brand-tabs");
const genderTabsEl = document.getElementById("gender-tabs");

const BRAND_CONFIG = {
  uniqlo: { label: "UNIQLO", color: "var(--brand-uniqlo)" },
  gu: { label: "GU", color: "var(--brand-gu)" },
};

// Section order top-to-bottom, each independent per the dashboard spec.
// "初値下げ"/"初期間限定" (first_markdown/first_limited) are this tracker's
// first-ever detection of a product via the 値下げ一覧/期間限定価格一覧 listing
// pages respectively — NOT a claim that the product just launched, since this
// tracker never visits an official new-arrivals page. They're grouped next to
// their parent 値下げ/期間限定 sections rather than at the top for that reason.
const EVENT_TYPE_CONFIG = [
  { key: "first_markdown", label: "初値下げ" },
  { key: "markdown", label: "値下げ" },
  { key: "first_limited", label: "初期間限定" },
  { key: "limited", label: "期間限定" },
  { key: "price_up", label: "値上げ" },
];

const CATEGORY_ORDER = {
  uniqlo: ["トップス", "シャツ", "アウター", "パンツ", "ワンピース", "ビジネス", "インナー・ルームウェア", "その他"],
  gu: ["トップス", "アウター・パンツ", "ワンピース", "グッズ・その他"],
};

let state = { brand: "uniqlo", gender: "men" };
let index = null; // brand -> gender -> event_type -> category -> [{ latest, history }]

const currencyFormatter = (currency) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency, maximumFractionDigits: 0 });

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// limited_price_end_date is a plain YYYY-MM-DD (no time component) — format
// it in UTC explicitly so the displayed day never shifts by one due to the
// viewer's local timezone.
const endDateFormatter = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", timeZone: "UTC" });
function formatLimitedPriceEndDate(isoDate) {
  if (!isoDate) return null;
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  return `${endDateFormatter.format(date)}まで`;
}

const MARKDOWN_EVENT_TYPES = new Set(["first_markdown", "markdown"]);
const LIMITED_EVENT_TYPES = new Set(["first_limited", "limited"]);

// The points at which this product's price actually changed, keeping only rows
// whose event_type is in `eventTypes` (pass null to keep every row).
//
// The scraper writes a fresh row every scrape even when the price hasn't moved
// (see scripts/scrape.mjs), so same-price rows collapse into a single point
// here. Rows outside `eventTypes` are skipped rather than breaking the
// sequence, so an observation of a different kind in the middle doesn't split
// one run of markdowns into two.
function priceStagePoints(history, eventTypes) {
  const points = [];
  for (const row of history) {
    if (eventTypes && !eventTypes.has(row.event_type)) continue;
    const last = points[points.length - 1];
    if (!last || last.price !== row.price) {
      points.push({ price: row.price, currency: row.currency, scraped_at: row.scraped_at });
    }
  }
  return points;
}

// A distinct "値下げ段階" — "3段階目" means "the 3rd distinct price this
// product has had while markdown-listed", not "3 rows in the DB".
function markdownStagePoints(history) {
  return priceStagePoints(history, MARKDOWN_EVENT_TYPES);
}

// 値下げも期間限定も日本時間で回っているので、日付も日本時間で出す。
// limited_price_end_date は日本時間の日付として入っているため、こちらを
// 閲覧者のローカル時間で出すと「8/21〜8/20」のような並びになりうる。
const stageDateFormatter = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  timeZone: "Asia/Tokyo",
});

// limited_price_end_date は時刻を持たない YYYY-MM-DD なので、UTC として
// 解釈しないと閲覧者のタイムゾーンで1日ずれる(endDateFormatter と同じ理由)。
const shortEndDateFormatter = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  timeZone: "UTC",
});

// e.g. "¥1,990(7/8)→¥1,290(7/13)→¥990(7/28)→¥790(8/18)"
function formatMarkdownStageHistory(points) {
  const fmt = currencyFormatter(points[0]?.currency ?? "JPY");
  return points.map((p) => `${fmt.format(p.price)}(${stageDateFormatter.format(new Date(p.scraped_at))})`).join(" → ");
}

// The date this product was first ever recorded as 期間限定 (event_type
// 'first_limited'/'limited') — history is sorted ascending, so the first
// matching row is the earliest.
function firstLimitedSeenDate(history) {
  for (const row of history) {
    if (LIMITED_EVENT_TYPES.has(row.event_type)) return row.scraped_at;
  }
  return null;
}

// 期間限定の「周期」。値下げと違い、期間限定は終わると価格が元に戻るので、
// 値下げと同じ一本の折れ線で結ぶと戻りの上昇が値上げのように見えてしまう。
// 周期そのものを単位にして、何回目・いつからいつまで・いくらだったかを出す。
//
// 区切りは limited_price_end_date。期間限定は金曜開始・木曜終了で毎週
// 入れ替わるため、終了日が変われば別の周期。終了日が読めなかった行どうしは
// 価格が変わった時点で別の周期として扱う。
function isSamePeriod(period, row) {
  const endDate = row.limited_price_end_date || null;
  if (period.endDate !== null || endDate !== null) return period.endDate === endDate;
  return period.price === row.price;
}

function limitedPeriods(history) {
  const periods = [];
  for (const row of history) {
    if (!LIMITED_EVENT_TYPES.has(row.event_type)) continue;
    const current = periods[periods.length - 1];
    if (current && isSamePeriod(current, row)) {
      current.to = row.scraped_at;
      // 同じ周期の途中で価格が動いたら安い方を代表値にする(会員価格が後から
      // 読めるようになった場合など)。
      if (row.price < current.price) current.price = row.price;
      continue;
    }
    periods.push({
      from: row.scraped_at,
      to: row.scraped_at,
      endDate: row.limited_price_end_date || null,
      price: row.price,
      currency: row.currency,
    });
  }
  return periods;
}

// いま出ている期間限定がいつ始まったか(＝最後の周期の開始日)。
function currentLimitedStartDate(history) {
  const periods = limitedPeriods(history);
  return periods.length > 0 ? periods[periods.length - 1].from : null;
}

// e.g. "¥2,490(7/11〜7/17) → ¥1,990(8/1〜8/7) → ¥1,990(8/15〜)"
// 終了日が読めている周期はそれを終わりに使う。読めない周期は最後に確認できた
// 日で代用する。まだ終わっていない周期は終わりを空けたままにする。
function formatLimitedPeriods(periods, todayJst = jstDayOf(new Date())) {
  const fmt = currencyFormatter(periods[0]?.currency ?? "JPY");
  return periods
    .map((period) => {
      const from = stageDateFormatter.format(new Date(period.from));
      const ongoing = period.endDate !== null && todayJst !== null && period.endDate >= todayJst;
      const to = ongoing
        ? ""
        : period.endDate !== null
          ? shortEndDateFormatter.format(new Date(period.endDate))
          : stageDateFormatter.format(new Date(period.to));
      return `${fmt.format(period.price)}(${from}〜${to})`;
    })
    .join(" → ");
}

// Buckets `products` by the JST calendar day `dateOf(product)` falls on,
// most-recent-day first, capped to the most recent 14 distinct days so a
// long-tracked section doesn't produce an unbounded row of chips.
function groupProductsByDate(products, dateOf) {
  const groups = new Map(); // "M/D" label -> { date: Date, count: number }
  for (const product of products) {
    const iso = dateOf(product);
    if (!iso) continue;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) continue;
    const label = stageDateFormatter.format(date);
    const existing = groups.get(label);
    if (existing) {
      existing.count += 1;
      if (date > existing.date) existing.date = date;
    } else {
      groups.set(label, { date, count: 1 });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.date - a.date)
    .slice(0, 14)
    .map((g) => ({ label: stageDateFormatter.format(g.date), count: g.count }));
}

// 値下げ・期間限定はすべて日本時間で回っている(期間限定は金曜開始・木曜終了)。
// 「今日」も日本時間で判定しないと、日付をまたぐ時間帯に見ている人には
// 終了済みが有効に見えたり、その逆が起きる。
function jstDayOf(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 期間限定価格が終了しているか。limited_price_end_date は「その日まで有効」
// なので、終了日そのものはまだ有効。翌日から終了とみなす。
function isLimitedOfferOver(row, todayJst) {
  if (!row.limited_price_end_date) return false;
  return row.limited_price_end_date < todayJst;
}

// 直近の巡回で確認できなかった商品か。
//
// 一覧から外れた商品はスクレイパーが二度と触らないため、最後に記録した行が
// そのまま残り続ける。「値下げ中」の表示のまま何日でも居座るので、確認できた
// 最後の日を見て区別する。
//
// 基準は固定の日数ではなく「データ全体で最も新しい巡回日」。定期実行が失敗した
// 日があっても、基準日はその前の成功時のままなので、全商品が一斉に古い扱いに
// なることはない。
function lastCrawlDayOf(rows) {
  let newest = null;
  for (const row of rows) {
    const day = jstDayOf(row.scraped_at);
    if (day && (newest === null || day > newest)) newest = day;
  }
  return newest;
}

function buildIndex(rows) {
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }

  const todayJst = jstDayOf(new Date());
  const lastCrawlDay = lastCrawlDayOf(rows);

  const idx = {};
  for (const history of byProduct.values()) {
    history.sort((a, b) => new Date(a.scraped_at) - new Date(b.scraped_at));
    const latest = history[history.length - 1];
    const offerOver = isLimitedOfferOver(latest, todayJst);
    const unconfirmed = lastCrawlDay !== null && jstDayOf(latest.scraped_at) < lastCrawlDay;
    const brand = latest.brand;
    const gender = latest.gender || "unknown";
    const eventType = latest.event_type || "markdown";
    const category = latest.category || (brand === "gu" ? "グッズ・その他" : "その他");

    idx[brand] ??= {};
    idx[brand][gender] ??= {};
    idx[brand][gender][eventType] ??= {};
    idx[brand][gender][eventType][category] ??= [];
    idx[brand][gender][eventType][category].push({ latest, history, offerOver, unconfirmed });
  }
  return idx;
}

function categoryOrderFor(brand, categories) {
  const known = CATEGORY_ORDER[brand] || [];
  const ordered = known.filter((c) => categories.includes(c));
  const extra = categories.filter((c) => !known.includes(c)).sort();
  return [...ordered, ...extra];
}

// 値下げは「何段階目」、期間限定は「何回目」。1回目は定義上必ず1なので出さない。
function countSuffixFor(eventType, stagePoints, periods) {
  if (eventType === "markdown" && stagePoints.length > 0) return `(${stagePoints.length}段階目)`;
  if (eventType === "limited" && periods.length > 1) return `(${periods.length}回目)`;
  return "";
}

// カード下部に出す価格推移の文字列。出すものが無ければ null。
function priceHistoryTextFor({ isMarkdownFamily, isLimitedFamily, stagePoints, periods, history }) {
  if (isMarkdownFamily) return stagePoints.length > 0 ? formatMarkdownStageHistory(stagePoints) : null;
  // 期間限定が1回だけの商品は、価格・終了日・確認開始日がすでにカードに
  // 出ているので、同じことを繰り返さない。
  if (isLimitedFamily) return periods.length > 1 ? formatLimitedPeriods(periods) : null;
  // 値下げでも期間限定でもない商品(値上げなど)。価格が実際に動いた時点だけを並べる。
  const points = priceStagePoints(history, null);
  return points.length > 1 ? formatMarkdownStageHistory(points) : null;
}

function renderCard(product) {
  const { latest, history, offerOver, unconfirmed } = product;
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const fmt = currencyFormatter(latest.currency);

  // The whole card is the product link (click/tap anywhere opens the
  // official product page in a new tab), so it's an <a>, not a <div>.
  const card = document.createElement("a");
  // 終了・未確認の商品は消さずに残し、見た目を落として区別する。消してしまうと
  // 「昨日まで載っていた商品がなぜ消えたのか」が分からなくなるため。
  card.className = `card${offerOver ? " offer-over" : ""}${unconfirmed && !offerOver ? " unconfirmed" : ""}`;
  card.href = latest.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const topRow = document.createElement("div");
  topRow.className = "top-row";

  const title = document.createElement("h2");
  title.textContent = latest.product_name || latest.product_id;
  topRow.appendChild(title);

  const isMarkdownFamily = MARKDOWN_EVENT_TYPES.has(latest.event_type);
  const isLimitedFamily = LIMITED_EVENT_TYPES.has(latest.event_type);
  const stagePoints = isMarkdownFamily ? markdownStagePoints(history) : [];
  const periods = isLimitedFamily ? limitedPeriods(history) : [];

  const eventConfig = EVENT_TYPE_CONFIG.find((e) => e.key === latest.event_type);
  if (eventConfig) {
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);
    // "初値下げ"/"初期間限定" are always exactly the 1st by definition (see
    // classifyEventType in scripts/scrape.mjs), so the count only adds
    // information for a *follow-up* observation — append it there instead of
    // duplicating "(1段階目)" on every 初値下げ badge.
    badge.textContent = `${eventConfig.label}${countSuffixFor(latest.event_type, stagePoints, periods)}`;
    topRow.appendChild(badge);
  }

  // 期間限定が終了日を過ぎている場合は、それを最優先で伝える。価格行はもう
  // 現在の価格ではないため。
  if (offerOver) {
    const over = document.createElement("span");
    over.className = "state-badge over";
    over.textContent = "終了";
    topRow.appendChild(over);
  } else if (unconfirmed) {
    const stale = document.createElement("span");
    stale.className = "state-badge stale";
    stale.textContent = "未確認";
    topRow.appendChild(stale);
  }
  card.appendChild(topRow);

  const priceRow = document.createElement("div");
  priceRow.className = "price-row";

  const price = document.createElement("span");
  price.className = "price";
  price.textContent = fmt.format(latest.price);
  priceRow.appendChild(price);

  // 通常価格が別途取れている商品(GUのアプリ会員特別価格など)だけ、元値と
  // 割引率を添える。値下げされただけの商品は通常価格＝実売価格になるため
  // list_price が入らず、ここは出ません(「0%OFF」を出さないため)。
  if (latest.list_price != null && latest.list_price > latest.price) {
    const wasPrice = document.createElement("span");
    wasPrice.className = "was-price";
    wasPrice.textContent = fmt.format(latest.list_price);
    priceRow.appendChild(wasPrice);

    const off = document.createElement("span");
    off.className = "discount";
    off.textContent = `${Math.round((1 - latest.price / latest.list_price) * 100)}%OFF`;
    priceRow.appendChild(off);
  }

  if (previous && previous.price !== latest.price) {
    const diff = latest.price - previous.price;
    const delta = document.createElement("span");
    delta.className = `delta ${diff < 0 ? "down" : "up"}`;
    delta.textContent = `${diff > 0 ? "+" : ""}${fmt.format(diff)}`;
    priceRow.appendChild(delta);
  }
  card.appendChild(priceRow);

  // 商品ページ自身のデータから決まる価格の種類と在庫。どの一覧ページで
  // 見つけたかに由来する event_type(セクション分け)とは別物なので、
  // セクションと重複する情報は出さない。
  const facts = document.createElement("div");
  facts.className = "facts";

  const PRICE_TYPE_LABELS = {
    member: "アプリ会員価格",
    remarkdown: "再値下げ",
  };
  // 'limited' / 'markdown' はセクション名と重複するので出さない。
  const priceTypeLabel = PRICE_TYPE_LABELS[latest.price_type];
  if (priceTypeLabel) {
    const typeTag = document.createElement("span");
    typeTag.className = `fact ${latest.price_type}`;
    typeTag.textContent = priceTypeLabel;
    facts.appendChild(typeTag);
  }

  if (latest.stock_status === "stock_out") {
    const soldOut = document.createElement("span");
    soldOut.className = "fact sold-out";
    soldOut.textContent = "在庫なし";
    facts.appendChild(soldOut);
  } else if (latest.in_stock_size_count != null && latest.in_stock_size_count > 0) {
    const sizes = document.createElement("span");
    sizes.className = "fact sizes";
    sizes.textContent = `在庫${latest.in_stock_size_count}サイズ`;
    facts.appendChild(sizes);
  }

  if (facts.childElementCount > 0) card.appendChild(facts);

  const endDateText = formatLimitedPriceEndDate(latest.limited_price_end_date);
  if (endDateText) {
    const endDate = document.createElement("div");
    endDate.className = `end-date${offerOver ? " over" : ""}`;
    endDate.textContent = offerOver ? `${endDateText}(終了)` : endDateText;
    card.appendChild(endDate);
  }

  if (unconfirmed) {
    const note = document.createElement("div");
    note.className = "unconfirmed-note";
    // 一覧から外れた商品はスクレイパーが二度と触らないので、この価格が今も
    // 有効とは限らない。最後に確認できた日を添える。
    note.textContent = `直近の巡回では確認できませんでした(最終確認 ${stageDateFormatter.format(new Date(latest.scraped_at))})`;
    card.appendChild(note);
  }

  // 周期が2回以上ある商品は、下の周期の一覧に開始日が入っているので出さない。
  // 「7/11〜」だけを出すと、今の期間限定が7/11から続いているように読める。
  if (isLimitedFamily && periods.length <= 1) {
    const sinceIso = firstLimitedSeenDate(history);
    if (sinceIso) {
      const since = document.createElement("div");
      since.className = "limited-since";
      since.textContent = `期間限定価格を確認: ${stageDateFormatter.format(new Date(sinceIso))}〜`;
      card.appendChild(since);
    }
  }

  const updated = document.createElement("div");
  updated.className = "updated";
  // 同じ情報を長短2通り持たせ、どちらを出すかは幅に応じてCSSが決める。
  // スマホでは「最終確認: 2026年8月21日 21:20」が1行を丸ごと使ってしまう。
  const scrapedAt = new Date(latest.scraped_at);
  const updatedFull = document.createElement("span");
  updatedFull.className = "updated-full";
  updatedFull.textContent = `最終確認: ${dateFormatter.format(scrapedAt)}`;
  const updatedShort = document.createElement("span");
  updatedShort.className = "updated-short";
  updatedShort.textContent = `確認 ${stageDateFormatter.format(scrapedAt)}`;
  updated.appendChild(updatedFull);
  updated.appendChild(updatedShort);
  card.appendChild(updated);

  // 価格の推移は折れ線ではなく文字で出す。期間限定は終わると価格が戻るため、
  // 折れ線にすると戻りの上昇が値上げのように見えてしまうし、値下げ側も
  // 目盛りの無い線より実際の金額と日付が並んでいる方が読める。
  const historyText = priceHistoryTextFor({ isMarkdownFamily, isLimitedFamily, stagePoints, periods, history });
  if (historyText) {
    const priceHistory = document.createElement("div");
    priceHistory.className = "stage-history";
    priceHistory.textContent = historyText;
    card.appendChild(priceHistory);
  }

  return card;
}

function appendDateSummary(section, entries) {
  if (entries.length === 0) return;
  const summary = document.createElement("div");
  summary.className = "date-summary";
  for (const { label, count } of entries) {
    const chip = document.createElement("span");
    chip.className = "date-chip";
    chip.textContent = `${label}(${count})`;
    summary.appendChild(chip);
  }
  section.appendChild(summary);
}

function appendProductGroup(section, labelText, products) {
  // <details>/<summary> をそのまま使う。開閉の状態・キーボード操作・スクリーン
  // リーダーへの伝わり方が標準で付いてくるので、自前で真似しない。
  const group = document.createElement("details");
  group.className = "category-group";

  const summary = document.createElement("summary");
  const overCount = products.filter((p) => p.offerOver).length;

  const label = document.createElement("span");
  label.className = "group-label";
  label.textContent = labelText;
  summary.appendChild(label);

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = `${products.length}件`;
  summary.appendChild(count);

  // 「12件」のうち何件がもう終わっているのかが、開かなくても分かるようにする。
  if (overCount > 0) {
    const over = document.createElement("span");
    over.className = "group-over";
    over.textContent = `うち終了 ${overCount}`;
    summary.appendChild(over);
  }
  group.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "grid";
  group.appendChild(grid);

  // 閉じている間はカードを作らない。全カテゴリぶんを最初に組み立てると1,000件
  // 超のカードがDOMに載るが、実際に開かれるのはそのうちのごく一部。初めて
  // 開かれた時に一度だけ描く。
  let rendered = false;
  group.addEventListener("toggle", () => {
    if (!group.open || rendered) return;
    rendered = true;
    // 有効なものを先に、終了・未確認を後ろへ。並び順以外は元の順序を保つ。
    const ordered = [...products].sort(
      (a, b) => (a.offerOver ? 2 : a.unconfirmed ? 1 : 0) - (b.offerOver ? 2 : b.unconfirmed ? 1 : 0)
    );
    for (const product of ordered) {
      try {
        grid.appendChild(renderCard(product));
      } catch (err) {
        console.error(`failed to render card for ${product.latest.product_id}`, err);
      }
    }
  });

  section.appendChild(group);
}

function renderContent() {
  contentEl.innerHTML = "";
  contentEl.style.setProperty("--brand-color", BRAND_CONFIG[state.brand].color);

  const bucket = index?.[state.brand]?.[state.gender];
  const hasAny = bucket && EVENT_TYPE_CONFIG.some((e) => bucket[e.key] && Object.keys(bucket[e.key]).length > 0);

  if (!hasAny) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "このブランド・性別に該当する商品データがまだありません。";
    contentEl.appendChild(empty);
    return;
  }

  for (const eventConfig of EVENT_TYPE_CONFIG) {
    const byCategory = bucket[eventConfig.key];
    if (!byCategory) continue;
    const categories = Object.keys(byCategory);
    if (categories.length === 0) continue;

    const total = categories.reduce((sum, c) => sum + byCategory[c].length, 0);
    // セクション見出しの件数が最初に目に入る数字なので、そのうち何件が
    // すでに終了しているのかをここでも示す。
    const overTotal = categories.reduce(
      (sum, c) => sum + byCategory[c].filter((p) => p.offerOver).length,
      0
    );

    const section = document.createElement("section");
    section.className = "section";
    section.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);

    const header = document.createElement("div");
    header.className = "section-header";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = eventConfig.label;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = overTotal > 0 ? `${total}件(うち終了 ${overTotal})` : `${total}件`;
    header.appendChild(label);
    header.appendChild(count);
    section.appendChild(header);

    if (eventConfig.key === "markdown") {
      const allProducts = categories.flatMap((c) => byCategory[c]);
      // "直近で値下げが確認された日" — each product's own most recent 値下げ段階
      // (i.e. when its *current* price was first observed), grouped by day.
      appendDateSummary(
        section,
        groupProductsByDate(allProducts, (p) => {
          const points = markdownStagePoints(p.history);
          return points.length ? points[points.length - 1].scraped_at : null;
        })
      );

      // Grouped by 値下げ段階 instead of category here — how many times a
      // product has been discounted is the more useful axis to browse this
      // particular section by (category grouping is still used everywhere
      // else). 初値下げ is always exactly stage 1, so grouping it the same
      // way wouldn't add anything.
      const byStage = new Map();
      for (const product of allProducts) {
        const stage = markdownStagePoints(product.history).length;
        if (!byStage.has(stage)) byStage.set(stage, []);
        byStage.get(stage).push(product);
      }
      for (const stage of [...byStage.keys()].sort((a, b) => a - b)) {
        appendProductGroup(section, `${stage}段階目`, byStage.get(stage));
      }
    } else {
      if (eventConfig.key === "limited") {
        // "直近で期間限定入りが確認された日" — 何週間も期間限定を繰り返している
        // 商品は初回ではなく、いま出ている周期の開始日で数える。初回の日付だと
        // 「最近期間限定に入った商品」を探しているときに何週間も前の日付が並ぶ。
        appendDateSummary(
          section,
          groupProductsByDate(
            categories.flatMap((c) => byCategory[c]),
            (p) => currentLimitedStartDate(p.history)
          )
        );
      }

      for (const category of categoryOrderFor(state.brand, categories)) {
        const products = byCategory[category];
        if (!products || products.length === 0) continue;
        appendProductGroup(section, category, products);
      }
    }

    contentEl.appendChild(section);
  }
}

function setActiveTab(container, attr, value) {
  for (const btn of container.querySelectorAll("button")) {
    const isActive = btn.dataset[attr] === value;
    btn.classList.toggle("active", isActive);
    // 選択状態を色だけに頼らせない。スクリーンリーダーには押下状態として
    // 伝わり、ハイコントラスト設定などで配色が置き換わる環境でも意味が残る。
    btn.setAttribute("aria-pressed", String(isActive));
  }
}

function updateTabs() {
  setActiveTab(brandTabsEl, "brand", state.brand);
  setActiveTab(genderTabsEl, "gender", state.gender);
}

brandTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-brand]");
  if (!btn) return;
  state = { ...state, brand: btn.dataset.brand };
  updateTabs();
  renderContent();
});

genderTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-gender]");
  if (!btn) return;
  state = { ...state, gender: btn.dataset.gender };
  updateTabs();
  renderContent();
});

async function main() {
  const { data, error } = await supabase
    .from("price_events")
    .select(
      "product_id, product_name, brand, gender, category, event_type, url, price, list_price, currency, price_type, stock_status, in_stock_size_count, scraped_at, limited_price_end_date"
    )
    .order("scraped_at", { ascending: true });

  if (error) {
    statusEl.textContent = `データの読み込みに失敗しました: ${error.message}`;
    statusEl.classList.add("error");
    return;
  }

  if (!data || data.length === 0) {
    statusEl.textContent = "まだ価格データがありません。スクレイパーの初回実行をお待ちください。";
    updateTabs();
    return;
  }

  statusEl.textContent = "";
  index = buildIndex(data);
  updateTabs();
  renderContent();
}

main();
