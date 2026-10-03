// «Замер Про» — главный модуль: папки, данные заказа, фото и планы, редактор, отправка, резервная копия
import * as db from './db.js';
import { Editor, COLORS, uid, makeGrid, renderAnnotated, arrowLabel } from './editor.js';
import { buildPdf } from './pdf.js';

const $ = (s) => document.querySelector(s);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
const PLAN_GRID = { cols: 30, rows: 21, step: 80 };
const PHOTO_MAX = 3200; // длинная сторона фото после уменьшения
const THUMB_MAX = 360;

// ---------- Настройки: последний цвет, единицы, толщина ----------

const prefs = { color: COLORS[0].hex, unit: 'mm', width: 1 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('prefs') || '{}')); } catch { /* нет доступа */ }
function savePrefs() {
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch { /* нет доступа */ }
}

// ---------- Мелкие помощники ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function busy(on, text = 'Готовлю…') {
  $('#busy-text').textContent = text;
  $('#busy').classList.toggle('hidden', !on);
}

const fmtDate = (t) => new Date(t).toLocaleDateString('ru-RU');
const isoToRu = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : s || '');
const todayIso = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Замер';

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return `${n} ${one}`;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const toBlob = (cv, type = 'image/jpeg', q = 0.9) =>
  new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Не хватило памяти'))), type, q));

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
    img.src = url;
  });
}

function makeCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

function thumbOf(src) {
  const w = src.width, h = src.height;
  const f = Math.min(1, THUMB_MAX / Math.max(w, h));
  const cv = makeCanvas(Math.round(w * f), Math.round(h * f));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.75);
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

async function dataURLToBlob(url) {
  const [head, body] = url.split(',');
  const type = head.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ---------- Меню действий и формы ----------

const sheetEl = $('#sheet');
const sheetPanel = $('#sheet-panel');
let sheetResolve = null;

function closeSheet() {
  sheetEl.classList.add('hidden');
  sheetPanel.innerHTML = '';
  if (sheetResolve) { sheetResolve(null); sheetResolve = null; }
}
sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl || e.target === sheetPanel) closeSheet();
});

// actions: [{ label, run, danger }]. run вызывается сразу в обработчике нажатия —
// это важно для iPhone (выбор файла и «Поделиться» работают только по нажатию).
function menu(title, actions) {
  closeSheet();
  const g = el('div', 'sheet-group');
  if (title) g.append(el('div', 'sheet-title', title));
  for (const a of actions) {
    const b = el('button', 'sheet-btn' + (a.danger ? ' danger' : ''), a.label);
    b.onclick = () => { closeSheet(); a.run(); };
    g.append(b);
  }
  const cg = el('div', 'sheet-group');
  const cb = el('button', 'sheet-btn cancel', 'Отмена');
  cb.onclick = closeSheet;
  cg.append(cb);
  sheetPanel.append(g, cg);
  sheetEl.classList.remove('hidden');
}

// fields: [{ key, label, type: 'text'|'tel'|'date'|'textarea', value, placeholder }]
function form(title, fields, okLabel = 'Сохранить') {
  closeSheet();
  return new Promise((resolve) => {
    sheetResolve = resolve;
    const g = el('div', 'sheet-group');
    const f = el('form', 'form');
    f.append(el('h3', null, title));
    const inputs = {};
    for (const fd of fields) {
      const lab = el('label', null, fd.label);
      const inp = fd.type === 'textarea' ? el('textarea') : el('input');
      if (fd.type !== 'textarea') inp.type = fd.type || 'text';
      if (fd.type === 'tel') inp.inputMode = 'tel';
      inp.value = fd.value || '';
      if (fd.placeholder) inp.placeholder = fd.placeholder;
      inp.autocomplete = 'off';
      inputs[fd.key] = inp;
      lab.append(inp);
      f.append(lab);
    }
    const btns = el('div', 'btns');
    const cancel = el('button', 'btn', 'Отмена');
    cancel.type = 'button';
    cancel.onclick = closeSheet;
    const ok = el('button', 'btn primary', okLabel);
    ok.type = 'submit';
    btns.append(cancel, ok);
    f.append(btns);
    f.onsubmit = (e) => {
      e.preventDefault();
      const out = {};
      for (const k in inputs) out[k] = inputs[k].value.trim();
      sheetResolve = null;
      closeSheet();
      resolve(out);
    };
    g.append(f);
    sheetPanel.append(g);
    sheetEl.classList.remove('hidden');
    if (!isIOS) setTimeout(() => inputs[fields[0].key]?.focus(), 50);
  });
}

async function askName(title, value) {
  const r = await form(title, [{ key: 'name', label: 'Название', value }]);
  return r && r.name ? r.name : null;
}

// ---------- Навигация (кнопка «Назад» на Android ходит по папкам) ----------

let cur = null; // открытая папка (null — корень «Заказы»)
let editItem = null; // открытое фото/план
let selectMode = false; // режим «Правка»
const selected = new Set();

function showScreen(name) {
  $('#screen-folder').classList.toggle('active', name === 'folder');
  $('#screen-editor').classList.toggle('active', name === 'editor');
}

function goFolder(id) {
  exitSelect();
  history.pushState({ f: id }, '');
  cur = id;
  renderFolder();
}

function openEditor(id) {
  history.pushState({ f: cur, e: id }, '');
  openEditorScreen(id);
}

window.addEventListener('popstate', async (e) => {
  const st = e.state || { f: null };
  closeSheet();
  closeFab();
  exitSelect();
  if (editItem && !st.e) await closeEditor();
  cur = st.f ?? null;
  if (st.e) openEditorScreen(st.e);
  else renderFolder();
});

$('#btn-up').onclick = () => history.back();
$('#btn-back').onclick = () => history.back();

// ---------- Экран папки: плитки в 2 колонки ----------

