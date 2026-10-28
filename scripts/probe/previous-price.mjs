// 調査用: UNIQLO の価格APIに includePreviousPrice=true を付けると値下げ前の価格が返るかを確かめる。
// データベースには何も書かない。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ids = process.argv.slice(2);
for (const id of ids) {
  const [code, pg] = id.split(':');
  for (const flag of ['false', 'true']) {
    const url = `https://www.uniqlo.com/jp/api/commerce/v5/ja/products/${code}/price-groups/${pg}/l2s?withPrices=true&withStocks=false&includePreviousPrice=${flag}&withMemberPricing=true`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP', Referer: 'https://www.uniqlo.com/jp/ja/' } });
      const body = await res.json();
      const prices = body?.result?.prices ?? {};
      const first = Object.values(prices)[0];
      const uniq = new Set(Object.values(prices).map((p) => JSON.stringify(p)));
      console.log(`### ${code}/${pg} includePreviousPrice=${flag} HTTP ${res.status} variants=${uniq.size}`);
      for (const p of [...uniq].slice(0, 3)) console.log(p);
      if (!first) console.log(JSON.stringify(body).slice(0, 800));
    } catch (e) {
      console.log(`### ${code}/${pg} includePreviousPrice=${flag} ERROR ${e.message}`);
    }
  }
  // 商品詳細APIにも元値が載っているかを見る
  try {
    const res = await fetch(`https://www.uniqlo.com/jp/api/commerce/v5/ja/products?productIds=${code}&priceGroups=${pg}&includePreviousPrice=true&withPrices=true`, { headers: { 'User-Agent': UA, Referer: 'https://www.uniqlo.com/jp/ja/' } });
    const body = await res.json();
    const item = body?.result?.items?.[0];
    console.log(`### ${code}/${pg} products-api HTTP ${res.status} name=${item?.name}`);
    console.log(JSON.stringify(item?.prices ?? body).slice(0, 800));
  } catch (e) {
    console.log(`### ${code}/${pg} products-api ERROR ${e.message}`);
  }
}
