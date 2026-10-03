// Редактор: фото или план в клетку. Стрелки с размерами, линии, карандаш, заметки.
import { dist, mid, distToSegment } from './geom.js';

export const COLORS = [
  { hex: '#ff3b30', name: 'Красный' },
  { hex: '#34c759', name: 'Зелёный' },
  { hex: '#0a84ff', name: 'Синий' },
  { hex: '#ffd60a', name: 'Жёлтый' },
  { hex: '#1c1c1e', name: 'Чёрный' },
  { hex: '#ffffff', name: 'Белый' },
];
// Толщина линий: 1 — тонкая (по умолчанию), 2 — средняя, 3 — толстая
export const WIDTHS = { 1: 1.5, 2: 2.5, 3: 4 };
const HIT_R = 26; // радиус касания маркера, px экрана
const MOVE_TOL = 7; // смещение пальца, после которого это уже не «тап»

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Текст на стрелке: «2450 мм», «245,5 см». Для простой линии без числа — пусто.
export function arrowLabel(s) {
  if (s.value == null || s.value === '') return s.heads ? '?' : '';
  // хвостовая запятая («245,» в процессе набора) на подписи не показывается
  return String(s.value).replace('.', ',').replace(/,$/, '') + (s.unit === 'cm' ? ' см' : ' мм');
}

// ---------- Рисование ----------

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
}

function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Плашка с текстом (можно повернуть вдоль стрелки). Возвращает полуширину.
function pill(c, text, p, angle, color, k, size) {
  c.save();
  c.font = `600 ${size * k}px -apple-system, system-ui, sans-serif`;
  const w = c.measureText(text).width + 16 * k;
  const h = (size + 10) * k;
  c.translate(p.x, p.y);
  c.rotate(angle);
  rrect(c, -w / 2, -h / 2, w, h, h / 2);
  c.fillStyle = color;
  c.shadowColor = 'rgba(0,0,0,.4)';
  c.shadowBlur = 4 * k;
  c.fill();
  c.shadowBlur = 0;
  c.fillStyle = isLight(color) ? '#000' : '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 0, 0.5 * k);
  c.restore();
  return w / 2;
}

// Угол, при котором подпись не вверх ногами
const readable = (a) => (a > Math.PI / 2 ? a - Math.PI : a < -Math.PI / 2 ? a + Math.PI : a);

// Лист в клетку для плана
export function makeGrid(cols = 30, rows = 21, step = 80) {
  const cv = document.createElement('canvas');
  cv.width = cols * step;
  cv.height = rows * step;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i <= cols; i++) line(i * step, 0, i * step, cv.height, i % 5 === 0);
  for (let j = 0; j <= rows; j++) line(0, j * step, cv.width, j * step, j % 5 === 0);
  function line(x1, y1, x2, y2, major) {
    c.strokeStyle = major ? '#9fb8d6' : '#d5e2f1';
    c.lineWidth = major ? 3 : 2;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }
  return cv;
}

// ---------- Редактор ----------

