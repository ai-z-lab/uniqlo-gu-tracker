import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");
const brandTabsEl = document.getElementById("brand-tabs");
const genderTabsEl = document.getElementById("gender-tabs");
const groupTabsEl = document.getElementById("group-tabs");

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

let state = { brand: "uniqlo", gender: "men", groupBy: "date" };
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

// 曜日を添えるのは、値下げも期間限定も曜日で回っているため — 通常値下げは
// 火曜、期間限定は金曜開始・木曜終了。日付だけだと、その日が周期のどこに
// あたるのかが読み取れない。
const weekdayFormatter = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "Asia/Tokyo" });
const weekdayUtcFormatter = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "UTC" });

// e.g. "8/25(火)"。scraped_at は時刻を持つので日本時間で、
// limited_price_end_date は日付だけなので UTC として読む。
function formatDayWithWeekday(value, { plainDate = false } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = plainDate ? shortEndDateFormatter : stageDateFormatter;
  const weekday = plainDate ? weekdayUtcFormatter : weekdayFormatter;
  return `${day.format(date)}(${weekday.format(date)})`;
}

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

// --- 曜日別の価格変動集計 ---------------------------------------------------

// 曜日も日本時間で数える。値下げも期間限定も日本時間の早朝(期間限定は金曜
// 2:00)に入れ替わるので、閲覧者のローカル時間で曜日を出すと切り替えの前後が
// 1日ずれる地域が出る。jstDayOf() が返すのは日本時間の暦日 "YYYY-MM-DD" なので、
// UTC の0時として解釈して getUTCDay() を読めば、閲覧者のタイムゾーンに関係なく
// 同じ曜日になる。
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
// 表示は月曜始まり(日本の暦の並び)。
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function weekdayIndexOf(jstDay) {
  const date = new Date(`${jstDay}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function nextJstDay(jstDay) {
  const date = new Date(`${jstDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 商品の履歴を「日本時間の1日につき1行」に畳む。
//
// スクレイパーは同じ商品・同じ日の行を上書きするので基本は1日1行だが、
// 同日判定が UTC だった頃(〜2026-08)の行だけは、日本時間で見ると同じ日に
// 2行あることがある。その日の最後の記録を採る。
function rowsByJstDay(history) {
  const byDay = new Map();
  for (const row of history) {
    const day = jstDayOf(row.scraped_at);
    if (day) byDay.set(day, row);
  }
  return byDay;
}

// 曜日ごとに「前日から価格が動いていた回数」を数える。
//
// 数えているのは *変化を確認した* 曜日であって、値札が書き換わった瞬間の曜日
// ではない。巡回は1日1回(日本時間の早朝)なので、ある日の巡回で見つかる変化は
// 「前日の巡回以降のどこかで起きた」までしか分からない。期間限定価格の
// 入れ替わりは金曜2:00(JST)で、朝4:30の巡回はその直後にあたるため、この
// ずれが実用上いちばん効くケースでは曜日は一致する。
//
// 前日の記録が無い商品日(巡回の失敗、一覧に載っていなかった日、記録開始前)は
// 比較の対象にしない。「前々日から動いていた」ことは分かっても、それが
// どちらの日に起きたのかは決められないため。数えずに捨てるのではなく
// skippedChanges として持ち帰り、除外した件数を画面に出す。
function weekdayPriceChangeStats(products) {
  const byWeekday = WEEKDAY_LABELS.map(() => ({ comparisons: 0, downs: 0, ups: 0 }));
  let skippedChanges = 0;

  for (const { history } of products) {
    const byDay = rowsByJstDay(history);
    const days = [...byDay.keys()].sort();
    for (let i = 1; i < days.length; i++) {
      const previousDay = days[i - 1];
      const day = days[i];
      const diff = byDay.get(day).price - byDay.get(previousDay).price;
      if (nextJstDay(previousDay) !== day) {
        if (diff !== 0) skippedChanges += 1;
        continue;
      }
      const weekday = weekdayIndexOf(day);
      if (weekday === null) continue;
      const bucket = byWeekday[weekday];
      bucket.comparisons += 1;
      if (diff < 0) bucket.downs += 1;
      else if (diff > 0) bucket.ups += 1;
    }
  }

  return { byWeekday, skippedChanges };
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

// --- 日付でまとめる ---
//
// 「その日に何が値下げされたか」を出すのが、このダッシュボードのいちばんの
// 用途。従来は日付をチップで件数だけ示していて、そこから商品にたどり着く
// 手段が無かった。日付そのものを見出しにする。

// 値下げ商品の「その価格になった日」。値下げ段階の最後の点がそれにあたる
// (同じ価格で再観測された行は段階にまとめられているため、初めてその価格が
// 観測された日が出る)。
function markdownDateOf(product) {
  const points = markdownStagePoints(product.history);
  return points.length > 0 ? points[points.length - 1].scraped_at : product.latest.scraped_at;
}

// 期間限定はいま出ている周期そのものでまとめる。同じ週の期間限定が1つの
// かたまりになり、参照している分析サイトが追っている週次の履歴と同じ単位に
// なる。
function limitedPeriodOf(product) {
  const periods = limitedPeriods(product.history);
  return periods.length > 0 ? periods[periods.length - 1] : null;
}

function dateGroupOf(product, eventKey) {
  if (LIMITED_EVENT_TYPES.has(eventKey)) {
    const period = limitedPeriodOf(product);
    // 終了日でまとめる。同じ週の期間限定は同じ終了日を持つ(金曜開始・木曜終了)
    // ので、これが週次の周期そのものになる。開始日でまとめると、同じ offer でも
    // 金曜に拾えた商品と数日後に拾えた商品が別のかたまりに割れてしまう。
    //
    // 表示も終了日にする。開始日として出せるのは「このトラッカーが最初に
    // 確認できた日」であって offer の開始日ではないため、範囲で見せると
    // 実際より遅く始まったように読めてしまう。終了日はサイト自身が
    // 「8/27まで期間限定価格」と示している事実。
    if (period?.endDate) {
      return {
        key: `end:${period.endDate}`,
        label: `${formatDayWithWeekday(new Date(period.endDate), { plainDate: true })}まで`,
        sortValue: Date.parse(`${period.endDate}T00:00:00Z`),
      };
    }
    const from = period?.from ?? product.latest.scraped_at;
    return { key: `from:${jstDayOf(from)}`, label: `${formatDayWithWeekday(from)}〜`, sortValue: Date.parse(from) };
  }
  // 値上げには「値下げ段階」が無いので、観測した日そのものを使う。
  const iso = eventKey === "price_up" ? product.latest.scraped_at : markdownDateOf(product);
  return { key: jstDayOf(iso) ?? String(iso), label: formatDayWithWeekday(iso) ?? "日付不明", sortValue: Date.parse(iso) };
}

function groupProductsByDateGroup(products, eventKey) {
  const groups = new Map();
  for (const product of products) {
    const { key, label, sortValue } = dateGroupOf(product, eventKey);
    if (!groups.has(key)) groups.set(key, { label, sortValue, products: [] });
    groups.get(key).products.push(product);
  }
  // 新しい日付を上に。「今日なにが値下げされたか」を探しに来るため。
  return [...groups.values()].sort((a, b) => b.sortValue - a.sortValue);
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

const countFormatter = new Intl.NumberFormat("ja-JP");

// 「曜日別の価格変動」パネル。いま選んでいるブランド・性別の全商品が対象。
//
// 棒の長さは件数ではなく変化率(比較1件あたり何回動いたか)にしている。曜日ごとに
// 比較できた商品日数が揃わない — 巡回が失敗した日、商品が一覧から外れた日、
// 記録開始前の日はそのぶん母数が減る — ため、件数をそのまま並べると
// 「巡回できた日が多い曜日」が長く出るだけの図になる。件数は数字で併記する。
function appendWeekdaySummary(container, products) {
  const { byWeekday, skippedChanges } = weekdayPriceChangeStats(products);

  const totalComparisons = byWeekday.reduce((sum, w) => sum + w.comparisons, 0);
  if (totalComparisons === 0) return; // 2日以上の履歴がある商品がまだ無い

  const totalChanges = byWeekday.reduce((sum, w) => sum + w.downs + w.ups, 0);
  const rateOf = (w) => (w.comparisons === 0 ? 0 : (w.downs + w.ups) / w.comparisons);
  const maxRate = Math.max(...byWeekday.map(rateOf));

  const section = document.createElement("section");
  section.className = "section weekday-summary";

  const header = document.createElement("div");
  header.className = "section-header";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "曜日別の価格変動";
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = `直近${HISTORY_WINDOW_DAYS}日・${countFormatter.format(totalChanges)}件`;
  header.appendChild(label);
  header.appendChild(count);
  section.appendChild(header);

  const rows = document.createElement("ul");
  rows.className = "weekday-rows";

  for (const weekday of WEEKDAY_DISPLAY_ORDER) {
    const stats = byWeekday[weekday];
    const rate = rateOf(stats);
    const changes = stats.downs + stats.ups;

    const row = document.createElement("li");
    row.className = "weekday-row";
    // 母数まで画面に並べると7行が読めなくなるので、行そのものに持たせる。
    row.title =
      stats.comparisons === 0
        ? `${WEEKDAY_LABELS[weekday]}曜: 前日と比較できた記録がありません`
        : `${WEEKDAY_LABELS[weekday]}曜: 前日と比較できた${countFormatter.format(stats.comparisons)}件のうち` +
          `${countFormatter.format(changes)}件で価格が動きました(値下げ${countFormatter.format(stats.downs)}・値上げ${countFormatter.format(stats.ups)})`;

    const day = document.createElement("span");
    day.className = "weekday-day";
    day.textContent = WEEKDAY_LABELS[weekday];
    row.appendChild(day);

    // 棒は絵として読むもので、同じ数字が右側に文字でも出ている。
    // 読み上げでは二度手間になるだけなので外す。
    const track = document.createElement("span");
    track.className = "weekday-track";
    track.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "weekday-fill";
    fill.style.width = maxRate > 0 ? `${(rate / maxRate) * 100}%` : "0%";
    // 棒の中の値下げ・値上げの比。0件の側は要素ごと作らない(幅0の要素が
    // border-radius だけ残って点に見えるため)。
    for (const [kind, value] of [["down", stats.downs], ["up", stats.ups]]) {
      if (value === 0) continue;
      const part = document.createElement("span");
      part.className = `weekday-part ${kind}`;
      part.style.flexGrow = String(value);
      fill.appendChild(part);
    }
    track.appendChild(fill);
    row.appendChild(track);

    const counts = document.createElement("span");
    counts.className = "weekday-counts";
    // 0件の曜日は色を落とす。7行のうち動きのある曜日は数えるほどしかなく、
    // すべて同じ濃さで並べると、どこを見ればいいのかが読み取りにくい。
    for (const [kind, word, value] of [["down", "値下げ", stats.downs], ["up", "値上げ", stats.ups]]) {
      const el = document.createElement("span");
      el.className = value === 0 ? `${kind} zero` : kind;
      el.textContent = `${word}${countFormatter.format(value)}`;
      counts.appendChild(el);
    }
    row.appendChild(counts);

    const rateEl = document.createElement("span");
    rateEl.className = "weekday-rate";
    rateEl.textContent = stats.comparisons === 0 ? "—" : `${(rate * 100).toFixed(1)}%`;
    row.appendChild(rateEl);

    rows.appendChild(row);
  }
  section.appendChild(rows);

  const note = document.createElement("p");
  note.className = "weekday-note";
  // この集計が何を数えていないのかを、数字の隣に置く。
  note.textContent =
    "前日の巡回から価格が変わっていた商品を、変化を確認した曜日で数えています。巡回は日本時間の早朝に1回なので、" +
    "値札が実際に変わったのは前日の巡回以降のどこかです。%と棒の長さは前日と比較できた件数に対する割合 — " +
    "曜日ごとに比較できた件数が違うためです。期間限定価格が終わって元に戻った商品は値上げに数えます。";
  if (skippedChanges > 0) {
    note.textContent +=
      `前日の記録が無く、どちらの日に動いたか決められない変化${countFormatter.format(skippedChanges)}件は数えていません。`;
  }
  section.appendChild(note);

  container.appendChild(section);
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

  // 個別の商品より先に、その日どこを見るべきかの当たりが付く数字を出す。
  appendWeekdaySummary(
    contentEl,
    EVENT_TYPE_CONFIG.flatMap((e) => Object.values(bucket[e.key] || {}).flat())
  );

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

    const allProducts = categories.flatMap((c) => byCategory[c]);

    if (state.groupBy === "date") {
      for (const group of groupProductsByDateGroup(allProducts, eventConfig.key)) {
        appendProductGroup(section, group.label, group.products);
      }
    } else {
      // 日付チップはカテゴリ順のときだけ出す。日付順では見出しがそれ自体で
      // 同じことを示すので、並べると二重になる。
      if (eventConfig.key === "markdown" || eventConfig.key === "limited") {
        appendDateSummary(
          section,
          groupProductsByDate(allProducts, (p) =>
            eventConfig.key === "limited" ? currentLimitedStartDate(p.history) : markdownDateOf(p)
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
  setActiveTab(groupTabsEl, "groupby", state.groupBy);
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

groupTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-groupby]");
  if (!btn) return;
  state = { ...state, groupBy: btn.dataset.groupby };
  updateTabs();
  renderContent();
});

const PRICE_EVENT_COLUMNS =
  "product_id, product_name, brand, gender, category, event_type, url, price, list_price, currency, price_type, stock_status, in_stock_size_count, scraped_at, limited_price_end_date";

// PostgREST は1リクエストで返す行数に上限を持っていて、超えた分は
// エラーにならず黙って切り捨てられる。このプロジェクトの上限は1,000行。
//
// 2026-08-25 に実際にこれで壊れていた。上限を付けずに scraped_at の昇順で
// 取っていたため、全3,057行のうち「いちばん古い1,000行」(8/15〜8/22)だけが
// 返り、8/23以降が丸ごと見えなくなっていた。巡回は毎朝成功して書き込めて
// いたのに、公開サイトだけが数日前で止まって見えていた。
//
// range で最後まで辿る。降順で取るのは失敗の仕方を変えるため — 何かの理由で
// 全件を取り切れなくても、欠けるのは古い履歴であって現在の価格ではない。
// buildIndex は商品ごとに時系列へ並べ直すので、渡す順序は問わない。
const PAGE_SIZE = 1000;
// 1日あたり約900行増えるため、無制限に読むと表示までの待ち時間と通信量が
// 際限なく伸びる。値下げの段階も期間限定の周期もこの範囲に収まる。
const HISTORY_WINDOW_DAYS = 35;
// 窓を広げすぎた時の保険。ここに達したら、黙って切り捨てず気づけるようにする。
const MAX_ROWS = 30000;

async function fetchPriceEvents() {
  const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = [];

  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("price_events")
      .select(PRICE_EVENT_COLUMNS)
      .gte("scraped_at", since)
      .order("scraped_at", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { rows: null, error };
    rows.push(...data);
    // 1ページ分に満たなければ、そこが最後。
    if (data.length < PAGE_SIZE) return { rows, error: null };
  }

  console.warn(
    `price_events: ${MAX_ROWS}行の上限に達しました。これより古い履歴は読み込んでいません。`
  );
  return { rows, error: null };
}

async function main() {
  const { rows: data, error } = await fetchPriceEvents();

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
