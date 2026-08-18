import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../config.js";

// Hidden admin UI for manual price_events corrections/additions. The route
// itself isn't linked from the public dashboard, but that's not what makes
// writes safe -- only a Supabase Auth user can write at all, per the RLS
// policies added in supabase/migrations/0005_add_authenticated_write_policies.sql.
// The scraper (scripts/scrape.mjs) remains the primary way data gets in here;
// this page is for one-off fixes.

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const app = document.getElementById("app");

const EVENT_TYPES = [
  { key: "first_markdown", label: "初値下げ" },
  { key: "markdown", label: "値下げ" },
  { key: "first_limited", label: "初期間限定" },
  { key: "limited", label: "期間限定" },
  { key: "price_up", label: "値上げ" },
];

supabase.auth.onAuthStateChange((_event, session) => render(session));
supabase.auth.getSession().then(({ data }) => render(data.session));

function render(session) {
  if (!session) return renderLogin();
  return renderPanel(session);
}

function renderLogin() {
  app.innerHTML = `
    <h1>管理画面ログイン</h1>
    <p class="hint">このページのURLは公開ダッシュボードからリンクされていません。書き込みはSupabase Authでログインしたユーザーのみ可能です(Supabase Dashboard &gt; Authentication &gt; Users でユーザーを作成してください)。</p>
    <form id="login-form">
      <label>メールアドレス<input type="email" name="email" required /></label>
      <label>パスワード<input type="password" name="password" required /></label>
      <div id="login-error" class="error"></div>
      <button class="btn-primary" type="submit">ログイン</button>
    </form>
  `;
  const form = document.getElementById("login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const { error } = await supabase.auth.signInWithPassword({
      email: fd.get("email"),
      password: fd.get("password"),
    });
    if (error) document.getElementById("login-error").textContent = error.message;
  });
}

async function renderPanel(session) {
  app.innerHTML = `
    <div class="topbar">
      <h1>価格イベント管理</h1>
      <div class="hint">${session.user.email} <button class="btn-link" id="logout">ログアウト</button></div>
    </div>
    <form id="add-form" class="form-grid wide">
      <label>ブランド<select name="brand"><option value="uniqlo">UNIQLO</option><option value="gu">GU</option></select></label>
      <label>性別<select name="gender"><option value="men">MEN</option><option value="women">WOMEN</option></select></label>
      <label>カテゴリ<input name="category" placeholder="例: トップス" required /></label>
      <label>種別<select name="event_type">${EVENT_TYPES.map((t) => `<option value="${t.key}">${t.label}</option>`).join("")}</select></label>
      <label class="full">商品名<input name="product_name" required /></label>
      <label class="full">商品URL<input name="url" type="url" required /></label>
      <label>価格 (円)<input name="price" type="number" min="0" required /></label>
      <label>期間限定 終了日<input name="limited_price_end_date" type="date" /></label>
      <div id="add-error" class="error full"></div>
      <div class="full"><button class="btn-primary" type="submit">追加する</button></div>
    </form>
    <table>
      <thead><tr><th>ブランド</th><th>商品名</th><th>種別</th><th>価格</th><th>記録日</th><th></th></tr></thead>
      <tbody id="rows"><tr><td colspan="6">読み込み中...</td></tr></tbody>
    </table>
  `;

  document.getElementById("logout").addEventListener("click", () => supabase.auth.signOut());
  document.getElementById("add-form").addEventListener("submit", handleAdd);
  loadRows();
}

function slugify(name) {
  return (
    "manual-" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) +
    "-" +
    Date.now().toString(36)
  );
}

async function handleAdd(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const errorEl = document.getElementById("add-error");
  errorEl.textContent = "";

  const { error } = await supabase.from("price_events").insert({
    product_id: slugify(fd.get("product_name")),
    product_name: fd.get("product_name"),
    brand: fd.get("brand"),
    gender: fd.get("gender"),
    category: fd.get("category"),
    event_type: fd.get("event_type"),
    url: fd.get("url"),
    price: Number(fd.get("price")),
    currency: "JPY",
    limited_price_end_date: fd.get("limited_price_end_date") || null,
  });

  if (error) {
    errorEl.textContent = error.message;
    return;
  }
  form.reset();
  loadRows();
}

async function loadRows() {
  const tbody = document.getElementById("rows");
  const { data, error } = await supabase
    .from("price_events")
    .select("id, brand, product_name, event_type, price, scraped_at")
    .order("scraped_at", { ascending: false })
    .limit(100);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${error.message}</td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">データがありません。</td></tr>`;
    return;
  }

  tbody.innerHTML = data
    .map((row) => {
      const label = EVENT_TYPES.find((t) => t.key === row.event_type)?.label ?? row.event_type;
      return `
        <tr>
          <td>${row.brand}</td>
          <td>${escapeHtml(row.product_name ?? "")}</td>
          <td>${label}</td>
          <td>¥${Number(row.price).toLocaleString()}</td>
          <td>${new Date(row.scraped_at).toLocaleDateString("ja-JP")}</td>
          <td><button class="btn-danger" data-id="${row.id}">削除</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("このイベントを削除しますか？")) return;
      const { error } = await supabase.from("price_events").delete().eq("id", btn.dataset.id);
      if (error) alert(error.message);
      else loadRows();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
