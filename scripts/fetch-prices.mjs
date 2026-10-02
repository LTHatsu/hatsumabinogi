import { readFile, writeFile } from 'node:fs/promises';
const API = 'https://open.api.nexon.com';
const KEY = process.env.NEXON_API_KEY;
const FILE = new URL('../prices.json', import.meta.url);
const MAX_PAGES = 5, DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!KEY) { console.error('NEXON_API_KEY 환경 변수가 없어요.'); process.exit(1); }
async function call(path, params) {
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  for (let a = 0; a < 3; a++) {
    const res = await fetch(url, { headers: { 'x-nxopen-api-key': KEY, accept: 'application/json' } });
    if (res.status === 429) { await sleep(1000 * (a + 1)); continue; }
    if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
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
function summarize(list, into) {
  for (const it of list) {
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
// 카테고리 전체(인챈트 스크롤 · 장비) — 호출량이 많아 categoryEveryHours 시간마다만 새로 받고, 그 사이에는 지난 값을 유지해요
const every = Number(prices.categoryEveryHours) || 6;
const catDue = !prices.categoryUpdatedAt || Date.now() - Date.parse(prices.categoryUpdatedAt) >= every * 3600 * 1000 - 10 * 60 * 1000;
let catItems = prices.categoryItems || {};
if (catDue && (prices.categories || []).length) {
  const fresh = {};
  for (const cat of prices.categories) { try { summarize(await collect('/mabinogi/v1/auction/list', { auction_item_category: cat }, Number(prices.categoryMaxPages) || 20), fresh); } catch (e) { errors.push(String(e.message || e)); } }
  if (Object.keys(fresh).length) { catItems = fresh; prices.categoryUpdatedAt = new Date().toISOString(); }
}
prices.categoryItems = catItems;
// 거래 내역 — 지금 매물이 없는 아이템은 최근 거래가로 보여주려고 카테고리별 거래 내역(/auction/history)도 같은 주기로 받아요 · 이름별로 가장 최근 거래 1건(가격 · 시각)
let histItems = prices.historyItems || {};
if (catDue && (prices.categories || []).length) {
  const fresh = {};
  for (const cat of prices.categories) {
    try {
      const list = await collect('/mabinogi/v1/auction/history', { auction_item_category: cat }, Number(prices.historyMaxPages) || 10);
      for (const it of list) {
        const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue;
        const at = it.date_auction_buy || it.date_auction_expire || '';
        for (const name of new Set([it.item_name, it.item_display_name].filter(Boolean))) {
          const c = fresh[name];
          if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) fresh[name] = { last: price, at };
        }
      }
    } catch (e) { errors.push(String(e.message || e)); }
  }
  if (Object.keys(fresh).length) { histItems = Object.assign({}, histItems, fresh); prices.historyUpdatedAt = new Date().toISOString(); }
}
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
// 에코스톤 — 색 · 등급 · 각성 능력에 따라 값이 달라서 매물을 옵션별로 모아요 (형식 확인용 샘플 포함) · 매물이 없으면 거래 내역의 최근 거래가
try {
  const optKey = (it) => (it.item_option || []).map((o) => [o.option_type, o.option_sub_type, o.option_value, o.option_value2].filter((v) => v !== undefined && v !== null && v !== '').join(' ')).join(' / ');
  const live = (await collect('/mabinogi/v1/auction/keyword-search', { keyword: '에코스톤' }, Number(prices.echoMaxPages) || 10)).filter((it) => /에코스톤/.test(String(it.item_name || '')));
  const ec = {}; for (const it of live) { const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue; const k = it.item_name + ' | ' + optKey(it); const c = ec[k]; if (!c) ec[k] = { min: price, count: 1 }; else { c.min = Math.min(c.min, price); c.count += 1; } }
  const names = [...new Set(live.map((it) => it.item_name))];
  const ecH = Object.assign({}, prices.echoHistory || {});
  for (const nm of names) { try { for (const it of await collect('/mabinogi/v1/auction/history', { item_name: nm }, 3)) { const price = Number(it.auction_price_per_unit); if (!(price > 0)) continue; const at = it.date_auction_buy || it.date_auction_expire || ''; const k = it.item_name + ' | ' + optKey(it); const c = ecH[k]; if (!c || (at && (!c.at || Date.parse(at) > Date.parse(c.at)))) ecH[k] = { last: price, at }; } } catch (e) { errors.push(String(e.message || e)); } }
  prices.echo = ec; prices.echoHistory = ecH; prices.echoNames = names; prices.echoSample = live.slice(0, 3).map((it) => ({ item_name: it.item_name, item_display_name: it.item_display_name, item_option: it.item_option || [] })); prices.echoUpdatedAt = new Date().toISOString();
} catch (e) { errors.push(String(e.message || e)); }
prices.items = items; prices.updatedAt = new Date().toISOString(); prices.errors = errors;
await writeFile(FILE, JSON.stringify(prices, null, 2) + '\n');
console.log(`아이템 ${Object.keys(items).length}개 갱신 · 오류 ${errors.length}건`);
errors.forEach((e) => console.log('  -', e));
if (!Object.keys(items).length && errors.length) process.exit(1);
