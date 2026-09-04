// 周期表(商品グループ × 年)と、値引きルールの検証。
//
// 集計そのものは Supabase 側のビューが持っている(supabase/migrations/
// 0008_analysis_product_groups_and_cycles.sql / 0009_analysis_discount_rules.sql)。
// このページがやるのは、ブランド・性別で絞って読み、読めなかった期間を
// 「未確認」として明示しながら並べることだけ。
//
// 集計をDB側に置いているのは、周期表が何年ぶんもの履歴を必要とするため。
// ダッシュボード(index.html)が読んでいるのは直近35日の生データで、その窓では
// 年をまたぐ比較ができない。かといって数十万行をブラウザへ送ることもできない
// (PostgREST は1リクエスト1,000行で切れる)。
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

// index.html と同じ並び。同じものを2つの画面で別の順に出さない。
const CATEGORY_ORDER = {
  uniqlo: ["トップス", "シャツ", "アウター", "パンツ", "ワンピース", "ビジネス", "インナー・ルームウェア", "その他"],
  gu: ["トップス", "アウター・パンツ", "ワンピース", "グッズ・その他"],
};

// 周期表に出す商品グループの下限。1日しか観測できていないグループを並べても
// 「周期」は読み取れず、行数だけが増える。ここを 1 にすると、その日たまたま
// 一覧に載っていただけの商品が何千行も並ぶ。
const MIN_OBSERVED_DAYS = 2;

// 1年のうちどれだけ見に行けていれば「その年は値下げが無かった」と言ってよいか。
// この割合に届かない年は、値下げの記録が無くても「未確認」と出す。
// 0.9 は「その年のほぼ毎日見に行けた」に相当する。
const CONFIDENT_COVERAGE_RATIO = 0.9;

let state = { brand: "uniqlo", gender: "men" };
// brand/gender ごとに一度読んだら使い回す。タブを行き来するたびに
// 同じ集計を読み直さない。
const cache = new Map();

const countFormatter = new Intl.NumberFormat("ja-JP");
const currencyFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

// ビューが返す日付は日本時間の暦日 "YYYY-MM-DD"。閲覧者のタイムゾーンで
// 解釈し直すと1日ずれるので、文字列のまま切って出す。
function formatDay(isoDay) {
  if (!isoDay) return null;
  const [, month, day] = isoDay.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// --- データ取得 -------------------------------------------------------------

// PostgREST は1リクエスト1,000行で切れる。切れてもエラーにはならず黙って
// 短い配列が返るだけなので、必ず最後まで辿る(docs/app.js と同じ理由)。
const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;

async function fetchAll(table, columns, apply) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    query = apply(query);
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  console.warn(`${table}: ${MAX_ROWS}行の上限に達しました。これより先は読み込んでいません。`);
  return rows;
}

async function loadAnalysis(brand, gender) {
  const scope = (query) => query.eq("brand", brand).eq("gender", gender);

  const [coverage, cycles, ruleSummary, dropDistribution, exceptions] = await Promise.all([
    fetchAll(
      "analysis_coverage_years",
      "year, covered_days, run_log_days, first_covered_day, last_covered_day, days_elapsed, coverage_ratio",
      (q) => scope(q).order("year", { ascending: false })
    ),
    fetchAll(
      "analysis_group_year_cycles",
      "category, group_key, display_name, url, year, product_count, observed_days, first_seen_day, last_seen_day, " +
        "first_markdown_day, last_markdown_day, markdown_days, first_limited_day, last_limited_day, limited_days, " +
        "min_price, max_price, first_markdown_censored, first_limited_censored, covered_days, coverage_ratio",
      (q) => scope(q).gte("observed_days", MIN_OBSERVED_DAYS).order("group_key").order("year")
    ),
    fetchAll(
      "analysis_discount_rule_summary",
      "rule_band, rule_confidence, expected_drop, verdict, drops, first_day, last_day, avg_drop",
      (q) => scope(q)
    ),
    fetchAll("analysis_drop_amount_distribution", "rule_band, year, drop_amount, drops, groups", (q) =>
      scope(q).order("drops", { ascending: false })
    ),
    // 例外だけは1件ずつ見たいので生の行を取る。新しい順に上限つき。
    fetchAll(
      "analysis_discount_rule_checks",
      "display_name, url, category, group_key, from_day, to_day, from_price, to_price, drop_amount, " +
        "expected_drop, rule_band, rule_confidence, from_price_type, to_price_type, to_event_type",
      (q) => scope(q).eq("verdict", "exception").order("to_day", { ascending: false }).limit(300)
    ),
  ]);

  return { coverage, cycles, ruleSummary, dropDistribution, exceptions };
}