const hasOrder = (o) => !!(o && (o.client || o.phone || o.address || o.date || o.note));
const fmtDateTime = (t) => new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const HOME_SVG = '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/></svg>';

function folderStats(id, all) {
  const kids = all.filter((i) => i.parentId === id);
  const parts = [];
  const ph = kids.filter((i) => i.kind === 'photo').length;
  const pl = kids.filter((i) => i.kind === 'plan').length;
  const fo = kids.filter((i) => i.kind === 'folder').length;
  if (ph) parts.push(`${ph} фото`);
  if (pl) parts.push(plural(pl, 'план', 'плана', 'планов'));
  if (fo) parts.push(plural(fo, 'папка', 'папки', 'папок'));
  return parts.join(' · ') || 'пусто';
}

// Цепочка папок от корня до id
function pathTo(id, all) {
  const out = [];
  let f = id ? all.find((i) => i.id === id) : null;
  while (f) {
    out.unshift(f);
    f = f.parentId ? all.find((i) => i.id === f.parentId) : null;
  }
  return out;
}

async function renderFolder() {
  showScreen('folder');
  closeFab();
  const all = await db.allItems();
  let folder = cur ? all.find((i) => i.id === cur) : null;
  if (cur && !folder) { cur = null; folder = null; }

  $('#folder-title').textContent = folder ? folder.name : 'Заказы';
  $('#btn-up').classList.toggle('hidden', !folder);
  $('#btn-edit').textContent = selectMode ? 'Готово' : 'Правка';
  $('#screen-folder').classList.toggle('selecting', selectMode);

  // Данные заказа
  const oc = $('#order-card');
  oc.innerHTML = '';
  if (folder) {
    if (hasOrder(folder.order)) oc.append(orderCard(folder));
    else if (!folder.parentId) {
      const b = el('button', 'order-add', '＋ Данные заказа: клиент, телефон, адрес');
      b.onclick = () => editOrder(folder);
      oc.append(b);
    }
  }

  // Путь внизу: 🏠 › Заказ › Кухня
  const cr = $('#crumbs');
  cr.innerHTML = '';
  const home = el('button', 'crumb home' + (cur ? '' : ' cur'));
  home.innerHTML = HOME_SVG;
  home.setAttribute('aria-label', 'Заказы');
  home.onclick = () => { if (cur) goFolder(null); };
  cr.append(home);
  for (const f of pathTo(cur, all)) {
    cr.append(el('span', 'sep', '›'));
    const b = el('button', 'crumb' + (f.id === cur ? ' cur' : ''), f.name);
    b.onclick = () => { if (f.id !== cur) goFolder(f.id); };
    cr.append(b);
  }
  cr.scrollLeft = cr.scrollWidth;

  const kids = all.filter((i) => (i.parentId ?? null) === cur);
  const folders = kids.filter((i) => i.kind === 'folder')
    .sort((a, b) => (cur ? a.created - b.created : b.created - a.created));
  const media = kids.filter((i) => i.kind !== 'folder').sort((a, b) => a.created - b.created);

  const grid = $('#grid');
  grid.innerHTML = '';
  for (const f of folders) grid.append(folderTile(f, all));
  for (const it of media) grid.append(mediaTile(it));

  $('#empty').classList.toggle('hidden', kids.length > 0);
  $('#empty-text').textContent = cur
    ? 'Пусто. Нажмите «+» внизу: снимок, фото из галереи, папка или план.'
    : 'Здесь будут папки заказов. Нажмите «+» внизу → «Создать папку».';
  updateSelbar();
}

function tileBase(it, open) {
  const t = el('div', 'tile' + (selected.has(it.id) ? ' sel' : ''));
  t.onclick = () => {
    if (!selectMode) return open();
    if (selected.has(it.id)) selected.delete(it.id);
    else selected.add(it.id);
    t.classList.toggle('sel', selected.has(it.id));
    updateSelbar();
  };
  return t;
}

function tileExtras(pv, onMore) {
  const m = el('button', 'more', '⋯');
  m.setAttribute('aria-label', 'Действия');
  m.onclick = (e) => { e.stopPropagation(); onMore(); };
  pv.append(m, el('span', 'check', '✓'));
}

function folderTile(f, all) {
  const t = tileBase(f, () => goFolder(f.id));
  const pv = el('div', 'pv folder-pv');
  const thumbs = all.filter((i) => i.parentId === f.id && i.thumb).sort((a, b) => a.created - b.created).slice(0, 4);
  if (thumbs.length) {
    pv.classList.add('n' + thumbs.length);
    for (const i of thumbs) {
      const im = el('img');
      im.src = i.thumb;
      im.alt = '';
      pv.append(im);
    }
    pv.append(el('span', 'fold-tag', '📁'));
  } else {
    pv.append(el('span', 'fold-ico', '📁'));
  }
  tileExtras(pv, () => folderMenu(f));
  const o = f.order || {};
  t.append(pv, el('div', 'tname', f.name),
    el('div', 'tsub', [o.address || o.client, folderStats(f.id, all)].filter(Boolean).join(' · ')));
  return t;
}

function mediaTile(it) {
  const t = tileBase(it, () => openEditor(it.id));
  const pv = el('div', 'pv');
  if (it.thumb) {
    const im = el('img');
    im.src = it.thumb;
    im.alt = '';
    pv.append(im);
  }
  tileExtras(pv, () => itemMenu(it));
  t.append(pv, el('div', 'tname', it.name),
    el('div', 'tsub', (it.kind === 'plan' ? 'План · ' : '') + fmtDateTime(it.updated || it.created)));
  return t;
}

