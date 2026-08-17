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

// A distinct "値下げ段階": every time this product's price actually changed
// while recorded via a markdown-listing row ('first_markdown'/'markdown').
// The scraper writes a fresh row every scrape even when the discounted price
// hasn't moved (see scripts/scrape.mjs), so same-price rows collapse into a
// single point here — "3段階目" means "the 3rd distinct price this product
// has had while markdown-listed", not "3 rows in the DB". Non-markdown rows
// (期間限定/値上げ observations that happened in between) are skipped rather
// than breaking the sequence, since they don't represent a 値下げ step.
function markdownStagePoints(history) {
  const points = [];
  for (const row of history) {
    if (row.event_type !== "first_markdown" && row.event_type !== "markdown") continue;
    const last = points[points.length - 1];
    if (!last || last.price !== row.price) {
      points.push({ price: row.price, currency: row.currency, scraped_at: row.scraped_at });
    }
  }
  return points;
}

const stageDateFormatter = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" });

// e.g. "¥1,990(7/8)→¥1,290(7/13)→¥990(7/28)→¥790(8/18)"
function formatMarkdownStageHistory(points) {
  const fmt = currencyFormatter(points[0]?.currency ?? "JPY");
  return points.map((p) => `${fmt.format(p.price)}(${stageDateFormatter.format(new Date(p.scraped_at))})`).join(" → ");
}

// The date this product was first ever recorded as 期間限定 (event_type
// 'first_limited'/'limited') — history is sorted ascending, so the first
// matching row is the earliest. Unlike markdown, 期間限定 doesn't get a
// multi-stage breakdown here (a period-limited price is a single ongoing
// offer, not a sequence of discrete markdowns), just this one "since" date.
function firstLimitedSeenDate(history) {
  for (const row of history) {
    if (row.event_type === "first_limited" || row.event_type === "limited") return row.scraped_at;
  }
  return null;
}

// Buckets `products` by the local calendar day `dateOf(product)` falls on,
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

function buildIndex(rows) {
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }

  const idx = {};
  for (const history of byProduct.values()) {
    history.sort((a, b) => new Date(a.scraped_at) - new Date(b.scraped_at));
    const latest = history[history.length - 1];
    const brand = latest.brand;
    const gender = latest.gender || "unknown";
    const eventType = latest.event_type || "markdown";
    const category = latest.category || (brand === "gu" ? "グッズ・その他" : "その他");

    idx[brand] ??= {};
    idx[brand][gender] ??= {};
    idx[brand][gender][eventType] ??= {};
    idx[brand][gender][eventType][category] ??= [];
    idx[brand][gender][eventType][category].push({ latest, history });
  }
  return idx;
}

function categoryOrderFor(brand, categories) {
  const known = CATEGORY_ORDER[brand] || [];
  const ordered = known.filter((c) => categories.includes(c));
  const extra = categories.filter((c) => !known.includes(c)).sort();
  return [...ordered, ...extra];
}

function renderCard(product) {
  const { latest, history } = product;
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const fmt = currencyFormatter(latest.currency);

  // The whole card is the product link (click/tap anywhere opens the
  // official product page in a new tab), so it's an <a>, not a <div>.
  const card = document.createElement("a");
  card.className = "card";
  card.href = latest.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const topRow = document.createElement("div");
  topRow.className = "top-row";

  const title = document.createElement("h2");
  title.textContent = latest.product_name || latest.product_id;
  topRow.appendChild(title);

  const isMarkdownFamily = latest.event_type === "first_markdown" || latest.event_type === "markdown";
  const isLimitedFamily = latest.event_type === "first_limited" || latest.event_type === "limited";
  const stagePoints = isMarkdownFamily ? markdownStagePoints(history) : [];

  const eventConfig = EVENT_TYPE_CONFIG.find((e) => e.key === latest.event_type);
  if (eventConfig) {
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);
    // "初値下げ" is always exactly stage 1 by definition (see classifyEventType
    // in scripts/scrape.mjs), so the stage count only adds information for a
    // *follow-up* markdown — append it there instead of duplicating "(1段階目)"
    // on every 初値下げ badge.
    badge.textContent =
      latest.event_type === "markdown" && stagePoints.length > 0
        ? `${eventConfig.label}(${stagePoints.length}段階目)`
        : eventConfig.label;
    topRow.appendChild(badge);
  }
  card.appendChild(topRow);

  const priceRow = document.createElement("div");
  priceRow.className = "price-row";

  const price = document.createElement("span");
  price.className = "price";
  price.textContent = fmt.format(latest.price);
  priceRow.appendChild(price);

  if (previous && previous.price !== latest.price) {
    const diff = latest.price - previous.price;
    const delta = document.createElement("span");
    delta.className = `delta ${diff < 0 ? "down" : "up"}`;
    delta.textContent = `${diff > 0 ? "+" : ""}${fmt.format(diff)}`;
    priceRow.appendChild(delta);
  }
  card.appendChild(priceRow);

  const endDateText = formatLimitedPriceEndDate(latest.limited_price_end_date);
  if (endDateText) {
    const endDate = document.createElement("div");
    endDate.className = "end-date";
    endDate.textContent = endDateText;
    card.appendChild(endDate);
  }

  if (isLimitedFamily) {
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
  updated.textContent = `最終確認: ${dateFormatter.format(new Date(latest.scraped_at))}`;
  card.appendChild(updated);

  if (isMarkdownFamily && stagePoints.length > 0) {
    // Replaces the sparkline chart for markdown-family cards: the arrow text
    // already conveys the same price-over-time information, with the actual
    // values/dates attached instead of an unlabeled line, so showing both
    // would be redundant.
    const stageHistory = document.createElement("div");
    stageHistory.className = "stage-history";
    stageHistory.textContent = formatMarkdownStageHistory(stagePoints);
    card.appendChild(stageHistory);
  } else if (history.length > 1) {
    // Chart.js loads from a CDN (see index.html); if that fails for any
    // reason (offline, ad blocker, CDN hiccup) the card should still show
    // its price/name instead of taking the whole dashboard render down with
    // an uncaught "Chart is not defined".
    try {
      const canvas = document.createElement("canvas");
      card.appendChild(canvas);
      new Chart(canvas, {
        type: "line",
        data: {
          labels: history.map((h) => h.scraped_at),
          datasets: [
            {
              data: history.map((h) => h.price),
              borderColor: getComputedStyle(document.documentElement).getPropertyValue(`--brand-${latest.brand}`) || "#999",
              backgroundColor: "transparent",
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.15,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    } catch (err) {
      console.error("chart render failed, showing card without sparkline", err);
    }
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
  const group = document.createElement("div");
  group.className = "category-group";

  const h3 = document.createElement("h3");
  h3.textContent = `${labelText}(${products.length})`;
  group.appendChild(h3);

  const grid = document.createElement("div");
  grid.className = "grid";
  for (const product of products) {
    try {
      grid.appendChild(renderCard(product));
    } catch (err) {
      console.error(`failed to render card for ${product.latest.product_id}`, err);
    }
  }
  group.appendChild(grid);

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
    count.textContent = `${total}件`;
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
        // "直近で期間限定入りが確認された日" — each product's first-ever 期間限定
        // observation, grouped by day.
        appendDateSummary(
          section,
          groupProductsByDate(
            categories.flatMap((c) => byCategory[c]),
            (p) => firstLimitedSeenDate(p.history)
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
    btn.classList.toggle("active", btn.dataset[attr] === value);
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
      "product_id, product_name, brand, gender, category, event_type, url, price, currency, scraped_at, limited_price_end_date"
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
