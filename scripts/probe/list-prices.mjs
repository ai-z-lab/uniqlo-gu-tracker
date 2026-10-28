// 調査用: 商品一覧API(products/search)が価格を返すか、全商品(flagCodes なし)が引けるかを確かめる。
// DBには何も書かない。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const post = async (body) => {
  const res = await fetch('https://www.uniqlo.com/jp/api/commerce/v5/ja/products/search?httpFailure=true', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP', 'Content-Type': 'application/json', Origin: 'https://www.uniqlo.com', Referer: 'https://www.uniqlo.com/jp/ja/' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
for (const [label, api] of [
  ['全商品(女性, flagCodes なし)', { genderIds: [1071], flagCodes: [] }],
  ['値下げ(女性)', { genderIds: [1071], flagCodes: ['discount'] }],
]) {
  for (const limit of [36, 100]) {
    const { status, json } = await post({ ...api, offset: 0, limit });
    const items = json?.result?.items ?? [];
    console.log(`\n### ${label} limit=${limit} HTTP ${status} items=${items.length} total=${json?.result?.pagination?.total}`);
    if (limit === 36 && items[0]) {
      console.log('item keys:', Object.keys(items[0]).join(','));
      console.log('item[0] (trunc):', JSON.stringify(items[0]).slice(0, 1500));
      const withPrice = items.filter((i) => i.prices || i.price).length;
      console.log('items with prices/price field:', withPrice, '/', items.length);
    }
    if (!items.length) console.log(JSON.stringify(json).slice(0, 600));
  }
}
// 全商品が最後のページまで辿れるか(件数だけ数える。最大60ページ・0.4秒間隔)
let offset = 0, n = 0;
for (let page = 0; page < 60; page++) {
  const { json } = await post({ genderIds: [1071], flagCodes: [], offset, limit: 36 });
  const items = json?.result?.items ?? [];
  n += items.length;
  if (items.length === 0 || n >= (json?.result?.pagination?.total ?? 0)) break;
  offset += 36;
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\n全商品(女性)を最後まで辿った件数: ${n}`);