function orderCard(folder) {
  const o = folder.order;
  const box = el('div', 'order');
  const head = el('div', 'head', 'Данные заказа');
  const edit = el('button', null, 'Изменить');
  edit.onclick = () => editOrder(folder);
  head.append(edit);
  box.append(head);
  if (o.client) box.append(el('div', 'l', '👤 ' + o.client));
  if (o.phone) {
    const l = el('div', 'l', '📞 ');
    const a = el('a', null, o.phone);
    a.href = 'tel:' + o.phone.replace(/[^\d+]/g, '');
    l.append(a);
    box.append(l);
  }
  if (o.address) box.append(el('div', 'l', '📍 ' + o.address));
  if (o.date) box.append(el('div', 'l', '📅 ' + isoToRu(o.date)));
  if (o.note) box.append(el('div', 'l', '💬 ' + o.note));
  return box;
}

const ORDER_FIELDS = (o = {}) => [
  { key: 'client', label: 'Клиент', value: o.client, placeholder: 'Иванов Иван' },
  { key: 'phone', label: 'Телефон', type: 'tel', value: o.phone, placeholder: '+7 …' },
  { key: 'address', label: 'Адрес', value: o.address, placeholder: 'Улица, дом, квартира' },
  { key: 'date', label: 'Дата замера', type: 'date', value: o.date || todayIso() },
  { key: 'note', label: 'Комментарий', type: 'textarea', value: o.note },
];

async function editOrder(folder) {
  const r = await form('Данные заказа', ORDER_FIELDS(folder.order));
  if (!r) return;
  folder.order = r;
  folder.updated = Date.now();
  await db.putItem(folder);
  renderFolder();
}

// ---------- Круглая «+»: снимок, галерея, папка, план ----------

function closeFab() {
  $('#fab-menu').classList.add('hidden');
  $('#fab-dim').classList.add('hidden');
  $('#fab').classList.remove('open');
}

$('#fab').onclick = () => {
  const open = $('#fab-menu').classList.contains('hidden');
  $('#fab-menu').classList.toggle('hidden', !open);
  $('#fab-dim').classList.toggle('hidden', !open);
  $('#fab').classList.toggle('open', open);
};
$('#fab-dim').onclick = closeFab;

document.querySelectorAll('.fab-item').forEach((b) => {
  b.onclick = () => {
    closeFab();
    const act = b.dataset.act;
    // Выбор файла открываем сразу в обработчике нажатия — иначе iPhone не покажет камеру
    if (act === 'camera') $('#file-camera').click();
    else if (act === 'gallery') $('#file-photo').click();
    else if (act === 'folder') newFolder();
    else if (act === 'plan') newPlan();
  };
});

// Новая папка: в корне — сразу с данными заказа
async function newFolder() {
  let r;
  if (!cur) {
    r = await form('Новый заказ', [
      { key: 'name', label: 'Название папки', placeholder: 'Кухня — Иванов' },
      ...ORDER_FIELDS(),
    ], 'Создать');
  } else {
    r = await form('Новая папка', [{ key: 'name', label: 'Название', placeholder: 'Кухня, прихожая…' }], 'Создать');
  }
  if (!r) return;
  const now = Date.now();
  const { name, ...order } = r;
  const f = {
    id: uid(), kind: 'folder', parentId: cur, created: now, updated: now,
    name: name || order.client || (cur ? 'Папка' : 'Заказ ' + fmtDate(now)),
  };
  if (!cur) f.order = order;
  await db.putItem(f);
  goFolder(f.id);
}

// Наибольший номер среди «Фото N» / «План N» в папке — чтобы после удалений имена не повторялись
async function lastNumber(prefix, kind) {
  let max = 0;
  for (const i of await db.children(cur)) {
    const m = i.kind === kind && i.name.match(new RegExp(`^${prefix} (\\d+)$`));
    if (m) max = Math.max(max, +m[1]);
  }
  return max;
}

async function nextName(prefix, kind) {
  return `${prefix} ${(await lastNumber(prefix, kind)) + 1}`;
}

async function newPlan() {
  const now = Date.now();
  const grid = { ...PLAN_GRID };
  const it = {
    id: uid(), kind: 'plan', parentId: cur, name: await nextName('План', 'plan'),
    created: now, updated: now, grid, shapes: [],
    thumb: thumbOf(makeGrid(grid.cols, grid.rows, grid.step)),
  };
  await db.putItem(it);
  openEditor(it.id);
}

