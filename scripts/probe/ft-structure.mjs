// 調査用: fashion-trackers のページ構造を確かめる(1回だけ・数ページだけ取得する)。
const UA = 'uniqlo-gu-tracker (personal price log; low-volume; contact: gwctsuji@gmail.com)';
const get = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP' } });
  return { status: res.status, html: await res.text() };
};
const show = (label, html) => {
  console.log(`\n===== ${label} (len ${html.length}) =====`);
  console.log('has __NEXT_DATA__:', html.includes('__NEXT_DATA__'), ' has application/ld+json:', html.includes('application/ld+json'));
  const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nd) console.log('NEXT_DATA head:', nd[1].slice(0, 1500));
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1].slice(0, 800));
  ld.forEach((x, i) => console.log(`ld+json[${i}]:`, x));
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('TEXT head:', text.slice(0, 1800));
  const pager = [...html.matchAll(/href="([^"]*(?:page|p)=\d+[^"]*)"/g)].map((m) => m[1]).slice(0, 8);
  console.log('pager links:', pager);
  const prod = [...html.matchAll(/href="(\/products\/[^"]+)"/g)].map((m) => m[1]);
  console.log('product links:', prod.length, prod.slice(0, 5));
};
const list = await get('https://uniqlo.fashion-trackers.com/price-down/history');
console.log('history status', list.status);
show('history', list.html);
await new Promise((r) => setTimeout(r, 3000));
const prod = await get('https://uniqlo.fashion-trackers.com/products/E487832-000');
console.log('product status', prod.status);
show('product E487832-000', prod.html);
