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
  {
    key: "price_up",
    label: "値上げ",
    sectionLabel: "値上げ・価格改定",
    note:
      "値下げ中だった商品の価格が上がったものです(昨年モデルの秋の再販で処分価格から戻った場合など)。" +
      "値上げ後も値下げ一覧に残っている商品は、次に値下げされるまでここに出ます。期間限定価格が終わって元の値下げ価格に戻っただけの商品は含みません。",
  },
];

// 各セクションを日付で切るときの「いつその状態になったか」。
// - 値下げ: 直近の値下げ段階の日(＝いまの価格になった日)
// - 初値下げ・初期間限定: このトラッカーが最初にその商品を確認した日
// - 期間限定: いま出ている周期が始まった日
// - 値上げ: 価格が実際に動いた最後の日
// 値下げ・値上げはどちらも「値下げ一覧側の価格が最後に動いた日」。値上げ
// セクションに入るのは最後の動きが値上げだった商品だけなので、これが値上げ日になる。
const lastMarkdownTrackChange = (p) => {
  const points = markdownStagePoints(p.history);
  return points.length ? points[points.length - 1].scraped_at : null;
};

const DATE_AXIS = {
  markdown: lastMarkdownTrackChange,
  first_markdown: (p) => p.history[0]?.scraped_at ?? null,
  first_limited: (p) => p.history[0]?.scraped_at ?? null,
  limited: (p) => currentLimitedStartDate(p.history),
  price_up: lastMarkdownTrackChange,
};

// 日付チップで絞り込んだときの見出しの言い方。「に確認」だけだと、巡回で
// 確認した日なのか値札が変わった日なのか分からない、という指摘があったため。
const DATE_VERB = {
  markdown: "に値下げ",
  first_markdown: "に初めて値下げ一覧で確認",
  limited: "から期間限定",
  first_limited: "に初めて期間限定で確認",
  price_up: "に値上げ",
};

// 開いた直後に直近の日付で絞り込むセクション。「その日に新しく起きたこと」を
// 並べるセクションはこちら、継続中のものを一覧するセクションは「すべて」から。
const DEFAULT_TO_LATEST_DATE = new Set(["markdown", "first_markdown", "first_limited", "price_up"]);

// 日付で絞り込んだとき、この件数までのグループは開いた状態で出す。1日ぶんは
// たいてい数件〜数十件で、そこで一段開かせるのはただの手間。
const AUTO_OPEN_MAX = 30;

const CATEGORY_ORDER = {
  uniqlo: ["トップス", "シャツ", "アウター", "パンツ", "ワンピース", "ビジネス", "インナー・ルームウェア", "その他"],
  gu: ["トップス", "アウター・パンツ", "ワンピース", "グッズ・その他"],
};

// 曜日タブの「すべて」。数値(0=日〜6=土)と混ざらない値にしておく。
const ALL_WEEKDAYS = "all";

let state = { brand: "uniqlo", gender: "men", weekday: ALL_WEEKDAYS };
let allRows = [];
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

// 値下げ一覧側の価格の流れには値上げ(price_up)の行も含める。
//
// 値下げ中の商品が値上げされる(昨年のAW商品が秋に再販され、処分価格から
// 価格改定される等)と、スクレイパーが price_up と書くのはその日の1行だけで、
// 翌日からはまた一覧由来の markdown になる。price_up を外すと、翌日の markdown
// 行が「値上げ後の価格」を新しい値下げ段階として数えてしまっていた。
// 期間限定が終わって元の値下げ価格に戻ったときも price_up になるが、その価格は
// 期間限定の前の値下げ段階と同じなので、ここでは点が増えない。
const MARKDOWN_TRACK_EVENT_TYPES = new Set([...MARKDOWN_EVENT_TYPES, "price_up"]);

// A distinct "値下げ段階" — "3段階目" means "the 3rd distinct price this
// product has had while markdown-listed", not "3 rows in the DB".
// 前の点より高い点は up(値上げ)として持ち、段階には数えない。stage はその点の
// 時点で何段階目か(値上げの点では直前の段階のまま)。
function markdownStagePoints(history) {
  const points = priceStagePoints(history, MARKDOWN_TRACK_EVENT_TYPES);
  let stage = 0;
  return points.map((point, i) => {
    const up = i > 0 && point.price > points[i - 1].price;
    if (!up) stage += 1;
    return { ...point, up, stage };
  });
}

function markdownStageCount(points) {
  return points.length > 0 ? points[points.length - 1].stage : 0;
}

// 値下げ中だった商品が、直近の値動きで値上げされたか。期間限定の終了(元の
// 値下げ価格に戻っただけ)はここに入らない — 上の markdownStagePoints を参照。
function isRaisedFromMarkdown(points) {
  return points.length > 1 && points[points.length - 1].up;
}

// どのセクションに出すか。基本は最新行の event_type(どの一覧で見つけたか)だが、
// 値上げはその日1行しか price_up にならないため、履歴から決め直す。
// - 値下げ中に値上げされ、そのあと値下げされていない → 値上げ(翌日以降も残す)
// - price_up でも値下げ価格に戻っただけ(期間限定の終了) → 値下げ
function sectionKeyOf(latest, history) {
  const eventType = latest.event_type || "markdown";
  if (LIMITED_EVENT_TYPES.has(eventType)) return eventType;
  if (isRaisedFromMarkdown(markdownStagePoints(history))) return "price_up";
  return eventType === "price_up" ? "markdown" : eventType;
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

// 2つの時点が日本時間で何日離れているか。時刻ではなく暦日の差で数えるので、
// 巡回時刻が3:00の日と4:00の日をまたいでも「1日」がぶれない。
function daysBetween(fromIso, toIso) {
  const from = jstDayOf(fromIso);
  const to = jstDayOf(toIso);
  if (!from || !to) return null;
  return Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000));
}

// 「21日ぶり」「3週間ぶり」— 直前の段階からどれだけ空いたか。2週間を超えたら
// 週で言い換える。日数のままだと「35日」がどれくらいかを頭の中で割ることになる。
function formatInterval(days) {
  if (days === null || days <= 0) return null;
  if (days < 14) return `${days}日ぶり`;
  return `${Math.round(days / 7)}週間ぶり`;
}