async function handlePhotos(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const start = await lastNumber('Фото', 'photo');
  let last = null, failed = 0;
  for (let i = 0; i < files.length; i++) {
    busy(true, files.length > 1 ? `Добавляю фото ${i + 1} из ${files.length}…` : 'Добавляю фото…');
    try {
      last = await importPhoto(files[i], `Фото ${start + i + 1}`);
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  busy(false);
  if (failed) toast(`Не удалось открыть: ${failed}`);
  if (files.length === 1 && last) openEditor(last.id);
  else renderFolder();
}
$('#file-camera').onchange = handlePhotos;
$('#file-photo').onchange = handlePhotos;

async function importPhoto(file, name) {
  const img = await loadImage(file);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const f = Math.min(1, PHOTO_MAX / Math.max(iw, ih));
  const cv = makeCanvas(Math.round(iw * f), Math.round(ih * f));
  const c = cv.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await toBlob(cv, 'image/jpeg', 0.9);
  const now = Date.now();
  const it = {
    id: uid(), kind: 'photo', parentId: cur, name, created: now, updated: now,
    w: cv.width, h: cv.height, thumb: thumbOf(cv), shapes: [],
  };
  cv.width = cv.height = 0; // освобождаем память (важно на iPhone)
  await db.putImage(it.id, blob);
  await db.putItem(it);
  return it;
}

// ---------- Режим «Правка»: выбрать несколько и отправить / перенести / удалить ----------

function exitSelect() {
  selectMode = false;
  selected.clear();
}

$('#btn-edit').onclick = () => {
  if (selectMode) exitSelect();
  else { selectMode = true; selected.clear(); }
  renderFolder();
};

function updateSelbar() {
  $('#selbar').classList.toggle('hidden', !selectMode);
  $('#fab').classList.toggle('hidden', selectMode);
  $('#sel-count').textContent = selected.size ? `Выбрано: ${selected.size}` : 'Выберите плитки';
}

async function selectedItems() {
  const all = await db.allItems();
  return all.filter((i) => selected.has(i.id));
}

$('#sel-share').onclick = async () => {
  const items = await selectedItems();
  if (!items.length) return toast('Сначала выберите фото или папки');
  const list = [];
  for (const it of items) {
    if (it.kind === 'folder') list.push(...(await collectMedia(it.id)).map((m) => ({ ...m, label: it.name + ' / ' + m.label })));
    else list.push({ it, label: it.name });
  }
  if (!list.length) return toast('В выбранном нет фото');
  const folder = cur ? await db.getItem(cur) : null;
  const base = folder ? folder.name : 'Замер';
  menu(`Отправить выбранное (${list.length})`, [
    { label: 'Один PDF', run: () => exportItems(list, 'pdf', base, folder && hasOrder(folder.order) ? folder : null) },
    { label: 'Картинки JPEG', run: () => exportItems(list, 'jpeg', base) },
  ]);
};

$('#sel-delete').onclick = async () => {
  const items = await selectedItems();
  if (!items.length) return toast('Сначала выберите фото или папки');
  if (!confirm(`Удалить выбранное (${items.length})? Папки удаляются со всем содержимым.`)) return;
  for (const it of items) await db.deleteItem(it.id);
  exitSelect();
  toast('Удалено');
  renderFolder();
};

$('#sel-move').onclick = async () => {
  const items = await selectedItems();
  if (!items.length) return toast('Сначала выберите фото или папки');
  const all = await db.allItems();
  // Нельзя перенести папку в саму себя или внутрь себя
  const inside = (id) => pathTo(id, all).some((f) => selected.has(f.id));
  const targets = all.filter((i) => i.kind === 'folder' && !inside(i.id) && i.id !== cur);
  const acts = [];
  if (cur) acts.push({ label: '🏠 Заказы (главная)', run: () => moveTo(items, null) });
  for (const f of targets) {
    acts.push({ label: '📁 ' + pathTo(f.id, all).map((x) => x.name).join(' › '), run: () => moveTo(items, f.id) });
  }
  if (!acts.length) return toast('Некуда переносить — создайте папку');
  menu('Переместить в…', acts);
};

async function moveTo(items, parentId) {
  for (const it of items) {
    it.parentId = parentId;
    it.updated = Date.now();
    await db.putItem(it);
  }
  exitSelect();
  toast('Перенесено');
  renderFolder();
}

// ---------- Меню папок и элементов ----------

function folderMenu(f) {
  menu(f.name, [
    { label: 'Данные заказа', run: () => editOrder(f) },
    { label: 'Отправить папку', run: () => shareFolderMenu(f) },
    { label: 'Переименовать', run: () => renameItem(f) },
    { label: 'Удалить папку', danger: true, run: () => deleteItem(f) },
  ]);
}

function itemMenu(it) {
  menu(it.name, [
    { label: 'Открыть', run: () => openEditor(it.id) },
    { label: 'Отправить', run: () => shareItemMenu(it) },
    { label: 'Переименовать', run: () => renameItem(it) },
    { label: 'Удалить', danger: true, run: () => deleteItem(it) },
  ]);
}

async function renameItem(it) {
  const name = await askName('Переименовать', it.name);
  if (!name) return;
  it.name = name;
  it.updated = Date.now();
  await db.putItem(it);
  if (editItem && editItem.id === it.id) {
    editItem.name = name;
    $('#photo-title').textContent = name;
  } else renderFolder();
}

async function deleteItem(it) {
  const what = it.kind === 'folder' ? `папку «${it.name}» со всем содержимым` : `«${it.name}»`;
  if (!confirm(`Удалить ${what}?`)) return;
  await db.deleteItem(it.id);
  toast('Удалено');
  if (it.id === cur) history.back();
  else renderFolder();
}

// Меню «⋯» в шапке
$('#btn-menu').onclick = async () => {
  const folder = cur ? await db.getItem(cur) : null;
  const acts = [];
  if (folder) {
    acts.push(
      { label: 'Данные заказа', run: () => editOrder(folder) },
      { label: 'Отправить папку', run: () => shareFolderMenu(folder) },
      { label: 'Переименовать папку', run: () => renameItem(folder) },
    );
  }
  acts.push(
    { label: 'Резервная копия всех данных', run: () => exportBackup(null) },
    { label: 'Открыть файл копии / папки', run: () => $('#file-import').click() },
    { label: 'Как установить на телефон', run: showInstallHelp },
  );
  if (folder) acts.push({ label: 'Удалить папку', danger: true, run: () => deleteItem(folder) });
  menu(folder ? folder.name : 'Замер Про', acts);
};

// ---------- Редактор ----------

const HINTS = {
  arrow: 'Проведите пальцем — стрелка',
  line: 'Проведите пальцем — линия',
  pen: 'Рисуйте пальцем',
  text: 'Коснитесь места для заметки',
};

let hintTimer;
function showHint(text) {
  const h = $('#hint');
  h.textContent = text;
  h.classList.remove('off');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.add('off'), 2500);
}

const editor = new Editor($('#cv'), {
  onChange: () => { scheduleSave(); updateUndo(); },
  onSelect: renderInspector,
  // После стрелки клавиатура НЕ открывается — сначала можно поправить концы.
  // Размер: касание «?» на стрелке или кнопки «Ввести размер» внизу.
  onCreated: (s) => { if (s.type === 'text') focusText(); },
  onShapeTap: (s) => {
    if (s.type === 'arrow') openKeypad(s);
    else if (s.type === 'text') { closeStyle(); focusText(); } // панель заметки могла быть скрыта окном цвета
  },
  onTool: (t) => {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    const plan = editItem?.kind === 'plan' && t !== 'pen' && t !== 'text';
    showHint(HINTS[t] + (plan ? ' · по клеткам' : '') + ' · ещё раз — цвет');
  },
  onLockedTap: () => nudgeLock(),
  getDefaults: () => prefs,
});

document.querySelectorAll('[data-tool]').forEach((b) => {
  b.onclick = () => {
    if (editor.locked) return nudgeLock();
    // Повторное касание уже выбранного инструмента — открыть/закрыть выбор цвета
    if (editor.tool === b.dataset.tool && !editor.selected()) return toggleStyle();
    closeStyle();
    editor.select(null);
    editor.setTool(b.dataset.tool);
  };
});
$('#btn-undo').onclick = () => (editor.locked ? nudgeLock() : editor.undo());
$('#btn-redo').onclick = () => (editor.locked ? nudgeLock() : editor.redo());
$('#btn-lock').onclick = () => setLock(!editor.locked);
function toggleStyle() {
  if ($('#stylebox').classList.contains('hidden')) openStyle();
  else closeStyle();
}
$('#photo-title').onclick = () => editItem && renameItem(editItem);
$('#btn-share').onclick = async () => {
  if (!editItem) return;
  editor.select(null);
  await saveNow();
  shareItemMenu(editItem);
};

function updateUndo() {
  $('#btn-undo').disabled = !editor.undoStack?.length;
  $('#btn-redo').disabled = !editor.redoStack?.length;
}

// Замок: при повторном открытии фото с замерами — включён, чтобы ничего не удалить случайно
function setLock(on, quiet = false) {
  editor.setLocked(on);
  if (on) closeStyleOnly(); // окно цвета при замке не нужно
  const b = $('#btn-lock');
  b.classList.toggle('on', on);
  $('#lock-text').textContent = on ? 'Заблокировано' : '';
  $('#lock-shackle').setAttribute('d', on ? 'M8 11V7a4 4 0 018 0v4' : 'M8 11V7a4 4 0 018 0');
  document.querySelectorAll('[data-tool]').forEach((t) => t.classList.toggle('off', on));
  if (!quiet) showHint(on ? 'Нажмите на замок, чтобы править' : 'Можно править');
}

// Попытка править при закрытом замке — подсветить замок
function nudgeLock() {
  const b = $('#btn-lock');
  b.classList.remove('nudge');
  void b.offsetWidth; // перезапуск анимации
  b.classList.add('nudge');
  showHint('Нажмите на замок, чтобы править');
}

async function openEditorScreen(id) {
  const it = await db.getItem(id);
  if (!it) { renderFolder(); return; }
  let img, snap = 0;
  try {
    if (it.kind === 'plan') {
      const g = it.grid || PLAN_GRID;
      img = makeGrid(g.cols, g.rows, g.step);
      snap = g.step;
    } else {
      img = await loadImage(await db.getImage(id));
    }
  } catch (err) {
    console.error(err);
    toast('Не удалось открыть');
    return;
  }
  editItem = it;
  cur = it.parentId ?? null;
  $('#photo-title').textContent = it.name;
  showScreen('editor');
  closeKeypad();
  closeStyleOnly();
  // Фото вписывается между полупрозрачными панелями, но может уходить под них
  editor.insets = { top: $('#ebar').offsetHeight, bottom: $('#toolbar').offsetHeight };
  editor.open(it, img, snap);
  const locked = (it.shapes || []).length > 0;
  setLock(locked, true);
  if (locked) showHint('Есть замеры — нажмите на замок, чтобы править');
  updateUndo();
  renderStyle();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// Телефон может выгрузить страницу — сохраняем разметку сразу при сворачивании
document.addEventListener('visibilitychange', () => { if (document.hidden && editItem) saveNow(); });
window.addEventListener('pagehide', () => { if (editItem) saveNow(); });

async function saveNow() {
  clearTimeout(saveTimer);
  if (!editItem) return;
  editItem.updated = Date.now();
  await db.putItem(editItem);
}

async function closeEditor() {
  if (!editItem) return;
  editor.select(null);
  closeKeypad();
  try { editItem.thumb = editor.renderImage(THUMB_MAX).toDataURL('image/jpeg', 0.75); } catch { /* превью не критично */ }
  await saveNow();
  editItem = null;
}

// Сегментный переключатель: options [[значение, подпись или узел]]
function seg(options, value, onPick) {
  const box = el('div', 'seg');
  for (const [v, label] of options) {
    const b = el('button', v === value ? 'on' : null);
    if (typeof label === 'string') b.textContent = label;
    else b.append(label);
    b.onclick = () => onPick(v);
    box.append(b);
  }
  return box;
}

function thickIcon(px) {
  const i = el('i', 'th');
  i.style.height = px + 'px';
  return i;
}

// ----- Цвет и толщина: кнопка внизу, выбор во всплывающей панели -----

function renderStyle() {
  const sel = editor.selected?.();
  document.querySelectorAll('.tdot').forEach((d) => { d.style.background = prefs.color; });
  const box = $('#stylebox');
  if (box.classList.contains('hidden')) return;
  box.innerHTML = '';
  const active = sel ? sel.color : prefs.color;
  const sw = el('div', 'swatches');
  for (const c of COLORS) {
    const b = el('button', 'sw' + (c.hex === active ? ' on' : ''));
    b.style.background = c.hex;
    b.setAttribute('aria-label', c.name);
    b.onclick = () => {
      prefs.color = c.hex;
      savePrefs();
      const s = editor.selected();
      if (s) {
        editor.snapshot();
        s.color = c.hex;
        editor.changed();
      }
      closeStyle();
    };
    sw.append(b);
  }
  const width = sel && sel.type !== 'text' ? sel.w || 1 : prefs.width;
  const ws = seg([[1, thickIcon(1.5)], [2, thickIcon(3)], [3, thickIcon(5)]], width, (w) => {
    prefs.width = w;
    savePrefs();
    const s = editor.selected();
    if (s && s.type !== 'text') {
      editor.snapshot();
      s.w = w;
      editor.changed();
    }
    renderStyle();
  });
  box.append(sw, ws);
}

function openStyle() {
  closeKeypad();
  $('#stylebox').classList.remove('hidden');
  $('#inspector').classList.add('hidden');
  renderStyle();
}

function closeStyleOnly() {
  $('#stylebox').classList.add('hidden');
}

function closeStyle() {
  closeStyleOnly();
  const s = editor.selected?.();
  if (s && !kpShape) renderInspector(s); // обновить кружок цвета у фигуры
  else renderStyle();
}

// ----- Панель выделенной фигуры (одна строка) -----

function actionButtons() {
  const s = editor.selected();
  const color = el('button', 'ibtn');
  color.setAttribute('aria-label', 'Цвет');
  const dot = el('span', 'cdot');
  dot.style.background = s ? s.color : prefs.color;
  color.append(dot);
  color.onclick = () => toggleStyle();
  const del = el('button', 'ibtn del', '🗑');
  del.setAttribute('aria-label', 'Удалить');
  del.onclick = () => editor.deleteSelected();
  const done = el('button', 'ibtn ok', '✓');
  done.setAttribute('aria-label', 'Готово');
  done.onclick = () => editor.select(null);
  return [color, del, done];
}

function focusText() {
  const i = $('#inspector input');
  if (i) i.focus();
}

function textInput(s) {
  const inp = el('input');
  inp.type = 'text';
  inp.autocomplete = 'off';
  inp.enterKeyHint = 'done';
  inp.placeholder = 'Текст заметки';
  inp.value = s.text || '';
  let snapped = false;
  inp.addEventListener('input', () => {
    if (!snapped) { editor.snapshot(); snapped = true; }
    s.text = inp.value;
    editor.changed();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') editor.select(null); });
  return inp;
}

function renderInspector(s) {
  renderStyle();
  const box = $('#inspector');
  box.innerHTML = '';
  if (!s) {
    box.classList.add('hidden');
    closeKeypad();
    document.activeElement?.blur?.();
    return;
  }
  if (kpShape && kpShape.id !== s.id) closeKeypad();
  if (kpShape) { kpShape = s; kpSnapped = false; renderKeypad(); return; } // после отмены/возврата — новый шаг отмены
  closeStyleOnly();
  box.classList.remove('hidden');
  const r = el('div', 'row');
  if (s.type === 'arrow') {
    const has = s.value != null && s.value !== '';
    const vb = el('button', 'valbtn' + (has ? '' : ' empty'), has ? arrowLabel(s) : 'Ввести размер');
    vb.onclick = () => openKeypad(s);
    r.append(vb, ...actionButtons());
  } else if (s.type === 'pen') {
    r.append(el('span', 'spacer'), ...actionButtons());
  } else if (s.type === 'text') {
    r.append(textInput(s), ...actionButtons());
  }
  box.append(r);
}

// ----- Своя цифровая клавиатура: экран не прыгает, системная клавиатура не нужна -----

let kpShape = null;
let kpSnapped = false;

function openKeypad(s) {
  document.activeElement?.blur?.();
  closeStyleOnly();
  kpShape = s;
  kpSnapped = false;
  $('#inspector').classList.add('hidden');
  $('#keypad').classList.remove('hidden');
  renderKeypad();
  editor.ensureVisible(s, $('#keypad').offsetHeight);
}

function closeKeypad() {
  const s = kpShape;
  kpShape = null;
  $('#keypad').classList.add('hidden');
  // Недописанная запятая («245,») при закрытии убирается
  const live = s && editor.p && editor.shapes.find((x) => x.id === s.id);
  if (live && typeof live.value === 'string' && live.value.endsWith(',')) {
    live.value = live.value.slice(0, -1);
    editor.changed();
  }
}

function kpChange(fn) {
  if (!kpSnapped) { editor.snapshot(); kpSnapped = true; }
  fn(kpShape);
  editor.changed();
  renderKeypad();
}

function renderKeypad() {
  const s = kpShape;
  if (!s) return;
  const kp = $('#keypad');
  kp.innerHTML = '';
  const has = s.value != null && s.value !== '';

  const r1 = el('div', 'row');
  const disp = el('div', 'kp-display' + (has ? '' : ' empty'), has ? String(s.value) : 'размер');
  const units = seg([['mm', 'мм'], ['cm', 'см']], s.unit, (u) => {
    prefs.unit = u;
    savePrefs();
    kpChange((x) => { x.unit = u; });
  });
  const done = el('button', 'kp-done', 'Готово');
  done.onclick = () => editor.select(null);
  r1.append(disp, units, done);

  const r2 = el('div', 'row');
  const heads = seg([[2, '↔'], [1, '→'], [0, '—']], s.heads, (h) => kpChange((x) => { x.heads = h; }));
  const del = el('button', 'ibtn del', '🗑');
  del.setAttribute('aria-label', 'Удалить');
  del.onclick = () => editor.deleteSelected();
  r2.append(heads, el('span', 'spacer'), del);

  const keys = el('div', 'kp-keys');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫']) {
    const b = el('button', 'key' + (k === ',' || k === '⌫' ? ' fn' : ''), k);
    if (k === ',' && s.unit !== 'cm') b.disabled = true;
    b.onclick = () => pressKey(k);
    keys.append(b);
  }
  kp.append(r1, r2, keys);
}

function pressKey(k) {
  kpChange((s) => {
    let v = String(s.value ?? '');
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === ',') { if (s.unit === 'cm' && !v.includes(',')) v = (v || '0') + ','; }
    else if (v.replace(',', '').length < 7) v = (v === '0' ? '' : v) + k;
    s.value = v;
  });
}

// Экранная клавиатура iPhone (для заметок) не сжимает страницу — поднимаем панель над ней
if (window.visualViewport) {
  const vv = window.visualViewport;
  const upd = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb + 'px');
  };
  vv.addEventListener('resize', upd);
  vv.addEventListener('scroll', upd);
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (!document.activeElement || document.activeElement === document.body) window.scrollTo(0, 0);
}, 50));