// --- 1. 巡回カバレッジ ------------------------------------------------------

// 周期表より前に置く。「今年の初動値下げは5/2でした」と出す前に、そもそも
// その年の何日ぶんを見に行けているのかが分かっていないと、日付を読み違える。
function renderCoverage(container, coverage) {
  const section = el("section", "section");
  const header = el("div", "section-header");
  header.appendChild(el("span", "label", "巡回できた日"));
  header.appendChild(
    el("span", "count", coverage.length === 0 ? "記録なし" : `${coverage.length}年ぶん`)
  );
  section.appendChild(header);

  const note = el("p", "note");
  note.textContent =
    "このブランド・性別を実際に見に行けた日数です。周期表の「未確認」はここから決まります。" +
    "「実行ログ」は巡回スクリプト自身が残した記録(scrape_runs)の日数、残りは価格の記録がある日からの推定です" +
    "(実行ログを取り始める前の期間)。推定のほうは、一覧が0件を返して1商品も取れなかった日を成功として" +
    "数えてしまう可能性があります。";
  section.appendChild(note);

  if (coverage.length === 0) {
    section.appendChild(el("div", "empty", "まだ巡回の記録がありません。"));
    container.appendChild(section);
    return;
  }

  const panel = el("div", "panel");
  const scroll = el("div", "table-scroll");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const [label, className] of [
    ["年", ""],
    ["巡回できた日数", "num"],
    ["その年の経過日数", "num"],
    ["カバー率", "num"],
    ["うち実行ログ", "num"],
    ["最初", ""],
    ["最後", ""],
  ]) {
    const th = el("th", className, label);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of coverage) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "day", `${row.year}年`));
    tr.appendChild(el("td", "num", countFormatter.format(row.covered_days)));
    tr.appendChild(el("td", "num", countFormatter.format(row.days_elapsed)));
    const ratio = Number(row.coverage_ratio ?? 0);
    tr.appendChild(el("td", "num", `${(ratio * 100).toFixed(1)}%`));
    tr.appendChild(el("td", "num", countFormatter.format(row.run_log_days)));
    tr.appendChild(el("td", "muted", row.first_covered_day ?? "—"));
    tr.appendChild(el("td", "muted", row.last_covered_day ?? "—"));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  panel.appendChild(scroll);
  section.appendChild(panel);
  container.appendChild(section);
}

// --- 2. 周期表 --------------------------------------------------------------

function categoryOrderFor(brand, categories) {
  const known = CATEGORY_ORDER[brand] || [];
  const ordered = known.filter((c) => categories.includes(c));
  const extra = categories.filter((c) => !known.includes(c)).sort();
  return [...ordered, ...extra];
}

// その年、この商品グループについて何が言えるか。
//
//   観測あり  … その年に値下げ/期間限定として実際に見つけた(日付を出す)
//   該当なし  … その年はほぼ毎日見に行けていて、それでも見つからなかった
//   未確認    … 見に行けていない期間が多く、無かったとは言えない
//
// 「未確認」と「該当なし」を混ぜないのがこの表の肝で、混ぜると巡回が
// 止まっていた期間がそのまま「値下げされなかった年」として出てしまう。
function cellFor(day, censored, coverageRatio) {
  if (day) {
    return {
      text: formatDay(day),
      // 「その年の最初に見に行けた日」以前に既に値下げされていた場合、
      // 本当の初動はそれより前かもしれない。断定しない。
      tag: censored ? "この日以前" : null,
      tagClass: "censored",
      title: censored
        ? `${day} には既にこの状態でした。その年の最初の巡回日以前なので、実際の開始日はもっと早い可能性があります。`
        : day,
    };
  }
  const confident = Number(coverageRatio ?? 0) >= CONFIDENT_COVERAGE_RATIO;
  return confident
    ? { text: "該当なし", tag: null, tagClass: null, muted: true, title: "その年はほぼ毎日巡回できており、それでも観測されませんでした。" }
    : {
        text: "未確認",
        tag: null,
        tagClass: "unknown",
        title: "その年は巡回できていない期間が多く、無かったとは言えません。",
      };
}

