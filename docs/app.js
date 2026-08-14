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

// Section order top-to-bottom, each independent per the dashboard spec:
// new arrivals and price increases get their own sections, separate from
// the markdown/limited-time-price sections.
const EVENT_TYPE_CONFIG = [
  { key: "new", label: "新作" },
  { key: "markdown", label: "値下げ" },
  { key: "limited", label: "期間限定" },
  { key: "price_up", label: "値上げ" },
];

const CATEGORY_ORDER = {
  uniqlo: ["トップス", "シャツ", "アウター", "パンツ", "ビジネス", "インナー・ルームウェア", "その他"],
  gu: ["トップス", "アウター・パンツ", "グッズ・その他"],
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

  const card = document.createElement("div");
  card.className = "card";

  const topRow = document.createElement("div");
  topRow.className = "top-row";

  const title = document.createElement("h2");
  const link = document.createElement("a");
  link.className = "product-link";
  link.href = latest.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = latest.product_name || latest.product_id;
  title.appendChild(link);
  topRow.appendChild(title);

  const eventConfig = EVENT_TYPE_CONFIG.find((e) => e.key === latest.event_type);
  if (eventConfig) {
    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.style.setProperty("--status-color", `var(--status-${eventConfig.key})`);
    badge.textContent = eventConfig.label;
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

  const updated = document.createElement("div");
  updated.className = "updated";
  updated.textContent = `最終確認: ${dateFormatter.format(new Date(latest.scraped_at))}`;
  card.appendChild(updated);

  if (history.length > 1) {
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

    for (const category of categoryOrderFor(state.brand, categories)) {
      const products = byCategory[category];
      if (!products || products.length === 0) continue;

      const group = document.createElement("div");
      group.className = "category-group";

      const h3 = document.createElement("h3");
      h3.textContent = `${category}(${products.length})`;
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
    .select("product_id, product_name, brand, gender, category, event_type, url, price, currency, scraped_at")
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
