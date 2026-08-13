import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");

const currencyFormatter = (currency) =>
  new Intl.NumberFormat("ja-JP", { style: "currency", currency, maximumFractionDigits: 0 });

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function groupByProduct(rows) {
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id).push(row);
  }
  for (const history of byProduct.values()) {
    history.sort((a, b) => new Date(a.scraped_at) - new Date(b.scraped_at));
  }
  return byProduct;
}

function renderCard(productId, history) {
  const latest = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const fmt = currencyFormatter(latest.currency);

  const card = document.createElement("div");
  card.className = "card";

  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = latest.brand;
  card.appendChild(brand);

  const title = document.createElement("h2");
  const link = document.createElement("a");
  link.className = "product-link";
  link.href = latest.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = latest.product_name || productId;
  title.appendChild(link);
  card.appendChild(title);

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
    const canvas = document.createElement("canvas");
    card.appendChild(canvas);
    new Chart(canvas, {
      type: "line",
      data: {
        labels: history.map((h) => h.scraped_at),
        datasets: [
          {
            data: history.map((h) => h.price),
            borderColor: getComputedStyle(document.documentElement).getPropertyValue("--accent"),
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
  }

  return card;
}

async function main() {
  const { data, error } = await supabase
    .from("price_events")
    .select("product_id, product_name, brand, url, price, currency, scraped_at")
    .order("scraped_at", { ascending: true });

  if (error) {
    statusEl.textContent = `データの読み込みに失敗しました: ${error.message}`;
    statusEl.classList.add("error");
    return;
  }

  if (!data || data.length === 0) {
    statusEl.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "まだ価格データがありません。スクレイパーの初回実行をお待ちください。";
    gridEl.appendChild(empty);
    return;
  }

  statusEl.textContent = "";
  const byProduct = groupByProduct(data);
  for (const [productId, history] of byProduct) {
    gridEl.appendChild(renderCard(productId, history));
  }
}

main();