// e.g. "¥1,990(7/8)→¥1,290(7/13)→¥990(7/28)→¥790(8/18)"
function formatMarkdownStageHistory(points) {
  const fmt = currencyFormatter(points[0]?.currency ?? "JPY");
  return points.map((p) => `${fmt.format(p.price)}(${stageDateFormatter.format(new Date(p.scraped_at))})`).join(" → ");
}

// 値下げの段階を「何段階目・いくら・いつ・前回から何日」まで含めて組み立てる。
// カード1枚で「いつ値下げになり、いまが何段階目で、前回からどれだけ空いたか」が
// 読めるようにするためのもので、段階でグループを開いて回る必要をなくす。
function markdownStageSteps(points) {
  const fmt = currencyFormatter(points[0]?.currency ?? "JPY");
  return points.map((point, i) => {
    const gap = i === 0 ? null : daysBetween(points[i - 1].scraped_at, point.scraped_at);
    return {
      stage: point.stage,
      up: point.up,
      price: fmt.format(point.price),
      date: stageDateFormatter.format(new Date(point.scraped_at)),
      gapDays: gap,
      current: i === points.length - 1,
    };
  });
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
//
// キーは日本時間の暦日("YYYY-MM-DD")。日付チップは押して絞り込めるので、
// 表示用の "9/1" ではなく、商品を突き合わせられる値を持たせる(年をまたぐと
// "9/1" は2つありうる)。
function groupProductsByDate(products, dateOf) {
  const counts = new Map(); // "YYYY-MM-DD" -> count
  for (const product of products) {
    const day = jstDayOf(dateOf(product) ?? "");
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 14)
    .map(([day, count]) => ({ key: day, label: formatJstDayLabel(day), count }));
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
// ではない。巡回は日本時間の3:00(と、取りこぼし用の4:00)で、記録は1日1行に
// 畳まれるため、ある日の巡回で見つかる変化は「前日の巡回以降のどこかで起きた」
// までしか分からない。値下げ・期間限定価格の入れ替わりは日本時間の朝3時前後
// なので、このずれが実用上いちばん効くケースでは曜日は一致する。
//
// 前日の記録が無い商品日(巡回の失敗、一覧に載っていなかった日、記録開始前)は
// 比較の対象にしない。「前々日から動いていた」ことは分かっても、それが
// どちらの日に起きたのかは決められないため。数えずに捨てるのではなく
// skippedChanges として持ち帰り、除外した件数を画面に出す。
function weekdayPriceChangeStats(products) {
  const byWeekday = WEEKDAY_LABELS.map(() => ({
    comparisons: 0,
    downs: 0,
    ups: 0,
    // この曜日を何回観測できたか(前日と比較できた日の集合)と、そのうち値下げが
    // あったのはどの日か。曜日タブの「定例/緊急」の判定と、タブを開いたときに
    // 出す日付ごとの商品一覧に使う。件数だけでは「毎週きまって来る曜日」と
    // 「たまに大量に来る曜日」を区別できない。
    observedDays: new Set(),
    downsByDay: new Map(), // "YYYY-MM-DD" -> [product]
  }));
  let skippedChanges = 0;

  for (const product of products) {
    const byDay = rowsByJstDay(product.history);
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
      bucket.observedDays.add(day);
      if (diff < 0) {
        bucket.downs += 1;
        if (!bucket.downsByDay.has(day)) bucket.downsByDay.set(day, []);
        bucket.downsByDay.get(day).push(product);
      } else if (diff > 0) bucket.ups += 1;
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
    // いま買えない商品。期間限定が終了したもの(価格がもう戻っている)と、
    // 全サイズ在庫切れのもの。一覧の主役から下ろすが、消しはしない
    // (appendProductGroup がグループ内の折りたたみに退避する)。
    // stock_status が null の商品は「在庫が読めなかった」であって在庫なしでは
    // ないため、ここには入れない。
    const soldOut = latest.stock_status === "stock_out";
    const hidden = offerOver || soldOut;
    const brand = latest.brand;
    const gender = latest.gender || "unknown";
    const eventType = sectionKeyOf(latest, history);
    const category = latest.category || (brand === "gu" ? "グッズ・その他" : "その他");

    idx[brand] ??= {};
    idx[brand][gender] ??= {};
    idx[brand][gender][eventType] ??= {};
    idx[brand][gender][eventType][category] ??= [];
    idx[brand][gender][eventType][category].push({
      latest,
      history,
      // カテゴリはこの時点で解決済み(latest.category が空なら既定値)。日付で
      // 絞り込んだあとにカテゴリで組み直すので、商品自身に持たせておく。
      category,
      // 出しているセクション。値上げは最新行の event_type と一致しないことが
      // ある(sectionKeyOf)ので、カードのバッジや段階の数え方はこちらを見る。
      section: eventType,
      offerOver,
      unconfirmed,
      soldOut,
      hidden,
    });
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
  if (eventType === "markdown" && stagePoints.length > 0) return `(${markdownStageCount(stagePoints)}段階目)`;
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

  const { section } = product;
  const isMarkdownFamily = MARKDOWN_EVENT_TYPES.has(section);
  const isLimitedFamily = LIMITED_EVENT_TYPES.has(section);
  // 値上げも値下げと同じ流れの上にある(値下げ→値上げ→また値下げ…)ので、
  // 段階のタイムラインをそのまま出す。
  const isMarkdownTrack = isMarkdownFamily || section === "price_up";
  const stagePoints = isMarkdownTrack ? markdownStagePoints(history) : [];
  const periods = isLimitedFamily ? limitedPeriods(history) : [];

  const eventConfig = EVENT_TYPE_CONFIG.find((e) => e.key === section);
  if (eventConfig) {
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);
    // "初値下げ"/"初期間限定" are always exactly the 1st by definition (see
    // classifyEventType in scripts/scrape.mjs), so the count only adds
    // information for a *follow-up* observation — append it there instead of
    // duplicating "(1段階目)" on every 初値下げ badge.
    badge.textContent = `${eventConfig.label}${countSuffixFor(section, stagePoints, periods)}`;
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

  if (section === "price_up" && stagePoints.length > 1) {
    // 値上げは翌日以降もこのセクションに残るので、前日比ではなく値上げ前の
    // 価格との差と、値上げした日を出す。前日比だと2日目から消えてしまう。
    const before = stagePoints[stagePoints.length - 2];
    const after = stagePoints[stagePoints.length - 1];
    const delta = document.createElement("span");
    delta.className = "delta up";
    delta.textContent = `+${fmt.format(after.price - before.price)}(${stageDateFormatter.format(new Date(after.scraped_at))})`;
    priceRow.appendChild(delta);
  } else if (previous && previous.price !== latest.price) {
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

  // 前回の値下げ(期間限定なら前回の周期)からどれだけ空いたか。カードを見た
  // 瞬間に「今日きたばかりか、ずっと据え置きか」が分かるようにする。
  const intervalText = formatInterval(
    isMarkdownFamily && stagePoints.length > 1
      ? daysBetween(stagePoints[stagePoints.length - 2].scraped_at, stagePoints[stagePoints.length - 1].scraped_at)
      : isLimitedFamily && periods.length > 1
        ? daysBetween(periods[periods.length - 2].from, periods[periods.length - 1].from)
        : null
  );
  if (intervalText) {
    const interval = document.createElement("span");
    interval.className = "fact interval";
    interval.textContent = intervalText;
    facts.appendChild(interval);
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
  updatedFull.textContent = `最終巡回: ${dateFormatter.format(scrapedAt)}`;
  const updatedShort = document.createElement("span");
  updatedShort.className = "updated-short";
  updatedShort.textContent = `巡回 ${stageDateFormatter.format(scrapedAt)}`;
  updated.appendChild(updatedFull);
  updated.appendChild(updatedShort);
  card.appendChild(updated);

  // 価格の推移は折れ線ではなく文字で出す。期間限定は終わると価格が戻るため、
  // 折れ線にすると戻りの上昇が値上げのように見えてしまうし、値下げ側も
  // 目盛りの無い線より実際の金額と日付が並んでいる方が読める。
  if (isMarkdownTrack && stagePoints.length > 0) {
    // 値下げは段階そのものが読みたい情報なので、1行のテキストではなく段階ごとの
    // 塊にする。「1段階目 ¥3,490 8/4 → 2段階目 ¥2,990 8/11(7日後)」のように、
    // 何段階目・いくら・いつ・前回からどれだけ空いたかが1枚で追える。
    const timeline = document.createElement("div");
    timeline.className = "stage-history stage-timeline";
    const steps = markdownStageSteps(stagePoints);
    steps.forEach((step, i) => {
      if (i > 0) {
        const arrow = document.createElement("span");
        arrow.className = "stage-arrow";
        arrow.textContent = "→";
        timeline.appendChild(arrow);
      }
      const el = document.createElement("span");
      el.className = `stage-step${step.current ? " current" : ""}${step.up ? " up" : ""}`;
      const stage = document.createElement("span");
      stage.className = "stage-no";
      // 値上げは段階に数えない。値下げ→値上げ→値下げの順なら「1段階目→値上げ→
      // 2段階目」と読める。
      stage.textContent = step.up ? "値上げ" : `${step.stage}段階目`;
      el.appendChild(stage);
      const price = document.createElement("span");
      price.className = "stage-price";
      price.textContent = step.price;
      el.appendChild(price);
      const date = document.createElement("span");
      date.className = "stage-date";
      // 2段階目以降は前の段階からの間隔を添える。ここが「前回の値下げから
      // どれだけ空いたか」を段階ごとに示す部分。
      date.textContent = step.gapDays ? `${step.date}(${step.gapDays}日後)` : step.date;
      el.appendChild(date);
      timeline.appendChild(el);
    });
    card.appendChild(timeline);
  } else {
    const historyText = priceHistoryTextFor({ isMarkdownFamily, isLimitedFamily, stagePoints, periods, history });
    if (historyText) {
      const priceHistory = document.createElement("div");
      priceHistory.className = "stage-history";
      priceHistory.textContent = historyText;
      card.appendChild(priceHistory);
    }
  }

  return card;
}

// 日付チップ。押すとその日に値下げ(期間限定なら期間限定入り)が確認された商品
// だけに絞り込む。以前は読むだけの一覧だったが、「今日値下げされたのはどれで、
// それぞれ何段階目なのか」は日付で切れないと答えが出ない。
// selected は日本時間の暦日、null は「すべて」。
function appendDateFilter(container, entries, { selected, onSelect }) {
  if (entries.length === 0) return;
  const bar = document.createElement("div");
  bar.className = "date-summary";

  const chips = [{ key: null, label: "すべて", count: null }, ...entries];
  for (const chip of chips) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-chip";
    // dataset は文字列しか持てないので、「すべて」は空文字で表す。
    btn.dataset.date = chip.key ?? "";
    btn.textContent = chip.count === null ? chip.label : `${chip.label}(${chip.count})`;
    const active = (chip.key ?? null) === selected;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
    bar.appendChild(btn);
  }

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-date]");
    if (!btn) return;
    const day = btn.dataset.date || null;
    // 選択中の日をもう一度押したら解除。指1本で戻れるようにする。
    onSelect(day === selected ? null : day);
  });

  container.appendChild(bar);
}

// 商品1件の「段階」。値下げは何段階目、期間限定は何回目。カードのバッジと
// 同じ数え方(countSuffixFor と同じ材料)を、グループの見出しでも使う。
function stageLabelOf(product) {
  const type = product.section;
  if (MARKDOWN_EVENT_TYPES.has(type)) return `${markdownStageCount(markdownStagePoints(product.history))}段階目`;
  if (LIMITED_EVENT_TYPES.has(type)) return `期間限定${limitedPeriods(product.history).length}回目`;
  return "値上げ";
}

// 並び順の材料。1段階目→5段階目→期間限定1回目→…→値上げ の順に並べる。
function stageRankOf(label) {
  const n = Number(label.match(/\d+/)?.[0] ?? 0);
  if (label.endsWith("段階目")) return n;
  if (label.startsWith("期間限定")) return 100 + n;
  return 999;
}

// 「2段階目3・5段階目4」。日付でまとめたグループの見出しに添える —
// その日に値下げされた商品が、それぞれ何段階目なのかを開かずに把握するため。
function stageBreakdownOf(products) {
  const counts = new Map();
  for (const product of products) {
    const label = stageLabelOf(product);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => stageRankOf(a[0]) - stageRankOf(b[0]))
    .map(([label, n]) => `${label}${n}`)
    .join("・");
}

function appendCards(grid, products) {
  for (const product of products) {
    try {
      grid.appendChild(renderCard(product));
    } catch (err) {
      console.error(`failed to render card for ${product.latest.product_id}`, err);
    }
  }
}

// 買えない商品(終了した期間限定・在庫なし)の退避先。グループの中にもう一段
// 折りたたみを作って、そこにまとめる。消さないのは「昨日まで並んでいた商品が
// なぜ消えたのか」が分からなくなるためで、開けばこれまでどおりカードが出る。
function buildUnbuyableGroup(products) {
  const group = document.createElement("details");
  group.className = "category-group hidden-group";

  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "group-label";
  label.textContent = "終了・在庫なし";
  summary.appendChild(label);
  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = `${products.length}件`;
  summary.appendChild(count);
  group.appendChild(summary);

  let rendered = false;
  group.addEventListener("toggle", () => {
    if (!group.open || rendered) return;
    rendered = true;
    const grid = document.createElement("div");
    grid.className = "grid";
    // 終了を後ろへ。在庫なしはまだ復活しうるが、終了した期間限定は戻らない。
    appendCards(grid, [...products].sort((a, b) => (a.offerOver ? 1 : 0) - (b.offerOver ? 1 : 0)));
    group.appendChild(grid);
  });

  return group;
}

// open: 最初から開いた状態で描く(日付で絞り込んだ直後など、件数が少なく
// 「開く」操作がただの手間になる場面用)。
// sub: 見出しに添える内訳を呼び出し側で決める場合(日付別の値動き — 「その日の」
// 段階は商品の現在の段階と一致しないため stageBreakdownOf は使えない)。
// keepOrder: 渡した順のまま並べる。
function appendProductGroup(section, labelText, products, { breakdown = false, open = false, sub = null, keepOrder = false } = {}) {
  // 買えるものだけを一覧の主役にする。終了した期間限定と在庫なしは、開かないと
  // 出てこない位置(グループ内の「終了・在庫なし」)へ落とす。見出しの件数も
  // 買えるものだけを数える — 「12件」を開いたら8件がもう買えなかった、が
  // いちばん時間を無駄にする。
  const buyable = products.filter((p) => !p.hidden);
  const unbuyable = products.filter((p) => p.hidden);

  // <details>/<summary> をそのまま使う。開閉の状態・キーボード操作・スクリーン
  // リーダーへの伝わり方が標準で付いてくるので、自前で真似しない。
  const group = document.createElement("details");
  group.className = "category-group";

  const summary = document.createElement("summary");

  const label = document.createElement("span");
  label.className = "group-label";
  label.textContent = labelText;
  // 日付でまとめたグループは、開かなくても「その日の何が何段階目か」が分かる
  // ようにする。段階ごとに分けてしまうと、1日ぶんが細かく割れて読みにくい。
  const subText = sub ?? (breakdown && buyable.length > 0 ? stageBreakdownOf(buyable) : null);
  if (subText) {
    const subEl = document.createElement("span");
    subEl.className = "group-sub";
    subEl.textContent = subText;
    label.appendChild(subEl);
  }
  summary.appendChild(label);

  const count = document.createElement("span");
  count.className = "group-count";
  count.textContent = `${buyable.length}件`;
  summary.appendChild(count);

  // 買えない商品が何件そこに畳まれているかは、開かなくても分かるようにする。
  if (unbuyable.length > 0) {
    const over = document.createElement("span");
    over.className = "group-over";
    over.textContent = `終了・在庫なし ${unbuyable.length}`;
    summary.appendChild(over);
  }
  group.appendChild(summary);

  // 閉じている間はカードを作らない。全カテゴリぶんを最初に組み立てると1,000件
  // 超のカードがDOMに載るが、実際に開かれるのはそのうちのごく一部。初めて
  // 開かれた時に一度だけ描く。
  let rendered = false;
  const renderBody = () => {
    if (rendered) return;
    rendered = true;
    if (buyable.length > 0) {
      const grid = document.createElement("div");
      grid.className = "grid";
      // 未確認(直近の巡回で見つからなかった)は後ろへ。日付でまとめたグループは
      // そのうえで段階順に並べる — 見出しの内訳と同じ並びでカードが出る。
      const ordered = keepOrder
        ? buyable
        : [...buyable].sort(
            (a, b) =>
              (a.unconfirmed ? 1 : 0) - (b.unconfirmed ? 1 : 0) ||
              (breakdown ? stageRankOf(stageLabelOf(a)) - stageRankOf(stageLabelOf(b)) : 0)
          );
      appendCards(grid, ordered);
      group.appendChild(grid);
    }
    if (unbuyable.length > 0) group.appendChild(buildUnbuyableGroup(unbuyable));
  };

  group.addEventListener("toggle", () => {
    if (group.open) renderBody();
  });

  // toggle イベント経由ではなく直接描く。開いた状態を先に立ててからだと、
  // イベントが飛ぶ前に読まれてカードが無いように見えることがある。
  if (open) {
    group.open = true;
    renderBody();
  }

  section.appendChild(group);
  return group;
}

const countFormatter = new Intl.NumberFormat("ja-JP");

// 曜日タブの見出しに出す「値下げの型」。
//
// 定例 = その曜日に来ればだいたい値下げがある(毎週の入れ替え)。
// 緊急 = 来る週と来ない週がある(在庫処分などの臨時値下げ)。
//
// 判定はデータだけを見て決める。「火曜が定例」と決め打ちにしないのは、値下げの
// 曜日は店側の都合で変わりうるうえ、UNIQLO と GU、MEN と WOMEN で揃っている
// 保証も無いため。観測できた週のうち何週で値下げがあったかで分ける。
const ROUTINE_MIN_DAYS = 2; // 1回だけの曜日を「定例」と呼ばない
const ROUTINE_MIN_RATIO = 0.6; // 観測できた回数の6割以上で値下げがあれば定例
const MARKDOWN_KIND_LABELS = { routine: "定例値下げ", spot: "緊急値下げ" };

function markdownKindOf(stats) {
  const observed = stats.observedDays.size;
  const hitDays = stats.downsByDay.size;
  if (hitDays === 0) return null; // 値下げを一度も確認していない曜日
  return hitDays >= ROUTINE_MIN_DAYS && hitDays / observed >= ROUTINE_MIN_RATIO ? "routine" : "spot";
}

// "2026-09-02"(日本時間の暦日)→ "9/2"。stageDateFormatter は Asia/Tokyo なので、
// UTC の0時として渡せばその日の朝9時＝同じ日として出る。
function formatJstDayLabel(jstDay) {
  return stageDateFormatter.format(new Date(`${jstDay}T00:00:00Z`));
}

// 7曜日ぶんの棒(「すべて」タブの中身)。
//
// 棒の長さは件数ではなく変化率(比較1件あたり何回動いたか)にしている。曜日ごとに
// 比較できた商品日数が揃わない — 巡回が失敗した日、商品が一覧から外れた日、
// 記録開始前の日はそのぶん母数が減る — ため、件数をそのまま並べると
// 「巡回できた日が多い曜日」が長く出るだけの図になる。件数は数字で併記する。
function appendWeekdayBars(container, byWeekday) {
  const rateOf = (w) => (w.comparisons === 0 ? 0 : (w.downs + w.ups) / w.comparisons);
  const maxRate = Math.max(...byWeekday.map(rateOf));

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

  container.appendChild(rows);
}

// 曜日タブの中身。その曜日に値下げを確認した日を新しい順に並べ、日付ごとに
// 商品を折りたたむ。「火曜の値下げ」と「木曜の値下げ」を混ぜずに見るための
// 画面なので、セクション(値下げ/期間限定…)やカテゴリではなく日付で切る。
function appendWeekdayDetail(container, weekday, stats) {
  const days = [...stats.downsByDay.keys()].sort().reverse();
  const kind = markdownKindOf(stats);

  const lead = document.createElement("p");
  lead.className = "weekday-lead";
  lead.textContent =
    `${WEEKDAY_LABELS[weekday]}曜は前日と比較できた${countFormatter.format(stats.observedDays.size)}回のうち` +
    `${countFormatter.format(days.length)}回で値下げを確認しました(のべ${countFormatter.format(stats.downs)}件)。` +
    (kind === "routine"
      ? "毎週のように値下げが来る曜日です。"
      : "毎週ではなく、来る週と来ない週がある曜日です。") +
    "見出しの「2段階目3」は、その日に値下げされた商品が何段階目だったかの内訳です。" +
    "カードに出るのは商品の現在の状態で、その日の価格ではありません。";
  container.appendChild(lead);

  for (const day of days) {
    appendProductGroup(
      container,
      `${formatJstDayLabel(day)}(${WEEKDAY_LABELS[weekday]})`,
      stats.downsByDay.get(day),
      // その日の商品が何段階目なのかを見出しに出す。曜日タブは「いつ値下げに
      // なったか」で切った画面なので、「何段階目か」が並んで初めて答えになる。
      { breakdown: true }
    );
  }
}

// 「曜日別の価格変動」パネル。いま選んでいるブランド・性別の全商品が対象。
//
// 上段は曜日タブ。「すべて」は7曜日ぶんの棒、値下げを確認した曜日のタブは
// その曜日に値下げがあった日ごとの商品一覧になる。タブに出す曜日は
// 決め打ちではなく、実際に値下げが検出された曜日だけ(markdownKindOf)。
function appendWeekdaySummary(container, products) {
  const { byWeekday, skippedChanges } = weekdayPriceChangeStats(products);

  const totalComparisons = byWeekday.reduce((sum, w) => sum + w.comparisons, 0);
  if (totalComparisons === 0) return; // 2日以上の履歴がある商品がまだ無い

  const totalChanges = byWeekday.reduce((sum, w) => sum + w.downs + w.ups, 0);

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

  // 値下げを実際に確認できた曜日だけをタブにする。ブランド・性別を切り替えると
  // 顔ぶれが変わるので、選択中の曜日が消えたら「すべて」に戻す。
  const markdownWeekdays = WEEKDAY_DISPLAY_ORDER.filter((w) => byWeekday[w].downs > 0);
  if (state.weekday !== ALL_WEEKDAYS && !markdownWeekdays.includes(state.weekday)) {
    state = { ...state, weekday: ALL_WEEKDAYS };
  }

  const body = document.createElement("div");
  body.className = "weekday-body";

  const renderBody = () => {
    body.innerHTML = "";
    if (state.weekday === ALL_WEEKDAYS) appendWeekdayBars(body, byWeekday);
    else appendWeekdayDetail(body, state.weekday, byWeekday[state.weekday]);
  };

  if (markdownWeekdays.length > 0) {
    const tabs = document.createElement("div");
    tabs.className = "tabs weekday-tabs";
    for (const value of [ALL_WEEKDAYS, ...markdownWeekdays]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.weekday = String(value);
      btn.textContent =
        value === ALL_WEEKDAYS
          ? "すべて"
          : `${WEEKDAY_LABELS[value]}曜(${MARKDOWN_KIND_LABELS[markdownKindOf(byWeekday[value])]})`;
      tabs.appendChild(btn);
    }
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-weekday]");
      if (!btn) return;
      const value = btn.dataset.weekday === ALL_WEEKDAYS ? ALL_WEEKDAYS : Number(btn.dataset.weekday);
      if (value === state.weekday) return;
      state = { ...state, weekday: value };
      setActiveTab(tabs, "weekday", String(state.weekday));
      // このパネルの中身だけを描き直す。renderContent() をやり直すと、下の
      // セクションで開いていたカテゴリが全部閉じてしまう。
      renderBody();
    });
    setActiveTab(tabs, "weekday", String(state.weekday));
    section.appendChild(tabs);
  }

  renderBody();
  section.appendChild(body);

  const note = document.createElement("p");
  note.className = "weekday-note";
  // この集計が何を数えていないのかを、数字の隣に置く。
  note.textContent =
    "前日の巡回から価格が変わっていた商品を、変化を確認した曜日で数えています。巡回は日本時間の早朝(3:00と、" +
    "取りこぼし用の4:00)なので、値札が実際に変わったのは前日の巡回以降のどこかです。%と棒の長さは前日と比較できた" +
    "件数に対する割合 — 曜日ごとに比較できた件数が違うためです。期間限定価格が終わって元に戻った商品は値上げに" +
    `数えます。曜日タブの「${MARKDOWN_KIND_LABELS.routine}」は観測できた回数の` +
    `${Math.round(ROUTINE_MIN_RATIO * 100)}%以上で値下げがあった曜日、「${MARKDOWN_KIND_LABELS.spot}」は` +
    "それ以外(来る週と来ない週がある曜日)です。";
  if (skippedChanges > 0) {
    note.textContent +=
      `前日の記録が無く、どちらの日に動いたか決められない変化${countFormatter.format(skippedChanges)}件は数えていません。`;
  }
  section.appendChild(note);

  container.appendChild(section);
}