function buildCell(cell) {
  const td = el("td", cell.muted ? "muted" : null);
  if (cell.title) td.title = cell.title;
  if (cell.tagClass === "unknown") {
    td.appendChild(el("span", "tag unknown", cell.text));
  } else {
    td.appendChild(el("span", "day", cell.text));
  }
  if (cell.tag) {
    td.appendChild(document.createTextNode(" "));
    td.appendChild(el("span", "tag censored", cell.tag));
  }
  return td;
}

function renderCycleTable(brand, container, cycles) {
  const section = el("section", "section");
  const header = el("div", "section-header");
  header.appendChild(el("span", "label", "商品カテゴリ別 周期表"));

  const groupCount = new Set(cycles.map((r) => r.group_key)).size;
  header.appendChild(
    el("span", "count", `${countFormatter.format(groupCount)}グループ / ${countFormatter.format(cycles.length)}行`)
  );
  section.appendChild(header);

  const note = el("p", "note");
  note.textContent =
    "商品グループごとに、年ごとの「初めて値下げとして観測した日」「初めて期間限定価格として観測した日」を並べています。" +
    `観測が${MIN_OBSERVED_DAYS}日未満のグループは、周期として読めないので出していません。` +
    "商品コードは季節ごとに振り直されるため、グループは商品名を正規化したキーで作っています" +
    "(表記ゆれは自動で吸収、改名は手動の対応付け)。値札が実際に書き換わった日ではなく、" +
    "このトラッカーが一覧で見つけた日であることに注意してください。";
  section.appendChild(note);

  if (cycles.length === 0) {
    section.appendChild(el("div", "empty", "まだ周期表を作れるだけのデータがありません。"));
    container.appendChild(section);
    return;
  }

  const byCategory = new Map();
  for (const row of cycles) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, []);
    byCategory.get(row.category).push(row);
  }

  for (const category of categoryOrderFor(brand, [...byCategory.keys()])) {
    const rows = byCategory.get(category);
    if (!rows || rows.length === 0) continue;

    const group = document.createElement("details");
    group.className = "category-group";
    const summary = document.createElement("summary");
    summary.appendChild(el("span", "group-label", category));
    const groups = new Set(rows.map((r) => r.group_key)).size;
    summary.appendChild(el("span", "group-count", `${countFormatter.format(groups)}グループ`));
    group.appendChild(summary);

    const body = el("div", "body");
    group.appendChild(body);

    // 閉じている間は中身を作らない。全カテゴリぶんを最初に組み立てると
    // 数千行のテーブルがDOMに載るが、実際に開かれるのはその一部だけ
    // (index.html のカテゴリ折りたたみと同じ考え方)。
    let rendered = false;
    group.addEventListener("toggle", () => {
      if (!group.open || rendered) return;
      rendered = true;
      body.appendChild(buildCycleTable(rows));
    });

    section.appendChild(group);
  }

  container.appendChild(section);
}

