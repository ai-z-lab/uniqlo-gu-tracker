// riseOf() の単体テスト — docs/price-logic.js の実コードを直接インポート。
// node scripts/test-rise-of.mjs で実行。

import { riseOf, priceStagePoints, markdownStagePoints, markdownStageCount } from "../docs/price-logic.js";

function row(price, event_type, scraped_at, price_type) {
  return { price, event_type, scraped_at, currency: "JPY", price_type: price_type ?? null };
}

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  const ok =
    expected === null
      ? actual === null
      : actual !== null &&
        actual.from === expected.from &&
        actual.to === expected.to;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("riseOf() のテスト (docs/price-logic.js)\n");

// 1. 値下げだけ — 値上げなし
assert(
  "値下げのみ → null",
  riseOf([row(2000, "markdown", "2026-09-01"), row(1500, "markdown", "2026-09-10")]),
  null
);

// 2. 値上げ後そのまま (markdown として記録され続ける)
assert(
  "値下げ → 値上げ → そのまま → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1500, "markdown",  "2026-09-30"),
  ]),
  { from: 1000, to: 1500 }
);

// 3. 値上げ後に値下げで価格が下がった — rise は終了
assert(
  "値上げ → markdown で下がる → null",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "markdown",  "2026-10-01"),
  ]),
  null
);

// 4. バグ修正確認: 値上げ後に期間限定で下がっても rise は効いたまま
assert(
  "値上げ → 期間限定で下がる → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "limited",   "2026-10-05"),
  ]),
  { from: 1000, to: 1500 }
);

// 5. first_limited でも同様
assert(
  "値上げ → first_limited で下がる → rise を返す",
  riseOf([
    row(1000, "markdown",       "2026-08-01"),
    row(1500, "price_up",       "2026-09-29"),
    row(1200, "first_limited",  "2026-10-05"),
  ]),
  { from: 1000, to: 1500 }
);

// 6. 期間限定後に markdown で下がる — rise は終了
assert(
  "値上げ → 期間限定 → markdown でさらに下がる → null",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "limited",   "2026-10-05"),
    row(1100, "markdown",  "2026-10-20"),
  ]),
  null
);

// 7. 期間限定が終わって元値に戻る — 戻りは値上げに数えない
assert(
  "markdown → 期間限定で下がる → 戻り(price_up) → null",
  riseOf([
    row(1000, "markdown",  "2026-08-01"),
    row( 800, "limited",   "2026-09-01"),
    row(1000, "price_up",  "2026-10-01"),
  ]),
  null
);

// 8. 値上げのあと期間限定が複数回続いても値上げは効いたまま
assert(
  "値上げ → 期間限定1 → 期間限定2(価格変化) → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "limited",   "2026-10-05"),
    row(1100, "limited",   "2026-10-12"),
  ]),
  { from: 1000, to: 1500 }
);

// 9. 値上げなし — 期間限定のみ
assert(
  "期間限定のみ → null",
  riseOf([
    row(1000, "markdown",      "2026-08-01"),
    row( 800, "first_limited", "2026-09-01"),
    row( 800, "limited",       "2026-09-08"),
  ]),
  null
);

// 10. 値上げが2回 — 最後の値上げを返す
assert(
  "値上げ1回目 → 下がる → 値上げ2回目 → rise は2回目",
  riseOf([
    row(1000, "markdown", "2026-07-01"),
    row(1500, "price_up",  "2026-08-01"),
    row(1200, "markdown",  "2026-08-15"),
    row(1800, "price_up",  "2026-09-29"),
    row(1800, "markdown",  "2026-09-30"),
  ]),
  { from: 1200, to: 1800 }
);

// 11. 値上げ後に期間限定、その期間中に複数回スクレイプ(同一価格)
assert(
  "値上げ → 期間限定 → 同価格で再スクレイプ → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "limited",   "2026-10-05"),
    row(1200, "limited",   "2026-10-06"),
    row(1200, "limited",   "2026-10-07"),
  ]),
  { from: 1000, to: 1500 }
);

// 12. GU アプリ会員価格(DB 上は limited として記録) — 値上げ後の会員価格も rise を保持
assert(
  "値上げ → 会員価格(event_type=limited, price_type=member)で下がる → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "limited",   "2026-10-07", "member"),
  ]),
  { from: 1000, to: 1500 }
);

// 13. GU アプリ会員価格が値下げ棚で記録された場合(event_type=markdown, price_type=member)。
// scrape.mjs の classifyEventType は listingType で event_type を決めるため、
// 値下げ棚掲載で会員 API 価格が通常価格より安ければ event_type=markdown のまま
// price_type=member になる。LIMITED_EVENT_TYPES だけでは捕まえられないケース。
assert(
  "値上げ → 会員価格(event_type=markdown, price_type=member)で下がる → rise を返す",
  riseOf([
    row(1000, "markdown", "2026-08-01"),
    row(1500, "price_up",  "2026-09-29"),
    row(1200, "markdown",  "2026-10-07", "member"),
  ]),
  { from: 1000, to: 1500 }
);

console.log(`\n結果: ${passed} 件成功, ${failed} 件失敗`);
if (failed > 0) process.exit(1);
