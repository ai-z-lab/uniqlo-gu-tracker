// 調査用: 商品一覧API(products/search)の prices の中身を見る。DBには何も書かない。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const post = async (body) => {
  const res = await fetch('https://www.uniqlo.com/jp/api/commerce/v5/ja/products/search?httpFailure=true', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP', 'Content-Type': 'application/json', Origin: 'https://www.uniqlo.com', Referer: 'https://www.uniqlo.com/jp/ja/' },
    body: JSON.stringify(body),
  });
  return res.json();
};
for (const [label, api] of [
  ['全商品(女性)', { genderIds: [1071], flagCodes: [] }],
  ['値下げ(女性)', { genderIds: [1071], flagCodes: ['discount'] }],
  ['期間限定(女性)', { genderIds: [1071], flagCodes: ['limitedOffer'] }],
]) {
  const json = await post({ ...api, offset: 0, limit: 6 });
  console.log(`\n### ${label}`);
  for (const it of json?.result?.items ?? []) {
    console.log(`${it.productId}/${it.priceGroup} ${it.name} | promotionText=${JSON.stringify(it.promotionText)} | prices=${JSON.stringify(it.prices)}`);
  }
}