// --- 日付別の値動き ---------------------------------------------------------
//
// 下のセクションは商品を「いまの状態」で分けているため、ある日に値下げされた
// 商品が 初値下げ/値下げ の2か所に割れ、同じ日に値上げされた商品はまた別の
// 場所にある。「この日、何が値下げ(値上げ)になったか」に1か所で答えるため、
// 各商品の履歴を「その日に起きたこと」に展開し直して日付で束ねる。

const DAY_MOVE_KINDS = [
  { key: "markdown", label: "値下げ", color: "var(--status-markdown)" },
  { key: "limited", label: "期間限定", color: "var(--status-limited)" },
  { key: "price_up", label: "値上げ・価格改定", color: "var(--status-price_up)" },
];

// 商品1件の値動きを [{ day, kind, label, rank }] にする。label は見出しの内訳に
// 使う「その日の」段階(カードに出る現在の段階とは限らない)。
function priceMovesOf(product) {
  const { history } = product;
  const moves = [];
  const firstRow = history[0];

  const points = markdownStagePoints(history);
  points.forEach((point, i) => {
    const day = jstDayOf(point.scraped_at);
    if (!day) return;
    if (i === 0) {
      // 先頭の点は、このトラッカーが初めて値下げ一覧で見つけた日(first_markdown)
      // のときだけ数える。読み込み範囲(直近35日)の端で切れた履歴の先頭まで
      // 数えると、範囲の初日に全商品が「値下げ」として並んでしまう。
      const row = history.find((r) => r.scraped_at === point.scraped_at);
      // 初めて見つけた商品は値下げ前の価格が分からない(from なし)。
      if (row?.event_type === "first_markdown") {
        moves.push({ day, kind: "markdown", label: "初値下げ", rank: 0, from: null, to: point.price });
      }
      return;
    }
    const from = points[i - 1].price;
    if (point.up) moves.push({ day, kind: "price_up", label: "値上げ", rank: 0, from, to: point.price });
    else moves.push({ day, kind: "markdown", label: `${point.stage}段階目`, rank: point.stage, from, to: point.price });
  });

  limitedPeriods(history).forEach((period, i) => {
    const day = jstDayOf(period.from);
    if (!day) return;
    // 同じ理由で、履歴の先頭から始まっている周期は初期間限定のときだけ数える。
    if (period.from === firstRow?.scraped_at && firstRow.event_type !== "first_limited") return;
    // 期間限定に入る直前の価格(通常の値下げ価格など)。無ければ from なし。
    const before = [...history].reverse().find((r) => r.scraped_at < period.from);
    moves.push({
      day,
      kind: "limited",
      label: i === 0 ? "初期間限定" : `${i + 1}回目`,
      rank: i + 1,
      from: before && before.price !== period.price ? before.price : null,
      to: period.price,
    });
  });

  return moves;
}