// ---------- Отправка: JPEG / PDF через меню «Поделиться» ----------

async function renderItemCanvas(it, maxSide) {
  let img;
  if (it.kind === 'plan') {
    const g = it.grid || PLAN_GRID;
    img = makeGrid(g.cols, g.rows, g.step);
  } else {
    img = await loadImage(await db.getImage(it.id));
  }
  return renderAnnotated(img, it.shapes || [], maxSide);
}

// Подпись над картинкой на странице PDF
function withCaption(cv, text) {
  const k = Math.max(cv.width, cv.height) / 800;
  const bar = Math.round(46 * k);
  const out = makeCanvas(cv.width, cv.height + bar);
  const c = out.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, out.width, out.height);
  c.fillStyle = '#1f2a37';
  c.font = `600 ${Math.round(24 * k)}px -apple-system, Roboto, system-ui, sans-serif`;
  c.textBaseline = 'middle';
  c.fillText(text, Math.round(10 * k), bar / 2);
  c.drawImage(cv, 0, bar);
  return out;
}

// Титульный лист заказа (рисуется картинкой — так кириллица в PDF без шрифтов)
function titlePage(folder, count) {
  const W = 1240, H = 1754, M = 100;
  const cv = makeCanvas(W, H);
  const c = cv.getContext('2d');
  const font = (w, s) => `${w} ${s}px -apple-system, Roboto, 'Segoe UI', system-ui, sans-serif`;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#eef6fb';
  c.fillRect(0, 0, W, 300);
  c.fillStyle = '#2b7de9';
  c.fillRect(0, 296, W, 8);
  c.fillStyle = '#6b7a8c';
  c.font = font(500, 34);
  c.fillText('ЗАМЕР', M, 120);
  c.fillStyle = '#1f2a37';
  c.font = font(700, 64);
  wrap(folder.name, M, 205, W - 2 * M, 72, 2);

  const o = folder.order || {};
  const rows = [
    ['Клиент', o.client], ['Телефон', o.phone], ['Адрес', o.address],
    ['Дата замера', isoToRu(o.date)], ['Комментарий', o.note],
    ['Фото и планов', String(count)], ['Составлено', fmtDate(Date.now())],
  ].filter(([, v]) => v);
  let y = 420;
  for (const [k, v] of rows) {
    c.fillStyle = '#6b7a8c';
    c.font = font(500, 30);
    c.fillText(k, M, y);
    c.fillStyle = '#1f2a37';
    c.font = font(600, 40);
    y = wrap(v, M, y + 54, W - 2 * M, 52, 6) + 50;
  }
  return cv;

  // Перенос строк; возвращает y последней строки
  function wrap(text, x, y0, maxW, lh, maxLines) {
    const words = String(text).split(/\s+/);
    let line = '', y = y0, n = 0;
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > maxW && line) {
        if (n >= maxLines - 1) { line += '…'; break; } // последняя строка — остаток обрезаем
        c.fillText(line, x, y);
        line = w;
        y += lh;
        n++;
      } else line = t;
    }
    c.fillText(line, x, y);
    return y;
  }
}

