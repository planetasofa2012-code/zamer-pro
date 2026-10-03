// Сборка PDF из JPEG-страниц без библиотек.
// Каждая страница — A4 (книжная или альбомная по форме картинки), картинка вписана с полями.

const enc = new TextEncoder();

// pages: [{ bytes: Uint8Array (JPEG), w, h }] — w, h в пикселях
export function buildPdf(pages) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => {
    const b = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  // Нумерация: 1 — каталог, 2 — список страниц, далее по 3 объекта на страницу
  const pageIds = pages.map((_, i) => 3 + i * 3);
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`));

  pages.forEach((pg, i) => {
    const pid = pageIds[i], iid = pid + 1, cid = pid + 2;
    const land = pg.w > pg.h;
    const PW = land ? 842 : 595, PH = land ? 595 : 842, M = 20;
    const f = Math.min((PW - 2 * M) / pg.w, (PH - 2 * M) / pg.h);
    const w = pg.w * f, h = pg.h * f;
    const x = (PW - w) / 2, y = (PH - h) / 2;
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;

    obj(pid, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] ` +
      `/Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`,
    ));
    obj(iid, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${pg.w} /Height ${pg.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.bytes.length} >>\nstream\n`,
      );
      push(pg.bytes);
      push('\nendstream');
    });
    obj(cid, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });

  const total = 3 + pages.length * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