// day -> kind -> [{ product, label, rank }]
function priceMovesByDay(products) {
  const byDay = new Map();
  for (const product of products) {
    for (const move of priceMovesOf(product)) {
      if (!byDay.has(move.day)) byDay.set(move.day, new Map());
      const kinds = byDay.get(move.day);
      if (!kinds.has(move.kind)) kinds.set(move.kind, []);
      kinds.get(move.kind).push({ product, label: move.label, rank: move.rank, from: move.from, to: move.to });
    }
  }
  return byDay;
}

function breakdownOfMoves(entries) {
  const counts = new Map();
  for (const { label, rank } of entries) {
    const current = counts.get(label) ?? { n: 0, rank };
    current.n += 1;
    counts.set(label, current);
  }
  return [...counts.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([label, { n }]) => `${label}${n}`)
    .join("・");
}

// 日付別の値動きの1行。「何が・いくらからいくらになったか」が1行で読める
// ことを優先して、カードではなく行にする(1日で数十件になる)。
function renderMoveRow(entry) {
  const { product, label, from, to } = entry;
  const { latest } = product;
  const fmt = currencyFormatter(latest.currency);

  const row = document.createElement("a");
  row.className = `move-row${product.hidden ? " unbuyable" : ""}`;
  row.href = latest.url;
  row.target = "_blank";
  row.rel = "noopener noreferrer";

  const name = document.createElement("span");
  name.className = "move-name";
  name.textContent = latest.product_name || latest.product_id;
  row.appendChild(name);

  const price = document.createElement("span");
  price.className = "move-price";
  price.textContent = from != null ? `${fmt.format(from)} → ${fmt.format(to)}` : fmt.format(to);
  row.appendChild(price);

  const pct = document.createElement("span");
  if (from != null && from !== to) {
    const change = Math.round(((to - from) / from) * 100);
    pct.className = `move-pct ${change < 0 ? "down" : "up"}`;
    pct.textContent = `${change > 0 ? "+" : "−"}${Math.abs(change)}%`;
  } else {
    pct.className = "move-pct none";
    pct.textContent = from == null ? "初確認" : "";
  }
  row.appendChild(pct);

  const tag = document.createElement("span");
  tag.className = "move-tag";
  tag.textContent = label;
  row.appendChild(tag);

  const meta = document.createElement("span");
  meta.className = "move-meta";
  const bits = [product.category];
  if (product.soldOut) bits.push("在庫なし");
  else if (product.offerOver) bits.push("終了");
  else if (latest.in_stock_size_count > 0) bits.push(`在庫${latest.in_stock_size_count}サイズ`);
  meta.textContent = bits.join("・");
  row.appendChild(meta);

  return row;
}