function buildCycleTable(rows) {
  const scroll = el("div", "table-scroll");
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["商品グループ", "年", "初動値下げ", "初 期間限定", "値下げ日数", "期間限定日数", "観測日数", "価格帯"]) {
    headRow.appendChild(el("th", null, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  // グループごとにまとめ、その中は年の新しい順。直近の年が上に来るほうが
  // 「今年はいつだったか」を探しやすい。
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.group_key)) byGroup.set(row.group_key, []);
    byGroup.get(row.group_key).push(row);
  }
  const ordered = [...byGroup.values()].sort((a, b) => {
    // 直近の初動値下げが早いグループを先に。「例年いつから値下げが始まるか」
    // を上から順に読めるようにする。
    const keyOf = (list) => {
      const latest = list[list.length - 1];
      return latest.first_markdown_day || latest.first_limited_day || latest.first_seen_day || "9999-99-99";
    };
    return keyOf(a).slice(5).localeCompare(keyOf(b).slice(5));
  });

  const tbody = document.createElement("tbody");
  for (const groupRows of ordered) {
    const years = [...groupRows].sort((a, b) => b.year - a.year);
    years.forEach((row, i) => {
      const tr = document.createElement("tr");
      // 商品名は1グループにつき1回しか出さない(同じ名前が年の数だけ並ぶと、
      // どこからどこまでが同じ商品なのか逆に読み取りにくい)。名前の無い行が
      // 続く形になるので、グループの先頭に区切り線を入れて境目を示す。
      if (i === 0) tr.className = "group-start";

      const nameCell = el("td", "group-name");
      if (i === 0) {
        if (row.url) {
          const link = el("a", null, row.display_name || row.group_key);
          link.href = row.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          nameCell.appendChild(link);
        } else {
          nameCell.textContent = row.display_name || row.group_key;
        }
      }
      tr.appendChild(nameCell);

      tr.appendChild(el("td", null, `${row.year}`));
      tr.appendChild(buildCell(cellFor(row.first_markdown_day, row.first_markdown_censored, row.coverage_ratio)));
      tr.appendChild(buildCell(cellFor(row.first_limited_day, row.first_limited_censored, row.coverage_ratio)));
      tr.appendChild(el("td", "num", countFormatter.format(row.markdown_days)));
      tr.appendChild(el("td", "num", countFormatter.format(row.limited_days)));
      tr.appendChild(el("td", "num", countFormatter.format(row.observed_days)));
      tr.appendChild(
        el(
          "td",
          "num muted",
          row.min_price === row.max_price
            ? currencyFormatter.format(row.min_price)
            : `${currencyFormatter.format(row.min_price)}〜${currencyFormatter.format(row.max_price)}`
        )
      );
      tbody.appendChild(tr);
    });
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}

// --- 3. 値引きルールの検証 --------------------------------------------------

const RULE_BANDS = [
  {
    key: "from_2990",
    title: "2,990円以上 → 1,000円引き",
    sub: "既知のルール。値下げ前の価格が2,990円以上20,000円以下の帯。",
  },
  {
    key: "over_20000",
    title: "20,000円超 → 3,000円引き",
    sub: "傾向として知られているが未確定(今年の値上げの影響が読めていないため)。実測がルールを支持しているかをここで見る。",
  },
];

const VERDICT_LABELS = {
  match: "ルール通り",
  multiple: "整数倍",
  exception: "例外",
  unjudgeable_gap: "判定不能(巡回の抜け)",
  unjudgeable_mechanism: "判定不能(会員価格)",
};

function renderRuleChecks(container, { ruleSummary, dropDistribution, exceptions }) {
  const section = el("section", "section");
  const header = el("div", "section-header");
  header.appendChild(el("span", "label", "値引きルールの検証"));
  header.appendChild(el("span", "count", `例外 ${countFormatter.format(exceptions.length)}件`));
  section.appendChild(header);

  const note = el("p", "note");
  note.textContent =
    "値下げ前の価格は、このトラッカー自身が直前に観測していた価格です(このトラッカーは値下げ一覧・期間限定価格一覧しか" +
    "巡回しないため、定価そのものは一般には取れません)。前回の観測から2日以上空いている値下がりは、その間に" +
    "何段進んだか決められないので「判定不能」として、ルールに合った・外れたのどちらにも数えていません。" +
    "GUのアプリ会員特別価格をまたぐ変化も、値下げの段階ではなく別の価格体系への切り替えなので同じく判定不能です。";
  section.appendChild(note);

  const byBand = new Map();
  for (const row of ruleSummary) {
    if (!byBand.has(row.rule_band)) byBand.set(row.rule_band, []);
    byBand.get(row.rule_band).push(row);
  }

  let anyBand = false;
  for (const band of RULE_BANDS) {
    const rows = byBand.get(band.key) || [];
    const total = rows.reduce((sum, r) => sum + r.drops, 0);
    if (total === 0) continue;
    anyBand = true;
    section.appendChild(buildRuleCard(band, rows, total, dropDistribution.filter((d) => d.rule_band === band.key)));
  }

  if (!anyBand) {
    section.appendChild(
      el("div", "empty", "ルールを検証できる値下がりがまだ観測できていません(同じ商品を2日続けて観測する必要があります)。")
    );
    container.appendChild(section);
    return;
  }

  section.appendChild(buildExceptionList(exceptions));
  container.appendChild(section);
}