async function canvasToPage(cv) {
  const blob = await toBlob(cv, 'image/jpeg', 0.88);
  const page = { bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height };
  cv.width = cv.height = 0;
  return page;
}

function shareItemMenu(it) {
  menu(`Отправить «${it.name}»`, [
    { label: 'Картинка JPEG', run: () => exportItems([{ it, label: it.name }], 'jpeg', it.name) },
    { label: 'Документ PDF', run: () => exportItems([{ it, label: it.name }], 'pdf', it.name) },
  ]);
}

function shareFolderMenu(folder) {
  menu(`Отправить папку «${folder.name}»`, [
    { label: 'Один PDF: данные заказа + все фото', run: () => exportFolder(folder, 'pdf') },
    { label: 'Все фото картинками JPEG', run: () => exportFolder(folder, 'jpeg') },
    { label: 'Файл папки для другого замерщика', run: () => exportBackup(folder) },
  ]);
}

// Все фото и планы папки, включая подпапки, по порядку
async function collectMedia(folderId) {
  const all = await db.allItems();
  const out = [];
  const walk = (id, prefix) => {
    const kids = all.filter((i) => i.parentId === id).sort((a, b) => a.created - b.created);
    for (const k of kids) if (k.kind !== 'folder') out.push({ it: k, label: prefix + k.name });
    for (const k of kids) if (k.kind === 'folder') walk(k.id, prefix + k.name + ' / ');
  };
  walk(folderId, '');
  return out;
}