// 割引率の大きい順(値上げは上げ幅の大きい順)。同じ段階どうしで並べる。
const moveChangeRatio = (e) => (e.from != null && e.from !== 0 ? (e.to - e.from) / e.from : 0);

function appendMoveGroup(body, kind, entries) {
  // 値動きは「在庫が残っているか」と関係なく起きたことなので、全件を数える。
  // 在庫なし・終了は行を薄くして区別する(値上げされた旧モデルは、値上げ後の
  // 価格帯ではすでに完売していることが多く、隠すと値上げ自体が見えなくなる)。
  const sorted = [...entries].sort(
    (a, b) =>
      (a.product.hidden ? 1 : 0) - (b.product.hidden ? 1 : 0) ||
      (kind.key === "price_up"
        ? moveChangeRatio(b) - moveChangeRatio(a)
        : a.rank - b.rank || moveChangeRatio(a) - moveChangeRatio(b))
  );
  const unbuyable = entries.filter((e) => e.product.hidden).length;

  const group = document.createElement("details");
  group.className = "category-group move-group";
  group.style.setProperty("--status-color", kind.color);
  group.open = entries.length <= MOVE_AUTO_OPEN_MAX;

  const summary = document.createElement("summary");
  const labelEl = document.createElement("span");
  labelEl.className = "group-label";
  labelEl.textContent = kind.label;
  const sub = breakdownOfMoves(entries);
  if (sub) {
    const subEl = document.createElement("span");
    subEl.className = "group-sub";
    subEl.textContent = sub;
    labelEl.appendChild(subEl);
  }
  summary.appendChild(labelEl);
  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = `${entries.length}件`;
  summary.appendChild(countEl);
  if (unbuyable > 0) {
    const over = document.createElement("span");
    over.className = "group-over";
    over.textContent = `うち在庫なし・終了 ${unbuyable}`;
    summary.appendChild(over);
  }
  group.appendChild(summary);

  let rendered = false;
  const renderBody = () => {
    if (rendered) return;
    rendered = true;
    const list = document.createElement("div");
    list.className = "move-list";
    for (const entry of sorted) list.appendChild(renderMoveRow(entry));
    group.appendChild(list);
  };
  group.addEventListener("toggle", () => {
    if (group.open) renderBody();
  });
  if (group.open) renderBody();

  body.appendChild(group);
}