function buildRuleCard(band, rows, total, distribution) {
  const card = el("div", "rule-card");
  card.appendChild(el("h3", null, band.title));

  const confidence = rows[0]?.rule_confidence;
  const sub = el("div", "rule-sub");
  sub.textContent = band.sub;
  if (confidence === "provisional") {
    sub.appendChild(document.createTextNode(" "));
    sub.appendChild(el("span", "tag censored", "未確定"));
  }
  card.appendChild(sub);

  const counts = new Map(rows.map((r) => [r.verdict, r.drops]));
  const get = (v) => counts.get(v) ?? 0;
  const judged = get("match") + get("multiple") + get("exception");
  const unjudgeable = get("unjudgeable_gap") + get("unjudgeable_mechanism");

  const bar = el("div", "verdict-bar");
  for (const [cls, value] of [
    ["match", get("match")],
    ["multiple", get("multiple")],
    ["exception", get("exception")],
    ["unjudgeable", unjudgeable],
  ]) {
    if (value === 0) continue;
    const part = el("span", cls);
    part.style.flexGrow = String(value);
    bar.appendChild(part);
  }
  card.appendChild(bar);

  const legend = el("div", "verdict-legend");
  const addLegend = (label, value, cls) => {
    const item = el("span", cls ? `tag ${cls}` : null);
    item.textContent = `${label} `;
    const strong = el("b", null, countFormatter.format(value));
    item.appendChild(strong);
    legend.appendChild(item);
  };
  addLegend(VERDICT_LABELS.match, get("match"), "match");
  if (get("multiple") > 0) addLegend(VERDICT_LABELS.multiple, get("multiple"), "multiple");
  addLegend(VERDICT_LABELS.exception, get("exception"), "exception");
  if (unjudgeable > 0) addLegend("判定不能", unjudgeable, "unjudgeable");
  if (judged > 0) {
    const rate = el("span", null);
    rate.textContent = "ルール通りの割合 ";
    // 分母は判定できたぶんだけ。判定不能を分母に入れると、巡回が抜けた日の
    // ぶんだけルールの適合率が下がって見える。
    rate.appendChild(el("b", null, `${((get("match") / judged) * 100).toFixed(1)}%`));
    legend.appendChild(rate);
  }
  card.appendChild(legend);

  if (distribution.length > 0) {
    card.appendChild(buildDistributionTable(distribution));
  }
  return card;
}