async function exportFolder(folder, fmt) {
  const list = await collectMedia(folder.id);
  if (!list.length) return toast('В папке нет фото и планов');
  exportItems(list, fmt, folder.name, folder);
}

// list: [{ it, label }]; titleFolder — добавить титульный лист заказа (для PDF)
async function exportItems(list, fmt, baseName, titleFolder = null) {
  const files = [];
  try {
    if (fmt === 'jpeg') {
      const used = new Set();
      for (let i = 0; i < list.length; i++) {
        busy(true, `Готовлю картинки ${i + 1} из ${list.length}…`);
        const cv = await renderItemCanvas(list[i].it, PHOTO_MAX);
        const blob = await toBlob(cv, 'image/jpeg', 0.9);
        cv.width = cv.height = 0;
        let name = safeName(list.length > 1 ? `${baseName} - ${list[i].label}` : list[i].label);
        while (used.has(name)) name += '_';
        used.add(name);
        files.push(new File([blob], name + '.jpg', { type: 'image/jpeg' }));
      }
    } else {
      const pages = [];
      if (titleFolder) pages.push(await canvasToPage(titlePage(titleFolder, list.length)));
      for (let i = 0; i < list.length; i++) {
        busy(true, `Собираю PDF: страница ${i + 1} из ${list.length}…`);
        const cv = await renderItemCanvas(list[i].it, 2400);
        pages.push(await canvasToPage(list.length > 1 || titleFolder ? withCaption(cv, list[i].label) : cv));
      }
      files.push(new File([buildPdf(pages)], safeName(baseName) + '.pdf', { type: 'application/pdf' }));
    }
  } catch (err) {
    console.error(err);
    busy(false);
    return toast('Не получилось: ' + err.message);
  }
  busy(false);
  shareFiles(files);
}