// 1グループをそのまま開いて出す件数の上限。行は軽いのでカードより多く開く。
const MOVE_AUTO_OPEN_MAX = 80;

let selectedMoveDay = null; // null = 直近の日。ブランド・性別を切り替えても保つ

function appendDailyMoves(container, products) {
  const byDay = priceMovesByDay(products);
  const days = [...byDay.keys()].sort().reverse().slice(0, 14);
  if (days.length === 0) return;

  const section = document.createElement("section");
  section.className = "section daily-moves";
  section.style.setProperty("--status-color", "var(--status-markdown)");

  const header = document.createElement("div");
  header.className = "section-header";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "日付別の値動き";
  const count = document.createElement("span");
  count.className = "count";
  header.appendChild(label);
  header.appendChild(count);
  section.appendChild(header);

  const chipsHost = document.createElement("div");
  const body = document.createElement("div");

  const render = () => {
    // 選んでいた日が、切り替えた先のブランド・性別に無ければ直近の日に戻す。
    const day = selectedMoveDay && byDay.has(selectedMoveDay) ? selectedMoveDay : days[0];
    const kinds = byDay.get(day);

    chipsHost.innerHTML = "";
    const bar = document.createElement("div");
    bar.className = "date-summary";
    for (const d of days) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "date-chip";
      btn.dataset.date = d;
      const total = [...byDay.get(d).values()].reduce((sum, list) => sum + list.length, 0);
      btn.textContent = `${formatJstDayLabel(d)}(${WEEKDAY_LABELS[weekdayIndexOf(d)]})${total}`;
      const active = d === day;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
      bar.appendChild(btn);
    }
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-date]");
      if (!btn) return;
      selectedMoveDay = btn.dataset.date;
      render();
    });
    chipsHost.appendChild(bar);

    count.textContent =
      `${formatJstDayLabel(day)}: ` +
      DAY_MOVE_KINDS.filter((k) => kinds.has(k.key))
        .map((k) => `${k.label}${kinds.get(k.key).length}件`)
        .join("・");

    body.innerHTML = "";
    for (const kind of DAY_MOVE_KINDS) {
      const entries = kinds.get(kind.key);
      if (!entries) continue;
      appendMoveGroup(body, kind, entries);
    }
  };

  render();
  section.appendChild(chipsHost);
  section.appendChild(body);

  const note = document.createElement("p");
  note.className = "weekday-note";
  note.textContent =
    "日付は、その日の朝の巡回で価格が変わっていると確認できた日です(値札は当日の午前2時ごろに切り替わり、" +
    "朝6〜8時ごろの巡回で拾います)。「→」の左が前日までの価格、右が変更後の価格です。" +
    "見出しの内訳(「初値下げ3・2段階目5」)はその日に何段階目になったかで、初めて見つけた商品は前の価格が分からないため「初確認」と出します。";
  section.appendChild(note);

  container.appendChild(section);
}