export class Editor {
  constructor(canvas, opts) {
    this.cv = canvas;
    this.c = canvas.getContext('2d');
    this.opts = opts; // { onChange, onSelect, onCreated, onTool, getDefaults }
    this.view = { s: 1, x: 0, y: 0 };
    this.tool = 'arrow';
    this.snap = 0;
    this.pointers = new Map();
    this.act = null;
    this.pinch = null;
    this.loupe = null;
    this.raf = 0;

    const on = (t, f) => canvas.addEventListener(t, f, { passive: false });
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e, false));
    on('pointercancel', (e) => this.onUp(e, true));
    on('wheel', (e) => this.onWheel(e));
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  // snap — шаг привязки к клеткам (0 — без привязки)
  open(item, img, snap = 0) {
    this.p = item;
    this.img = img;
    this.snap = snap;
    this.selId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.locked = false;
    this.pointers.clear();
    this.act = null;
    this.pinch = null;
    this.loupe = null;
    this.setTool(snap ? 'line' : 'arrow');
    this.resize();
    this.fit();
  }

  get shapes() { return this.p.shapes; }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const wasEmpty = !this.W;
    this.W = r.width;
    this.H = r.height;
    this.dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    if (wasEmpty) this.fit();
    this.draw();
  }

  // Вписать фото в экран между полупрозрачными панелями (insets — их высота сверху и снизу)
  fit() {
    if (!this.img || !this.W) return;
    const top = this.insets?.top || 0, bottom = this.insets?.bottom || 0;
    const h = Math.max(100, this.H - top - bottom);
    const s = Math.min(this.W / this.img.width, h / this.img.height);
    this.fitS = s;
    this.view = { s, x: (this.W - this.img.width * s) / 2, y: top + (h - this.img.height * s) / 2 };
    this.draw();
  }

  toImg(p) { return { x: (p.x - this.view.x) / this.view.s, y: (p.y - this.view.y) / this.view.s }; }
  toScr(p) { return { x: p.x * this.view.s + this.view.x, y: p.y * this.view.s + this.view.y }; }

  // Привязка точки к ближайшему узлу клетки
  snapPt(p) {
    if (!this.snap) return p;
    const st = this.snap;
    const x = Math.min(Math.max(Math.round(p.x / st) * st, 0), this.img.width);
    const y = Math.min(Math.max(Math.round(p.y / st) * st, 0), this.img.height);
    return { x, y };
  }

  // ----- Изменения и отмена -----

  snapshot() {
    this.undoStack.push(JSON.stringify(this.p.shapes));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    const prev = this.undoStack.pop();
    if (prev == null) return;
    this.redoStack.push(JSON.stringify(this.p.shapes));
    this.p.shapes = JSON.parse(prev);
    this.select(this.selected() ? this.selId : null);
    this.changed();
  }

  // Вернуть отменённое
  redo() {
    const next = this.redoStack.pop();
    if (next == null) return;
    this.undoStack.push(JSON.stringify(this.p.shapes));
    this.p.shapes = JSON.parse(next);
    this.select(this.selected() ? this.selId : null);
    this.changed();
  }

  // Сдвинуть фото так, чтобы фигура была видна над нижней панелью высотой bottom
  ensureVisible(s, bottom) {
    const pts = s.type === 'arrow' ? [s.a, s.b] : s.type === 'pen' ? s.pts : [s.p];
    const ys = pts.map((q) => this.toScr(q).y);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const top = (this.insets?.top || 0) + 40;
    const limit = this.H - bottom - 40;
    let dy = 0;
    if (maxY > limit) dy = limit - maxY;
    if (minY + dy < top) dy = top - minY;
    if (dy) {
      this.view = { ...this.view, y: this.view.y + dy };
      this.draw();
    }
  }

  // Замок: пальцем только двигать и увеличивать фото, ничего не рисуется и не сдвигается
  setLocked(on) {
    this.locked = on;
    if (on) this.select(null);
    this.draw();
  }

  changed() {
    this.opts.onChange();
    this.draw();
  }

  selected() { return this.shapes.find((s) => s.id === this.selId) || null; }

  select(id) {
    this.selId = id;
    this.opts.onSelect(this.selected());
    this.draw();
  }

  deleteSelected() {
    if (!this.selId) return;
    this.snapshot();
    this.p.shapes = this.shapes.filter((s) => s.id !== this.selId);
    this.select(null);
    this.changed();
  }

  setTool(t) {
    this.tool = t;
    this.opts.onTool(t);
  }

  // ----- Касания -----

  pt(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    e.preventDefault();
    if (!this.img) return;
    this.cv.setPointerCapture?.(e.pointerId);
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      // Два пальца — масштаб и сдвиг
      this.abortAct();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: dist(a, b) || 1, m: mid(a, b), view: { ...this.view } };
      return;
    }
    if (this.pointers.size > 2 || this.pinch) return;
    this.act = this.beginAct(p);
  }

  beginAct(p) {
    const base = { start: p, moved: false };
    if (this.locked) return { ...base, type: 'pan', view: { ...this.view }, locked: true };
    const ip = this.toImg(p);
    const h = this.hitHandle(p);
    if (h) {
      return { ...base, type: 'point', shape: h.shape, key: h.key, off: { x: h.pos.x - ip.x, y: h.pos.y - ip.y } };
    }
    // Карандашом рисуем поверх всего, не выбирая фигуры
    if (this.tool === 'pen') {
      const d = this.opts.getDefaults();
      return { ...base, type: 'newPen', shape: { id: uid(), type: 'pen', pts: [ip], color: d.color, w: d.width } };
    }
    const s = this.hitShape(p);
    if (s) {
      const wasSel = s.id === this.selId;
      if (!wasSel) this.select(s.id);
      return { ...base, type: 'shape', shape: s, last: ip, wasSel, viaLabel: this.hitLabel };
    }
    if (this.tool === 'arrow' || this.tool === 'line') {
      const d = this.opts.getDefaults();
      const a = this.snapPt(ip);
      return {
        ...base, type: 'newArrow',
        line: {
          id: uid(), type: 'arrow', a, b: { ...a },
          value: '', unit: d.unit, heads: this.tool === 'arrow' ? 2 : 0, color: d.color, w: d.width,
        },
      };
    }
    return { ...base, type: 'pan', view: { ...this.view } };
  }

  abortAct() {
    const restore = !!this.act?.snap;
    if (restore) this.p.shapes = JSON.parse(this.undoStack.pop());
    this.act = null;
    this.loupe = null;
    if (restore) this.select(this.selected() ? this.selId : null); // панель должна держать новый объект
    this.draw();
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.pt(e);
    this.pointers.set(e.pointerId, p);

    if (this.pinch) {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const pv = this.pinch.view;
      const s = Math.min(Math.max(pv.s * (dist(a, b) / this.pinch.d), this.fitS * 0.5), 12);
      const m = mid(a, b);
      const ix = (this.pinch.m.x - pv.x) / pv.s, iy = (this.pinch.m.y - pv.y) / pv.s;
      this.view = { s, x: m.x - ix * s, y: m.y - iy * s };
      return this.draw();
    }

    const a = this.act;
    if (!a) return;
    if (!a.moved && dist(p, a.start) < MOVE_TOL) return;
    a.moved = true;
    const ip = this.toImg(p);

    if (a.type === 'pan') {
      this.view = { ...a.view, x: a.view.x + p.x - a.start.x, y: a.view.y + p.y - a.start.y };
    } else if (a.type === 'newArrow') {
      a.line.b = this.snapPt(ip);
      this.loupe = { p, ip: a.line.b };
    } else if (a.type === 'newPen') {
      const pts = a.shape.pts;
      if (dist(this.toScr(pts[pts.length - 1]), p) > 2) pts.push(ip);
    } else if (a.type === 'point') {
      if (!a.snap) { this.snapshot(); a.snap = true; }
      const np = this.snapPt({ x: ip.x + a.off.x, y: ip.y + a.off.y });
      a.shape[a.key] = np;
      this.loupe = { p, ip: np };
    } else if (a.type === 'shape') {
      if (!a.snap) { this.snapshot(); a.snap = true; a.orig = JSON.stringify(pointsOf(a.shape)); }
      // На плане фигура сдвигается целыми клетками
      const start = this.toImg(a.start);
      let dx = ip.x - start.x;
      let dy = ip.y - start.y;
      if (this.snap) {
        dx = Math.round(dx / this.snap) * this.snap;
        dy = Math.round(dy / this.snap) * this.snap;
      }
      const orig = JSON.parse(a.orig);
      pointsOf(a.shape).forEach((q, i) => { q.x = orig[i].x + dx; q.y = orig[i].y + dy; });
    }
    this.draw();
  }

  onUp(e, cancel) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size === 0) this.pinch = null;
      return;
    }
    const a = this.act;
    if (cancel) return this.abortAct(); // откат переноса при отмене касания
    this.act = null;
    this.loupe = null;
    if (!a) return this.draw();

    if (a.type === 'newArrow') {
      if (a.moved && dist(this.toScr(a.line.a), this.toScr(a.line.b)) > 12) this.add(a.line);
      else this.select(null);
    } else if (a.type === 'newPen') {
      if (a.shape.pts.length > 1) this.add(a.shape, false);
    } else if (a.type === 'shape' && !a.moved) {
      // Двойное касание — изменить размер/текст. Одно касание только выделяет (можно двигать).
      // Исключение: у стрелки без размера касание по «?» сразу открывает ввод.
      const now = Date.now();
      const dbl = this.lastTap && this.lastTap.id === a.shape.id && now - this.lastTap.t < 400;
      const empty = a.shape.type === 'arrow' && (a.shape.value == null || a.shape.value === '');
      if (dbl || (a.viaLabel && empty)) {
        this.lastTap = null;
        this.opts.onShapeTap?.(a.shape);
      } else {
        this.lastTap = { id: a.shape.id, t: now };
      }
    } else if (a.type === 'pan' && !a.moved && a.locked) {
      this.opts.onLockedTap?.();
    } else if (a.type === 'pan' && !a.moved) {
      this.tap(this.pt(e));
    } else if (a.snap) {
      this.changed();
    }
    this.draw();
  }

  add(shape, selectIt = true) {
    this.snapshot();
    this.shapes.push(shape);
    if (selectIt) this.select(shape.id);
    this.changed();
    if (selectIt) this.opts.onCreated?.(shape);
  }

  // Короткое касание по пустому месту
  tap(p) {
    if (this.tool === 'text') {
      const d = this.opts.getDefaults();
      this.add({ id: uid(), type: 'text', p: this.toImg(p), text: '', color: d.color });
      return;
    }
    this.select(null);
  }

  onWheel(e) {
    e.preventDefault();
    const p = this.pt(e);
    const v = this.view;
    const s = Math.min(Math.max(v.s * Math.exp(-e.deltaY * 0.0015), this.fitS * 0.5), 12);
    const ix = (p.x - v.x) / v.s, iy = (p.y - v.y) / v.s;
    this.view = { s, x: p.x - ix * s, y: p.y - iy * s };
    this.draw();
  }

  // ----- Попадание касанием -----

  // Концы выделенной стрелки/линии
  hitHandle(p) {
    const s = this.selected();
    if (!s || s.type !== 'arrow') return null;
    let best = null;
    for (const key of ['a', 'b']) {
      const d = dist(p, this.toScr(s[key]));
      if (d < HIT_R && (!best || d < best.d)) best = { shape: s, key, pos: s[key], d };
    }
    return best;
  }

  hitShape(p) {
    const list = [...this.shapes].reverse();
    this.hitLabel = false;
    for (const s of list) {
      const lb = this.labels?.get(s.id);
      if (lb && dist(p, lb) < lb.r) { this.hitLabel = true; return s; }
    }
    for (const s of list) {
      if (s.type === 'arrow' && distToSegment(p, this.toScr(s.a), this.toScr(s.b)) < 14) return s;
      if (s.type === 'pen') {
        const P = s.pts.map((q) => this.toScr(q));
        for (let i = 1; i < P.length; i++) if (distToSegment(p, P[i - 1], P[i]) < 12) return s;
      }
    }
    return null;
  }

  // ----- Отрисовка -----

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    const c = this.c;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.fillStyle = '#dfe9f1';
    c.fillRect(0, 0, this.W, this.H);
    if (!this.img) return;
    this.labels = new Map();
    this.scene(c, this.view, 1, 'screen');
    if (this.loupe) this.drawLoupe(c);
  }

  // mode: 'screen' | 'loupe' | 'export'
  scene(c, view, k, mode) {
    c.save();
    c.translate(view.x, view.y);
    c.scale(view.s, view.s);
    c.imageSmoothingQuality = 'high';
    c.drawImage(this.img, 0, 0, this.img.width, this.img.height);
    c.restore();

    const S = (p) => ({ x: p.x * view.s + view.x, y: p.y * view.s + view.y });
    const ui = mode === 'screen';
    const shapes = [...this.shapes];
    if (mode !== 'export' && this.act?.moved) {
      if (this.act.type === 'newArrow') shapes.push(this.act.line);
      if (this.act.type === 'newPen') shapes.push(this.act.shape);
    }
    for (const s of shapes) {
      const sel = ui && s.id === this.selId;
      if (s.type === 'arrow') this.drawArrow(c, s, S, k, sel, ui);
      else if (s.type === 'pen') this.drawPen(c, s, S, k, sel);
      else if (s.type === 'text') this.drawText(c, s, S, k, sel, ui);
    }
  }

  drawArrow(c, s, S, k, sel, ui) {
    const A = S(s.a), B = S(s.b);
    const ang = Math.atan2(B.y - A.y, B.x - A.x);
    const plain = !s.heads;
    const lw = WIDTHS[s.w || 1] * (plain ? 1.3 : 1);
    const L = (8 + lw * 2.5) * k, W = 0.42; // размер наконечника растёт с толщиной
    const head = (P, dir) => {
      c.moveTo(P.x, P.y);
      c.lineTo(P.x - L * Math.cos(dir - W), P.y - L * Math.sin(dir - W));
      c.lineTo(P.x - L * Math.cos(dir + W), P.y - L * Math.sin(dir + W));
      c.closePath();
    };
    const heads = () => {
      c.beginPath();
      if (s.heads >= 1) head(B, ang);
      if (s.heads === 2) head(A, ang + Math.PI);
    };
    // Подпись прямо на линии (как в ImageMeter): линия под текстом прерывается
    const M = mid(A, B);
    const len = dist(A, B);
    // «?» у стрелки без размера — подсказка только на экране редактора, в картинку/PDF не попадает
    const text = !ui && (s.value == null || s.value === '') ? '' : arrowLabel(s);
    const fs = 15 * k;
    c.save();
    c.font = `600 ${fs}px -apple-system, Roboto, system-ui, sans-serif`;
    const tw = text ? c.measureText(text).width : 0;
    c.restore();
    const gap = tw / 2 + 6 * k;
    const inLine = text && len > 2 * gap + 2 * L; // помещается ли текст в разрыв линии
    const ux = (B.x - A.x) / (len || 1), uy = (B.y - A.y) / (len || 1);
    const line = () => {
      c.beginPath();
      if (inLine) {
        c.moveTo(A.x, A.y); c.lineTo(M.x - ux * gap, M.y - uy * gap);
        c.moveTo(M.x + ux * gap, M.y + uy * gap); c.lineTo(B.x, B.y);
      } else {
        c.moveTo(A.x, A.y); c.lineTo(B.x, B.y);
      }
    };
    const dark = s.color === '#1c1c1e';
    const halo = dark ? 'rgba(255,255,255,.7)' : 'rgba(0,0,0,.45)';

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (sel) {
      c.strokeStyle = 'rgba(10,132,255,.45)';
      c.lineWidth = (lw + 8) * k;
      c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.stroke();
    }
    // обводка для контраста на любом фоне
    c.strokeStyle = halo;
    c.lineWidth = (lw + 1.5) * k;
    line(); c.stroke();
    if (!plain) { heads(); c.stroke(); }
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = lw * k;
    line(); c.stroke();
    if (!plain) { heads(); c.fill(); c.lineWidth = 1 * k; c.stroke(); }

    if (text) {
      // короткая стрелка — подпись над линией
      const off = inLine ? 0 : fs * 0.95;
      const ra = readable(ang);
      const P = { x: M.x + Math.sin(ra) * off, y: M.y - Math.cos(ra) * off };
      c.translate(P.x, P.y);
      c.rotate(ra);
      c.font = `600 ${fs}px -apple-system, Roboto, system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.strokeStyle = dark ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.6)';
      c.lineWidth = 2.2 * k;
      c.strokeText(text, 0, 0);
      c.fillStyle = s.color;
      c.fillText(text, 0, 0);
      if (ui) this.labels.set(s.id, { x: P.x, y: P.y, r: Math.max(tw / 2 + 6, 22) });
    }
    c.restore();
    if (ui && sel) this.handles(c, [A, B]);
  }

  drawPen(c, s, S, k, sel) {
    const P = s.pts.map(S);
    const path = () => {
      c.beginPath();
      P.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    };
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (sel) {
      path();
      c.strokeStyle = 'rgba(10,132,255,.55)';
      c.lineWidth = 12 * k;
      c.stroke();
    }
    path();
    c.strokeStyle = s.color;
    c.lineWidth = WIDTHS[s.w || 1] * 1.3 * k;
    c.stroke();
    c.restore();
  }

  drawText(c, s, S, k, sel, ui) {
    if (!ui && !s.text) return; // пустая заметка не попадает в картинку
    const P = S(s.p);
    const r = pill(c, s.text || 'Заметка', P, 0, s.color, k, 14);
    if (ui) {
      this.labels.set(s.id, { x: P.x, y: P.y, r: Math.max(r, 20) });
      if (sel) {
        c.save();
        c.strokeStyle = '#0a84ff';
        c.setLineDash([4, 4]);
        c.lineWidth = 2;
        rrect(c, P.x - r - 4, P.y - 17, 2 * r + 8, 34, 17);
        c.stroke();
        c.restore();
      }
    }
  }

  handles(c, P) {
    for (const q of P) {
      c.beginPath();
      c.arc(q.x, q.y, 10, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = '#0a84ff';
      c.stroke();
    }
  }

  // Лупа над пальцем, чтобы точно поставить конец стрелки
  drawLoupe(c) {
    const { p, ip } = this.loupe;
    const R = 58, z = 3;
    const cx = Math.min(Math.max(p.x, R + 6), this.W - R - 6);
    let cy = p.y - R - 60;
    if (cy - R < 6) cy = p.y + R + 60;
    const s = this.view.s * z;
    c.save();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#000';
    c.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    this.scene(c, { s, x: cx - ip.x * s, y: cy - ip.y * s }, 1, 'loupe');
    c.strokeStyle = '#0a84ff';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(cx - 14, cy); c.lineTo(cx - 4, cy);
    c.moveTo(cx + 4, cy); c.lineTo(cx + 14, cy);
    c.moveTo(cx, cy - 14); c.lineTo(cx, cy - 4);
    c.moveTo(cx, cy + 4); c.lineTo(cx, cy + 14);
    c.stroke();
    c.restore();
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.lineWidth = 3;
    c.strokeStyle = '#fff';
    c.stroke();
  }

  // Картинка с разметкой (для отправки и превью)
  renderImage(maxSide) {
    const iw = this.img.width, ih = this.img.height;
    const f = Math.min(1, maxSide / Math.max(iw, ih));
    const cv = document.createElement('canvas');
    cv.width = Math.round(iw * f);
    cv.height = Math.round(ih * f);
    // Размер линий и подписей — как на экране телефона, когда фото вписано целиком
    const k = Math.max(cv.width, cv.height) / 500;
    this.scene(cv.getContext('2d'), { s: f, x: 0, y: 0 }, k, 'export');
    return cv;
  }
}

// Отрисовка с разметкой без открытия редактора (для отправки всей папки)
export function renderAnnotated(img, shapes, maxSide) {
  const r = Object.create(Editor.prototype);
  Object.assign(r, { img, p: { shapes }, act: null, selId: null });
  return r.renderImage(maxSide);
}

function pointsOf(s) {
  if (s.type === 'arrow') return [s.a, s.b];
  if (s.type === 'pen') return s.pts;
  return [s.p];
}