// 実測の引き幅そのもの。件数の比だけでは「ではいくら引かれているのか」が
// 分からないので、年ごとに並べる。20,000円超の帯が今年も3,000円引きなのか、
// それとも変わったのかは、この表が答える。
function buildDistributionTable(distribution) {
  const scroll = el("div", "table-scroll");
  scroll.style.marginTop = "0.7rem";
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["年", "実測の引き幅", "回数", "商品グループ数"]) headRow.appendChild(el("th", null, label));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const sorted = [...distribution].sort((a, b) => b.year - a.year || b.drops - a.drops);
  for (const row of sorted.slice(0, 20)) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", null, `${row.year}`));
    tr.appendChild(el("td", "day", currencyFormatter.format(row.drop_amount)));
    tr.appendChild(el("td", "num", countFormatter.format(row.drops)));
    tr.appendChild(el("td", "num", countFormatter.format(row.groups)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}

function buildExceptionList(exceptions) {
  const panel = el("div", "panel");
  panel.appendChild(el("h3", null, "ルールから外れた値下げ"));

  if (exceptions.length === 0) {
    panel.appendChild(
      el("p", "note", "判定できた値下がりはすべてルール通りでした(整数倍を含む)。")
    );
    return panel;
  }

  const note = el("p", "note");
  note.textContent =
    "前回の観測から1日で、既知のルールとも整数倍とも違う幅で下がったものだけを出しています。新しい順・最大300件。";
  panel.appendChild(note);

  const scroll = el("div", "table-scroll");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["日", "商品", "カテゴリ", "値下げ前", "値下げ後", "実測の引き幅", "ルール上の引き幅", "差"]) {
    headRow.appendChild(el("th", null, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of exceptions) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", "day", formatDay(row.to_day)));

    const nameCell = el("td", "group-name");
    if (row.url) {
      const link = el("a", null, row.display_name || row.group_key);
      link.href = row.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      nameCell.appendChild(link);
    } else {
      nameCell.textContent = row.display_name || row.group_key;
    }
    tr.appendChild(nameCell);

    tr.appendChild(el("td", "muted", row.category));
    tr.appendChild(el("td", "num", currencyFormatter.format(row.from_price)));
    tr.appendChild(el("td", "num", currencyFormatter.format(row.to_price)));
    tr.appendChild(el("td", "num day", currencyFormatter.format(row.drop_amount)));
    tr.appendChild(el("td", "num muted", currencyFormatter.format(row.expected_drop)));

    const diff = row.drop_amount - row.expected_drop;
    const diffCell = el("td", "num");
    diffCell.appendChild(el("span", "tag exception", `${diff > 0 ? "+" : ""}${currencyFormatter.format(diff)}`));
    tr.appendChild(diffCell);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  panel.appendChild(scroll);
  return panel;
}

// --- 描画 -------------------------------------------------------------------

function renderContent(data) {
  contentEl.innerHTML = "";
  contentEl.style.setProperty("--brand-color", BRAND_CONFIG[state.brand].color);
  renderCoverage(contentEl, data.coverage);
  renderCycleTable(state.brand, contentEl, data.cycles);
  renderRuleChecks(contentEl, data);
}

function setActiveTab(container, attr, value) {
  for (const btn of container.querySelectorAll("button")) {
    const isActive = btn.dataset[attr] === value;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  }
}

function updateTabs() {
  setActiveTab(brandTabsEl, "brand", state.brand);
  setActiveTab(genderTabsEl, "gender", state.gender);
}

// タブを切り替えるたびに走る。読み込み中に別のタブへ移られても、後から
// 返ってきた古いリクエストで画面を上書きしないよう、最後の要求だけを描く。
let requestSeq = 0;

async function show() {
  updateTabs();
  const key = `${state.brand}/${state.gender}`;
  const seq = ++requestSeq;

  if (cache.has(key)) {
    statusEl.textContent = "";
    renderContent(cache.get(key));
    return;
  }

  statusEl.textContent = "集計を読み込み中…";
  statusEl.classList.remove("error");
  contentEl.innerHTML = "";
  try {
    const data = await loadAnalysis(state.brand, state.gender);
    cache.set(key, data);
    if (seq !== requestSeq) return;
    statusEl.textContent = "";
    renderContent(data);
  } catch (err) {
    if (seq !== requestSeq) return;
    statusEl.textContent =
      `集計の読み込みに失敗しました: ${err.message}。` +
      "分析用のビューがまだ作られていない可能性があります(supabase/migrations の 0007〜0009 が適用済みか確認してください)。";
    statusEl.classList.add("error");
  }
}

brandTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-brand]");
  if (!btn) return;
  state = { ...state, brand: btn.dataset.brand };
  show();
});

genderTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-gender]");
  if (!btn) return;
  state = { ...state, gender: btn.dataset.gender };
  show();
});

show();
