import { readFile, writeFile } from 'node:fs/promises';
const API = 'https://open.api.nexon.com';
const KEY = process.env.NEXON_API_KEY;
const FILE = new URL('../prices.json', import.meta.url);
const MAX_PAGES = 5, DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!KEY) { console.error('NEXON_API_KEY 환경 변수가 없어요.'); process.exit(1); }
// 일일 한도가 다 차면(요청 제한이 연달아 나면) 남은 호출은 보내지 않고 바로 실패 처리해요
let limitHits = 0; const LIMIT_STOP = 3;
async function call(path, params) {
  if (limitHits >= LIMIT_STOP) throw new Error(`${path}: 요청 제한으로 실패했어요 (한도 소진 · 호출 생략)`);
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  for (let a = 0; a < 3; a++) {
    const res = await fetch(url, { headers: { 'x-nxopen-api-key': KEY, accept: 'application/json' } });
    if (res.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    limitHits = 0; return res.json();
  }
  limitHits += 1;
  throw new Error(`${path}: 요청 제한으로 실패했어요`);
}
async function collect(path, params, maxPages = MAX_PAGES) {
  const items = []; let cursor;
  for (let p = 0; p < maxPages; p++) {
    const d = await call(path, { ...params, cursor });
    (d.auction_item || d.auction_history || []).forEach((it) => items.push(it));
    cursor = d.next_cursor; await sleep(DELAY_MS);
    if (!cursor) break;
  }
  return items;
}
// 미완성 장비(표시 이름 끝에 '(미완성)', 공정률이 남은 제작품)는 완성품보다 훨씬 싸서 시세에서 빼요
const unfinished = (it) => /\(미완성\)/.test(String(it.item_display_name || ''));
function summarize(list, into) {
  for (const it of list) {
    if (unfinished(it)) continue;
    const price = Number(it.auction_price_per_unit);
    if (!(price > 0)) continue;
    // 인챈트 스크롤 등은 표시 이름에 인챈트 이름이 붙어 있어 두 이름 모두 기록해요
    for (const name of new Set([it.item_name, it.item_display_name].filter(Boolean))) {
      const c = into[name];
      if (!c) into[name] = { min: price, count: 1 }; else { c.min = Math.min(c.min, price); c.count += 1; }
    }
  }
  return into;
}
const prices = JSON.parse(await readFile(FILE, 'utf8'));
const items = {}; const errors = [];
for (const name of prices.watch || []) { try { summarize(await collect('/mabinogi/v1/auction/list', { item_name: name }), items); } catch (e) { errors.push(String(e.message || e)); } }
for (const keyword of prices.keywords || []) { try { summarize(await collect('/mabinogi/v1/auction/keyword-search', { keyword }), items); } catch (e) { errors.push(String(e.message || e)); } }
// 카테고리 전체(인챈트 스크롤 · 장비) — 호출량이 많아서 실행마다 가장 오래된 카테고리 몇 개만(categoryPerRun) 새로 받아요
// 카테고리별 결과는 scripts/category-cache.json에 따로 두고(사이트에는 올리지 않음), 합친 결과만 prices.categoryItems로 써요
const CACHE = new URL('./category-cache.json', import.meta.url);
let cache = {}; try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch (e) {}
const cats = prices.categories || [];
// 처음에는 지난 합본을 '_legacy'로 두고, 모든 카테고리를 한 번씩 받으면 지워요
if (!Object.keys(cache).length && prices.categoryItems && Object.keys(prices.categoryItems).length) cache._legacy = { at: prices.categoryUpdatedAt || '', items: prices.categoryItems };
const perRun = Number(prices.categoryPerRun) || Math.ceil(cats.length / 4);
const ageOf = (c) => (cache[c] && Date.parse(cache[c].at)) || 0;
const due = cats.slice().sort((x, y) => ageOf(x) - ageOf(y)).slice(0, perRun);
const histFresh = {};
for (const cat of due) {
  try {
    const fresh = summarize(await collect('/mabinogi/v1/auction/list', { auction_item_category: cat }, Number(prices.categoryMaxPages) || 10), {});
    cache[cat] = { at: new Date().toISOString(), items: fresh }; prices.categoryUpdatedAt = cache[cat].at;
  } catch (e) { errors.push(String(e.message || e)); }
  // 거래 내역 — 지금 매물이 없는 아이템은 최근 거래가로 보여주려고 같은 카테고리의 거래 내역도 받아요 · 이름별로 가장 최근 거래 1건(가격 · 시각)
  try {
    const list = await collect('/mabinogi/v1/auction/history', { auction_item_category: cat }, Number(prices.historyMaxPages) || 5);
    for (const it of list) {
      const price = Number(it.auction_price_per_unit); if (!(price > 0) || unfinished(it)) continue;
      const at = it.date_auction_buy || it.date_auction_expire || '';
      for (const name of new Set([it.item_name, it.item_display_name].filter(Boolean))) {
        const c = histFresh[name];
        if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) histFresh[name] = { last: price, at };
      }
    }
  } catch (e) { errors.push(String(e.message || e)); }
}
for (const k of Object.keys(cache)) if (k !== '_legacy' && !cats.includes(k)) delete cache[k];
if (cats.every((c) => cache[c])) delete cache._legacy;
// 합본: 같은 이름이 여러 카테고리에 있으면 최저가는 가장 낮은 값, 매물 수는 합계
const catItems = {};
for (const k of ['_legacy'].concat(cats)) {
  const part = cache[k] && cache[k].items; if (!part) continue;
  for (const [name, v] of Object.entries(part)) {
    if (k === '_legacy' && cats.some((c) => cache[c] && cache[c].items[name])) continue;
    const c = catItems[name]; if (!c) catItems[name] = { min: v.min, count: v.count }; else { c.min = Math.min(c.min, v.min); c.count += v.count; }
  }
}
prices.categoryItems = catItems;
await writeFile(CACHE, JSON.stringify(cache) + '\n');
let histItems = prices.historyItems || {};
if (Object.keys(histFresh).length) { histItems = Object.assign({}, histItems, histFresh); prices.historyUpdatedAt = new Date().toISOString(); }
prices.historyItems = histItems;
// 무리아스의 유물 — 이름이 모두 같아서 유물 효과(옵션) · 수치별 최저가를 따로 모아요 · relicSample은 옵션 형식 확인용
try {
  const list = await collect('/mabinogi/v1/auction/list', { item_name: '무리아스의 유물' }, Number(prices.relicMaxPages) || 10);
  const relics = {};
  for (const it of list) {
    const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue;
    const all = it.item_option || []; const fx = all.filter((o) => /유물/.test(String(o.option_type || '') + String(o.option_sub_type || '')));
    const key = (fx.length ? fx : all).map((o) => [o.option_sub_type, o.option_value, o.option_value2].filter((v) => v !== undefined && v !== null && v !== '').join(' ')).join(' / ');
    if (!key) continue;
    const c = relics[key];
    if (!c) relics[key] = { min: price, count: 1 }; else { c.min = Math.min(c.min, price); c.count += 1; }
  }
  prices.relics = relics; prices.relicSample = list.slice(0, 3).map((it) => it.item_option || []); prices.relicUpdatedAt = new Date().toISOString();
} catch (e) { errors.push(String(e.message || e)); }
// 무리아스의 유물 거래 내역 — 지금 매물이 없는 효과 · 수치는 최근 거래가로 보여주려고 효과 · 수치별 가장 최근 거래 1건(가격 · 시각)을 모아요 (지난 값에 덮어써요)
try {
  const list = await collect('/mabinogi/v1/auction/history', { item_name: '무리아스의 유물' }, Number(prices.relicHistoryMaxPages) || 10);
  const hist = Object.assign({}, prices.relicHistory || {});
  for (const it of list) {
    const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue;
    const at = it.date_auction_buy || it.date_auction_expire || '';
    const all = it.item_option || []; const fx = all.filter((o) => /유물/.test(String(o.option_type || '') + String(o.option_sub_type || '')));
    const key = (fx.length ? fx : all).map((o) => [o.option_sub_type, o.option_value, o.option_value2].filter((v) => v !== undefined && v !== null && v !== '').join(' ')).join(' / ');
    if (!key) continue;
    const c = hist[key];
    if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) hist[key] = { last: price, at };
  }
  prices.relicHistory = hist; prices.relicHistoryUpdatedAt = new Date().toISOString();
} catch (e) { errors.push(String(e.message || e)); }
// 탈라가흐 인챈트 선택 스크롤 — 신규 인챈트(미련의 · 망집 등)를 골라 받는 스크롤 · 매물(최저가)과 거래 내역(최근 거래가)을 표시 이름 · 옵션별로 모아요 (형식 확인용 샘플 포함)
try {
  const SEL = '탈라 가흐 인챈트 선택 스크롤'; /* 경매장 이름은 '탈라 가흐'로 띄어 써요 */
  const keyOf = (it) => { const opt = (it.item_option || []).map((o) => [o.option_type, o.option_sub_type, o.option_value, o.option_value2].filter((v) => v !== undefined && v !== null && v !== '').join(' ')).join(' / '); return (it.item_display_name || it.item_name || SEL) + (opt ? ' | ' + opt : ''); };
  // 아이템 이름이 정확히 일치해야 해서 키워드 '탈라 가흐'로 찾고, 찾은 이름으로 거래 내역을 받아요
  const kw = await collect('/mabinogi/v1/auction/keyword-search', { keyword: '탈라 가흐' }, 5);
  prices.talagahKeywordNames = [...new Set(kw.map((it) => it.item_name).filter(Boolean))].slice(0, 30);
  const live = kw.filter((it) => /인챈트/.test(String(it.item_name || '') + String(it.item_display_name || '')));
  const sel = {};
  for (const it of live) { const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue; const k = keyOf(it); const c = sel[k]; if (!c) sel[k] = { min: price, count: 1 }; else { c.min = Math.min(c.min, price); c.count += 1; } }
  const selNames = [...new Set(live.map((it) => it.item_name).filter(Boolean))]; if (!selNames.length) selNames.push(SEL);
  const histL = []; for (const nm of selNames) { try { (await collect('/mabinogi/v1/auction/history', { item_name: nm }, 5)).forEach((it) => histL.push(it)); } catch (e) { errors.push(String(e.message || e)); } }
  const selH = Object.assign({}, prices.talagahHistory || {});
  for (const it of histL) { const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue; const at = it.date_auction_buy || it.date_auction_expire || ''; const k = keyOf(it); const c = selH[k]; if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) selH[k] = { last: price, at }; }
  prices.talagah = sel; prices.talagahHistory = selH; prices.talagahNames = selNames; prices.talagahSample = live.concat(histL).slice(0, 3).map((it) => ({ item_name: it.item_name, item_display_name: it.item_display_name, item_option: it.item_option || [] })); prices.talagahUpdatedAt = new Date().toISOString();
} catch (e) { errors.push(String(e.message || e)); }
// 에코스톤 — 색 · 각성 능력 · 각성 레벨에 따라 값이 달라서 '색|각성 능력|레벨'(30등급만)별 최저가를 모아요 · 매물이 없으면 거래 내역의 최근 거래가 (echoHistory)
try {
  const ecKey = (it) => { const op = it.item_option || []; const g = op.filter((o) => o.option_type === '에코스톤 등급')[0]; if (!g || String(g.option_value) !== '30') return ''; const a = op.filter((o) => o.option_type === '에코스톤 각성 능력')[0]; const m = a ? /^(.*?)\s+(\d+)\s*레벨/.exec(String(a.option_value || '')) : null; return m ? it.item_name + '|' + m[1].trim() + '|' + m[2] : ''; };
  const inhOf = (it) => Number(((it.item_option || []).filter((o) => o.option_type === '에코스톤 고유 능력')[0] || {}).option_value) || 0;
  const live = (await collect('/mabinogi/v1/auction/keyword-search', { keyword: '에코스톤' }, Number(prices.echoMaxPages) || 10)).filter((it) => /^(레드|블루|옐로|실버|블랙) 에코스톤$/.test(String(it.item_name || '')));
  const ec = {}; for (const it of live) { const price = Number(it.auction_price_per_unit); const k = ecKey(it); if (!(price > 0) || !k) continue; const c = ec[k]; if (!c) ec[k] = { min: price, count: 1, inh: inhOf(it) }; else { if (price < c.min) { c.min = price; c.inh = inhOf(it); } c.count += 1; } }
  const ecH = Object.assign({}, prices.echoHistory || {});
  for (const nm of [...new Set(live.map((it) => it.item_name))]) { try { for (const it of await collect('/mabinogi/v1/auction/history', { item_name: nm }, 3)) { const price = Number(it.auction_price_per_unit); const k = ecKey(it); if (!(price > 0) || !k) continue; const at = it.date_auction_buy || it.date_auction_expire || ''; const c = ecH[k]; if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) ecH[k] = { last: price, at }; } } catch (e) { errors.push(String(e.message || e)); } }
  prices.echo = ec; prices.echoHistory = ecH; prices.echoUpdatedAt = new Date().toISOString();
  delete prices.echoNames; delete prices.echoSample;
} catch (e) { errors.push(String(e.message || e)); }
// 삼색 보석 반지는 고유 옵션(1~7)마다 값이 크게 달라서 시세를 모으지 않고 직접 입력해요 (지난 수집값은 지워요)
delete prices.ring; delete prices.ringHistory; delete prices.ringSample; delete prices.ringUpdatedAt;
// 요청 제한 등으로 일부만 받았을 때는 이번에 못 받은 아이템의 지난 시세를 그대로 둬요 (빈 값으로 덮어쓰지 않게)
prices.items = errors.length ? Object.assign({}, prices.items || {}, items) : items; prices.updatedAt = new Date().toISOString(); prices.errors = errors;
// 형식 확인용 샘플은 페이지에서 쓰지 않아서 빼고, 사용자가 받는 용량을 줄이려고 공백 없이 저장해요
delete prices.relicSample; delete prices.talagahSample; delete prices.talagahProbe;
await writeFile(FILE, JSON.stringify(prices) + '\n');
console.log(`아이템 ${Object.keys(items).length}개 갱신 · 오류 ${errors.length}건`);
errors.forEach((e) => console.log('  -', e));
if (!Object.keys(items).length && errors.length) process.exit(1);