function renderContent() {
  contentEl.innerHTML = "";
  // ブランドごとに巡回の進み具合が違う(UNIQLOが終わってGUがまだ、がありうる)。
  statusEl.textContent = freshnessText(allRows, state.brand);
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

  const everyProduct = EVENT_TYPE_CONFIG.flatMap((e) => Object.values(bucket[e.key] || {}).flat());

  // いちばん上は「この日に何が値下げ(値上げ)になったか」。このダッシュボードを
  // 開く一番の理由なので、セクションをまたいで1か所で答える。
  appendDailyMoves(contentEl, everyProduct);

  // 個別の商品より先に、その日どこを見るべきかの当たりが付く数字を出す。
  appendWeekdaySummary(contentEl, everyProduct);

  for (const eventConfig of EVENT_TYPE_CONFIG) {
    const byCategory = bucket[eventConfig.key];
    if (!byCategory) continue;
    const categories = Object.keys(byCategory);
    if (categories.length === 0) continue;

    const allProducts = categories.flatMap((c) => byCategory[c]);
    // 見出しにもチップにも「いま買えるもの」だけを数えて出す。終了・在庫なしは
    // カテゴリの中の折りたたみに落ちているので、何件あるかは括弧で添える
    // (件数の書き込みは renderGroups が担当 — 絞り込みで変わるため)。
    const buyableProducts = allProducts.filter((p) => !p.hidden);

    const section = document.createElement("section");
    section.className = "section";
    section.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);

    const header = document.createElement("div");
    header.className = "section-header";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = eventConfig.sectionLabel ?? eventConfig.label;
    const count = document.createElement("span");
    count.className = "count";
    header.appendChild(label);
    header.appendChild(count);
    section.appendChild(header);

    if (eventConfig.note) {
      const note = document.createElement("p");
      note.className = "section-note";
      note.textContent = eventConfig.note;
      section.appendChild(note);
    }

    const dateOf = DATE_AXIS[eventConfig.key] ?? null;

    const chipsHost = document.createElement("div");
    const groupsHost = document.createElement("div");
    const dateEntries = dateOf ? groupProductsByDate(buyableProducts, dateOf) : [];
    // 既定は直近の日付。「今日は何が値下げになったか」がこのダッシュボードを
    // 開く理由なので、全期間を混ぜた一覧より先にその日の分を出す。継続中の
    // オファーをまとめて見るセクション(期間限定・値上げ)だけは「すべて」から。
    let selectedDate = DEFAULT_TO_LATEST_DATE.has(eventConfig.key) ? (dateEntries[0]?.key ?? null) : null;

    const renderGroups = () => {
      groupsHost.innerHTML = "";
      const shown =
        selectedDate === null ? allProducts : allProducts.filter((p) => jstDayOf(dateOf(p) ?? "") === selectedDate);
      const shownBuyable = shown.filter((p) => !p.hidden);
      const shownUnbuyable = shown.length - shownBuyable.length;
      // 絞り込み中はその日の件数を出す。見出しの数字と目の前の一覧がずれると、
      // どちらが本当なのか確かめようがない。
      count.textContent =
        (selectedDate === null ? "" : `${formatJstDayLabel(selectedDate)}${DATE_VERB[eventConfig.key] ?? "に確認"} `) +
        `${shownBuyable.length}件` +
        (shownUnbuyable > 0 ? `(ほかに終了・在庫なし ${shownUnbuyable}件)` : "");

      if (eventConfig.key === "markdown") {
        // Grouped by 値下げ段階 instead of category here — how many times a
        // product has been discounted is the more useful axis to browse this
        // particular section by (category grouping is still used everywhere
        // else). 初値下げ is always exactly stage 1, so grouping it the same
        // way wouldn't add anything.
        //
        // 日付で絞り込むと、この段階グループがそのまま「その日に値下げされた
        // 商品は何段階目だったか」の答えになる。
        const byStage = new Map();
        for (const product of shown) {
          const stage = markdownStageCount(markdownStagePoints(product.history));
          if (!byStage.has(stage)) byStage.set(stage, []);
          byStage.get(stage).push(product);
        }
        for (const stage of [...byStage.keys()].sort((a, b) => a - b)) {
          const group = byStage.get(stage);
          appendProductGroup(groupsHost, `${stage}段階目`, group, {
            // その日に絞り込んでいて件数が少なければ、開く操作は手間でしかない。
            open: selectedDate !== null && group.filter((p) => !p.hidden).length <= AUTO_OPEN_MAX,
          });
        }
      } else {
        const byCategoryNow = new Map();
        for (const product of shown) {
          if (!byCategoryNow.has(product.category)) byCategoryNow.set(product.category, []);
          byCategoryNow.get(product.category).push(product);
        }
        for (const category of categoryOrderFor(state.brand, [...byCategoryNow.keys()])) {
          const group = byCategoryNow.get(category);
          appendProductGroup(groupsHost, category, group, {
            // 期間限定は「何回目の周期か」が段階に相当する。初値下げ・初期間限定は
            // 定義上いつも1回目なので、内訳を出しても情報が増えない。
            breakdown: selectedDate !== null && eventConfig.key === "limited",
            open: selectedDate !== null && group.filter((p) => !p.hidden).length <= AUTO_OPEN_MAX,
          });
        }
      }

      if (shown.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "この日に確認された商品はありません。";
        groupsHost.appendChild(empty);
      }
    };

    if (dateOf) {
      const renderChips = () => {
        chipsHost.innerHTML = "";
        appendDateFilter(chipsHost, dateEntries, {
          selected: selectedDate,
          onSelect: (day) => {
            selectedDate = day;
            renderChips();
            renderGroups();
          },
        });
      };
      renderChips();
      section.appendChild(chipsHost);
    }

    renderGroups();
    section.appendChild(groupsHost);

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

const crawlTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Tokyo",
});

// データがいつの巡回までなのか。巡回は毎朝3:00(日本時間)に予約しているが、
// GitHub 側のキュー待ちで実際に走るのは6〜7時ごろになる日が多い。その間に
// 開くと「今日の値下げが出ていない」ように見えるので、まだだとはっきり書く。
function freshnessText(rows, brand) {
  let newest = null;
  for (const row of rows) {
    if (row.brand !== brand) continue;
    if (newest === null || row.scraped_at > newest) newest = row.scraped_at;
  }
  const name = BRAND_CONFIG[brand].label;
  if (newest === null) return `${name}: まだデータがありません`;
  const text = `${name}の最終巡回: ${crawlTimeFormatter.format(new Date(newest))}(日本時間)`;
  const today = jstDayOf(new Date());
  if (jstDayOf(newest) >= today) return text;
  return (
    `${text} — 今日(${formatJstDayLabel(today)})の${name}の巡回はまだ反映されていません。` +
    "巡回は毎朝3:00に予約していますが、実際に走るのは6〜8時ごろになる日があり、UNIQLOのあとにGUの順で進みます。"
  );
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

  allRows = data;
  index = buildIndex(data);
  updateTabs();
  renderContent();
}

main();