// Меню «Поделиться» телефона: мессенджеры, почта, Яндекс.Диск, Google Диск, Файлы
async function shareFiles(files) {
  const data = { files };
  if (navigator.canShare && navigator.canShare(data)) {
    try {
      await navigator.share(data);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Пока файл готовился, телефон «забыл» нажатие — просим нажать ещё раз
      const n = files.length;
      menu(n > 1 ? `Готово: ${n} файлов` : `Готово: ${files[0].name}`, [
        { label: 'Поделиться…', run: () => navigator.share(data).catch((e) => { if (e.name !== 'AbortError') files.forEach(download); }) },
        { label: 'Скачать', run: () => files.forEach(download) },
      ]);
      return;
    }
  }
  files.forEach(download);
  toast('Файл сохранён в «Загрузки»');
}

function download(file) {
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

// ---------- Резервная копия и перенос на другой телефон ----------

// folder = null — все данные; иначе — одна папка со всем содержимым
async function exportBackup(folder) {
  busy(true, 'Собираю файл…');
  try {
    const all = await db.allItems();
    let items = all;
    if (folder) {
      const ids = new Set([folder.id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const i of all) if (!ids.has(i.id) && ids.has(i.parentId)) { ids.add(i.id); grew = true; }
      }
      items = all.filter((i) => ids.has(i.id));
    }
    const images = {};
    for (const it of items) {
      if (it.kind !== 'photo') continue;
      const b = await db.getImage(it.id);
      if (b) images[it.id] = await blobToDataURL(b);
    }
    const data = { app: 'zamershik', version: 1, created: Date.now(), root: folder ? folder.id : null, items, images };
    const name = folder ? `${safeName(folder.name)}.zamer.json` : `ЗамерПро-копия-${todayIso()}.json`;
    const json = JSON.stringify(data);
    let file = new File([json], name, { type: 'application/json' });
    // Android разрешает отправлять не все типы файлов — тогда как текст
    if (navigator.canShare && !navigator.canShare({ files: [file] })) file = new File([json], name, { type: 'text/plain' });
    busy(false);
    shareFiles([file]);
  } catch (err) {
    console.error(err);
    busy(false);
    toast('Не получилось: ' + err.message);
  }
}

$('#file-import').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  busy(true, 'Загружаю…');
  try {
    let data;
    try { data = JSON.parse(await f.text()); } catch { throw new Error('это не файл «Замер Про»'); }
    if (!data || data.app !== 'zamershik' || !Array.isArray(data.items)) throw new Error('это не файл «Замер Про»');
    const existing = new Map((await db.allItems()).map((i) => [i.id, i]));
    const ids = new Set(data.items.map((i) => i.id));
    let added = 0, skipped = 0;
    for (const it of data.items) {
      const old = existing.get(it.id);
      // Свежая версия на телефоне не затирается
      if (old && (old.updated || 0) >= (it.updated || 0)) { skipped++; continue; }
      const n = { ...it };
      if (!ids.has(it.parentId)) n.parentId = old ? old.parentId : (data.root ? cur : null);
      if (data.images?.[it.id]) await db.putImage(it.id, await dataURLToBlob(data.images[it.id]));
      await db.putItem(n);
      added++;
    }
    toast(skipped ? `Добавлено: ${added}, уже было: ${skipped}` : `Добавлено: ${added}`);
  } catch (err) {
    console.error(err);
    toast('Не удалось открыть файл: ' + err.message, 4000);
  }
  busy(false);
  renderFolder();
};

// ---------- Установка на телефон ----------

function installText() {
  return isIOS
    ? 'Чтобы работало как приложение: в Safari «Поделиться» → «На экран „Домой“».'
    : 'Чтобы работало как приложение: меню ⋮ браузера → «Установить приложение» или «Добавить на главный экран».';
}

function showInstallHelp() {
  alert(installText() + '\n\nДанные хранятся только в этом телефоне. Время от времени делайте «Резервную копию» (⋯ → Резервная копия) и сохраняйте её на Яндекс.Диск, Google Диск или в Telegram.');
}

let tipClosed = false;
try { tipClosed = localStorage.getItem('tipClosed') === '1'; } catch { /* нет доступа */ }
if (!isStandalone() && !tipClosed) {
  $('#install-text').textContent = installText();
  $('#install-tip').classList.remove('hidden');
}
$('#tip-close').onclick = () => {
  $('#install-tip').classList.add('hidden');
  try { localStorage.setItem('tipClosed', '1'); } catch { /* нет доступа */ }
};

// ---------- Запуск ----------

navigator.storage?.persist?.();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW:', err));
}
history.replaceState({ f: null }, '');
renderFolder();
