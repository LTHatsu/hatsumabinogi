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
    (d.auction_item || []).forEach((it) => items.push(it));
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
prices.items = items; prices.updatedAt = new Date().toISOString(); prices.errors = errors;
await writeFile(FILE, JSON.stringify(prices, null, 2) + '\n');
console.log(`아이템 ${Object.keys(items).length}개 갱신 · 오류 ${errors.length}건`);
errors.forEach((e) => console.log('  -', e));
if (!Object.keys(items).length && errors.length) process.exit(1);
