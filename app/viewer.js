/* viewer.js — hwp·hwpx 말고 다른 문서를 휴대폰 안에서 '보기'로 연다(편집은 hwp·hwpx 만). 서버로 보내지 않는다.
 * PDF: pdf.js(Apache-2.0) · Word(docx): docx-preview(Apache-2.0)+JSZip(MIT) · PowerPoint(pptx): pptx-preview(ISC)
 * Excel(xlsx·xls·ods·csv): SheetJS(Apache-2.0) · 이미지·영상·음성·텍스트: 브라우저 기본 기능
 * 라이브러리는 vendor/ 에 들어 있고(오프라인), 그 형식을 처음 열 때만 불러온다.
 * window.KViewer = { kindOf(name, bytes), open(container, file, buf, onInfo) → { kind, label, close() } }
 */
(function () {
  'use strict';
  const EXT = {
    pdf: ['pdf'],
    docx: ['docx', 'docm', 'dotx'],
    pptx: ['pptx', 'pptm', 'ppsx', 'potx'],
    sheet: ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'heic', 'heif'],
    video: ['mp4', 'webm', 'mov', 'm4v', '3gp', 'mkv'],
    audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'amr', 'opus'],
    text: ['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'log', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'sql', 'sh', 'bat', 'ps1', 'css', 'srt', 'vtt'],
  };
  const LABEL = { pdf: 'PDF', docx: 'Word', pptx: 'PowerPoint', sheet: '표(Excel)', image: '이미지', video: '영상', audio: '음성', text: '텍스트' };
  const OLD = { doc: 'Word 97~2003(.doc)', ppt: 'PowerPoint 97~2003(.ppt)', rtf: 'RTF' };
  const extOf = (name) => (String(name || '').match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  function kindOf(name, u8) {
    const e = extOf(name);
    for (const [k, list] of Object.entries(EXT)) if (list.includes(e)) return k;
    if (OLD[e]) return 'old:' + e;
    if (u8 && u8.length > 4) {   // 확장자가 없을 때 내용으로
      if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';
      if (u8[0] === 0x89 && u8[1] === 0x50) return 'image';
      if (u8[0] === 0xFF && u8[1] === 0xD8) return 'image';
    }
    return '';
  }

  // 라이브러리 한 번만 불러오기
  const loaded = {};
  function script(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error(`보기 도구를 불러오지 못했어요(${src})`)); }; document.head.appendChild(s); });
    return loaded[src];
  }
  const V = 'vendor/';

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const fitWidth = (host) => Math.max(240, host.clientWidth - 16);

  // ── PDF ──
  async function openPdf(host, buf, info, name, hooks) {
    const keep = hooks && hooks.edit ? buf.slice(0) : null;   // pdf.js 가 buf 를 넘겨받아 비우므로 고치기용 사본을 먼저
    await script(V + 'pdf.min.js');
    const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = V + 'pdf.worker.min.js';
    const opts = { data: new Uint8Array(buf), cMapUrl: V + 'cmaps/', cMapPacked: true, isEvalSupported: false };
    if (location.protocol === 'file:') {
      // 안드로이드 앱(file://): 별도 worker·fetch 가 막혀 있어 처리기는 화면과 같은 곳에서 돌리고(worker 스크립트를 미리 불러 둠),
      // 한글 글자 지도(CMap)는 앱이 직접 읽어 준다(AndroidBridge.readAsset)
      await script(V + 'pdf.worker.min.js');
      const br = window.AndroidBridge;
      if (br && br.readAsset) {
        opts.CMapReaderFactory = class {
          constructor() { /* 설정 없음 */ }
          async fetch({ name }) {
            const b64 = br.readAsset(`www/vendor/cmaps/${name}.bcmap`);
            if (!b64) throw new Error(`글자 지도 없음: ${name}`);
            const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return { cMapData: u8, compressionType: 1 };   // 1 = BINARY(bcmap)
          }
        };
      }
    }
    const doc = await lib.getDocument(opts).promise;
    info(`${doc.numPages}쪽`);
    const pages = []; const W = fitWidth(host); const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (let i = 1; i <= doc.numPages; i++) {
      const box = el('div', 'kv-page'); box.dataset.n = i;
      const p1 = await (i === 1 ? doc.getPage(1) : Promise.resolve(null));
      const ratio = p1 ? p1.getViewport({ scale: 1 }).height / p1.getViewport({ scale: 1 }).width : (pages[0] ? pages[0].ratio : 1.414);
      box.style.width = `${W}px`; box.style.height = `${Math.round(W * ratio)}px`;
      host.appendChild(box); pages.push({ box, ratio, done: false, n: i });
    }
    let alive = true;
    // 글자 고치기(덮어쓰기): 원래 글자 위를 바탕색으로 덮고 새 글자를 쓴다. 고칠 줄은 pdf.js 의 글자 위치로 찾는다
    const ed = keep ? pdfEditor(keep) : null;
    const drawOv = (pg) => {
      if (!ed || !pg.ov) return; pg.ov.textContent = '';
      (pg.lines || []).forEach((L, li) => {
        const key = `${pg.n}:${li}`; const e = ed.get(key); const r = pdfRect(pg, L);
        if (e) {
          const cover = el('div', 'kv-ppatch'); Object.assign(cover.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.w}px`, height: `${r.h}px`, background: rgbCss(e.bg) });
          const fit = fitSize(e.text, L.size, L.w, measure);
          const tx = el('span', 'kv-ptext', e.text); Object.assign(tx.style, { left: `${r.bx}px`, top: `${r.by - fit * pg.css * 0.9}px`, fontSize: `${fit * pg.css}px`, color: rgbCss(e.fg) });
          pg.ov.appendChild(cover); pg.ov.appendChild(tx);
        }
        const b = el('button', 'kv-pline' + (e ? ' changed' : '')); b.type = 'button'; b.setAttribute('aria-label', `${pg.n}쪽 글자: ${L.str}`);
        Object.assign(b.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.w}px`, height: `${r.h}px` });
        b.onclick = () => {
          const cur = ed.get(key);
          hooks.edit({
            title: `${pg.n}쪽 글자 고치기`, value: cur ? cur.text : L.str, multiline: false, canRevert: !!cur,
            note: '원래 글자 위를 덮고 새 글자를 써요 (글꼴은 기본 고딕)',
            apply: (val) => {
              if (!cur && val === L.str) return;
              const col = cur || sampleColors(pg, r);
              ed.set(key, { n: pg.n, x: L.x, y: L.y, w: L.w, size: L.size, text: val, bg: col.bg, fg: col.fg });
              drawOv(pg); hooks.changed();
            },
            revert: () => { ed.revert(key); drawOv(pg); hooks.changed(); },
          });
        };
        pg.ov.appendChild(b);
      });
    };
    const draw = async (pg, n) => {
      if (pg.done || !alive) return; pg.done = true;
      const page = await doc.getPage(n); const vp1 = page.getViewport({ scale: 1 }); const scale = (W / vp1.width) * dpr; const vp = page.getViewport({ scale });
      const c = el('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height); c.style.width = `${W}px`; c.style.height = `${Math.round(vp.height / dpr)}px`;
      pg.box.style.height = 'auto'; pg.box.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (ed) {
        Object.assign(pg, { vp1, css: W / vp1.width, canvas: c, k: c.width / W });
        pg.ov = el('div', 'kv-pdfov'); pg.box.appendChild(pg.ov);
        page.getTextContent().then((tc) => { pg.lines = pdfLines(tc.items); drawOv(pg); }).catch(() => { pg.lines = []; });
      }
    };
    // 앞 두 쪽은 바로, 나머지는 화면 가까이 오면(IntersectionObserver + 스크롤 위치 확인 — 화면이 가려져 있을 때도 동작)
    for (let i = 0; i < Math.min(2, pages.length); i++) await draw(pages[i], i + 1).catch(() => {});
    const near = () => { const H = window.innerHeight || 800; pages.forEach((p, i) => { if (!p.done) { const r = p.box.getBoundingClientRect(); if (r.top < H + 900 && r.bottom > -900) draw(p, i + 1).catch(() => {}); } }); };
    const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { const n = +en.target.dataset.n; draw(pages[n - 1], n).catch(() => {}); } }), { rootMargin: '900px 0px' }) : null;
    if (io) pages.forEach((p) => io.observe(p.box));
    window.addEventListener('scroll', near, { passive: true }); near();
    if (ed) {
      const seg = el('div', 'kv-seg'); const bPrev = el('button', null, '미리보기'), bEdit = el('button', null, '글자 고치기');
      [bPrev, bEdit].forEach((b) => { b.type = 'button'; seg.appendChild(b); }); host.insertBefore(seg, host.firstChild);
      const mode = (on) => {
        bPrev.setAttribute('aria-pressed', String(!on)); bEdit.setAttribute('aria-pressed', String(on)); host.classList.toggle('kv-pdf-edit', on);
        if (on && hooks.toast) {
          const drawn = pages.filter((p) => p.lines); const none = drawn.length > 0 && !drawn.some((p) => p.lines.length);
          hooks.toast(none ? '고칠 수 있는 글자가 없어요 (사진으로 된 PDF 일 수 있어요)' : '고칠 글자를 누르세요', none);
        }
      };
      bPrev.onclick = () => mode(false); bEdit.onclick = () => mode(true); mode(false);
    }
    return { close: () => { alive = false; if (io) io.disconnect(); window.removeEventListener('scroll', near); host.classList.remove('kv-pdf-edit'); doc.destroy(); }, editor: ed };
  }

  // ── PDF 글자 고치기 도우미 ──
  // 글자 조각(item)들을 같은 줄·가까운 간격끼리 한 줄로 묶는다(회전된 글자는 뺌). 좌표는 PDF 사용자 공간(pt, 아래가 0)
  function pdfLines(items) {
    const out = []; let cur = null;
    for (const it of items) {
      const t = it.transform;
      if (!t || typeof it.str !== 'string' || !it.str) { if (it.hasEOL) cur = null; continue; }
      if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01 || t[0] <= 0 || t[3] <= 0) { cur = null; continue; }
      const size = t[3], x = t[4], y = t[5], w = it.width || 0;
      if (!it.str.trim()) { if (cur) cur.sp = true; if (it.hasEOL) cur = null; continue; }   // 빈칸 조각은 폭을 늘리지 않음(표 칸 사이 빈칸이 칸들을 잇지 않게)
      if (cur && Math.abs(y - cur.y) < cur.size * 0.3 && size / cur.size > 0.8 && size / cur.size < 1.25) {
        const gap = x - (cur.x + cur.w);
        if (gap > -cur.size * 0.5 && gap < cur.size * 0.8) {
          if ((cur.sp || gap > cur.size * 0.2) && !/\s$/.test(cur.str)) cur.str += ' ';
          cur.sp = false;
          cur.str += it.str; cur.w = Math.max(cur.w, x + w - cur.x); cur.size = Math.max(cur.size, size);
          if (it.hasEOL) cur = null; continue;
        }
      }
      cur = { x, y, w, size, str: it.str }; out.push(cur);
      if (it.hasEOL) cur = null;
    }
    out.forEach((l) => { l.str = l.str.trim(); });
    return out.filter((l) => l.str && l.w > 0);
  }
  // 덮을 칸(글자 아래 0.28·위 1.0 글자 크기)을 화면 px 로. bx·by = 글자 기준선 시작점
  function pdfRect(pg, L) {
    const [x1, y1, x2, y2] = pg.vp1.convertToViewportRectangle([L.x - L.size * 0.08, L.y - L.size * 0.28, L.x + L.w + L.size * 0.08, L.y + L.size * 1.0]);
    const [bx, by] = pg.vp1.convertToViewportPoint(L.x, L.y); const k = pg.css;
    return { l: Math.min(x1, x2) * k, t: Math.min(y1, y2) * k, w: Math.abs(x2 - x1) * k, h: Math.abs(y2 - y1) * k, bx: bx * k, by: by * k };
  }
  // 바탕색 = 칸 테두리에서 가장 많은 색, 글자색 = 칸 안에서 바탕과 가장 먼 색 (0~1)
  function sampleColors(pg, r) {
    const c = pg.canvas, k = pg.k;
    const x = Math.max(0, Math.floor((r.l - 1) * k)), y = Math.max(0, Math.floor((r.t - 1) * k));
    const w = Math.min(c.width - x, Math.ceil((r.w + 2) * k)), h = Math.min(c.height - y, Math.ceil((r.h + 2) * k));
    if (w < 3 || h < 3) return { bg: [1, 1, 1], fg: [0, 0, 0] };
    let d; try { d = c.getContext('2d').getImageData(x, y, w, h).data; } catch (e) { return { bg: [1, 1, 1], fg: [0, 0, 0] }; }
    const edge = []; for (let i = 0; i < w; i++) edge.push(i * 4, ((h - 1) * w + i) * 4); for (let j = 1; j < h - 1; j++) edge.push(j * w * 4, (j * w + w - 1) * 4);
    const q = (i) => ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const cnt = new Map(); edge.forEach((i) => cnt.set(q(i), (cnt.get(q(i)) || 0) + 1));
    let top = 0, best = -1; cnt.forEach((n, key) => { if (n > best) { best = n; top = key; } });
    const s = [0, 0, 0]; let m = 0; edge.forEach((i) => { if (q(i) === top) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; m++; } });
    const bg = s.map((a) => a / m);
    // 글자색: 바탕과 충분히 다른 화소 중 가장 많은 색(글자 가장자리의 섞인 색보다 글자 속 색이 많다)
    const fc = new Map();
    for (let i = 0; i < d.length; i += 4) { if ((d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2 > 3600) { const key = q(i); const e = fc.get(key) || [0, 0, 0, 0]; e[0] += d[i]; e[1] += d[i + 1]; e[2] += d[i + 2]; e[3]++; fc.set(key, e); } }
    let fg = null, fb = 0; fc.forEach((e) => { if (e[3] > fb) { fb = e[3]; fg = [e[0] / e[3], e[1] / e[3], e[2] / e[3]]; } });
    if (!fg) fg = bg.reduce((a, b) => a + b, 0) / 3 > 128 ? [0, 0, 0] : [255, 255, 255];   // 글자색을 못 찾으면 검정/흰색
    return { bg: bg.map((a) => a / 255), fg: fg.map((a) => a / 255) };
  }
  const rgbCss = (c) => `rgb(${c.map((a) => Math.round(a * 255)).join(',')})`;
  // 새 글자가 원래 폭보다 길면 원래 크기의 70% 까지 줄여 맞춘다
  const fitSize = (text, size, w, widthAt) => { const tw = widthAt(text, size); return tw > w * 1.05 ? Math.max(size * 0.7, size * (w / tw)) : size; };
  let mctx = null;
  const measure = (t, s) => { mctx = mctx || document.createElement('canvas').getContext('2d'); mctx.font = `${s}px 'KRRI Doc Sans', Pretendard, sans-serif`; return mctx.measureText(t).width; };
  async function pdfFontBytes() {
    const br = window.AndroidBridge;
    if (location.protocol === 'file:' && br && br.readAsset) {
      const b64 = br.readAsset('www/vendor/fonts/krri-doc-sans.ttf'); if (!b64) throw new Error('글꼴을 읽지 못했어요');
      const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8;
    }
    const r = await fetch(V + 'fonts/krri-doc-sans.ttf'); if (!r.ok) throw new Error('글꼴을 읽지 못했어요'); return new Uint8Array(await r.arrayBuffer());
  }
  function pdfEditor(buf) {
    const src = buf; const edits = new Map();
    return {
      kind: 'pdf', ext: 'pdf', mime: 'application/pdf',
      count: () => edits.size, get: (k) => edits.get(k), set: (k, e) => edits.set(k, e), revert: (k) => edits.delete(k),
      async save() {
        await script(V + 'pdf-lib.min.js'); await script(V + 'fontkit.umd.min.js');
        const { PDFDocument, rgb } = window.PDFLib;
        let pdf; try { pdf = await PDFDocument.load(src, { updateMetadata: false }); } catch (e) { throw new Error(/encrypt/i.test(e.message) ? '암호가 걸린 PDF 는 고칠 수 없어요' : `PDF 를 읽지 못했어요 (${e.message})`); }
        pdf.registerFontkit(window.fontkit);
        const font = await pdf.embedFont(await pdfFontBytes(), { subset: true });
        const pages = pdf.getPages();
        for (const e of edits.values()) {
          const p = pages[e.n - 1]; if (!p) continue; const pad = e.size * 0.08;
          p.drawRectangle({ x: e.x - pad, y: e.y - e.size * 0.28, width: e.w + pad * 2, height: e.size * 1.28, color: rgb(...e.bg) });
          if (e.text) p.drawText(e.text, { x: e.x, y: e.y, size: fitSize(e.text, e.size, e.w, (t, s) => font.widthOfTextAtSize(t, s)), font, color: rgb(...e.fg) });
        }
        return new Blob([await pdf.save()], { type: 'application/pdf' });
      },
    };
  }

  // ── 「미리보기 | 글자 고치기」 전환(PowerPoint·Word 공용) ──
  // groups = [{ label, paras }] · ed = { text(gi,pi), isChanged, set, revert, save } · rerender(buf) = 미리보기 다시 그리기
  function editToggle(host, wrap, ed, groups, hooks, info, rerender, unit) {
    const seg = el('div', 'kv-seg'); const bPrev = el('button', null, '미리보기'), bEdit = el('button', null, '글자 고치기');
    [bPrev, bEdit].forEach((b) => { b.type = 'button'; seg.appendChild(b); });
    host.insertBefore(seg, wrap);
    const list = el('div', 'kv-plist'); host.appendChild(list); list.hidden = true;
    let dirty = false;
    const drawList = () => {
      list.textContent = '';
      groups().forEach((g, gi) => {
        if (g.label) list.appendChild(el('div', 'kv-slide-h', g.label));
        if (!g.paras.length) list.appendChild(el('p', 'kv-note', '글자가 없어요'));
        g.paras.forEach((x, pi) => {
          const row = el('button', 'kv-prow' + (ed.isChanged(gi, pi) ? ' changed' : ''), ed.text(gi, pi)); row.type = 'button';
          row.onclick = () => hooks.edit({
            title: `${g.label || ''} 글자 고치기`.trim(), value: ed.text(gi, pi), multiline: true,
            note: /[\n\t]/.test(ed.text(gi, pi)) ? '줄 바꿈·탭 위치는 그대로 두고 고쳐 주세요' : '',
            canRevert: ed.isChanged(gi, pi),
            apply: (v) => { ed.set(gi, pi, v); dirty = true; row.textContent = ed.text(gi, pi); row.classList.toggle('changed', ed.isChanged(gi, pi)); hooks.changed(); },
            revert: () => { ed.revert(gi, pi); dirty = true; row.textContent = ed.text(gi, pi); row.classList.remove('changed'); hooks.changed(); },
          });
          list.appendChild(row);
        });
      });
    };
    const mode = async (editMode) => {
      bPrev.setAttribute('aria-pressed', String(!editMode)); bEdit.setAttribute('aria-pressed', String(editMode));
      if (editMode) { drawList(); wrap.hidden = true; list.hidden = false; return; }
      list.hidden = true; wrap.hidden = false;
      if (dirty) { dirty = false; info('고친 글자로 다시 그리는 중…'); await rerender(await (await ed.save()).arrayBuffer()); info(unit()); }
    };
    bPrev.onclick = () => mode(false).catch((e) => hooks.toast && hooks.toast(e.message, true)); bEdit.onclick = () => mode(true);
    mode(false);
  }

  // ── Word ──
  async function openDocx(host, buf, info, name, hooks) {
    await script(V + 'jszip.min.js'); await script(V + 'docx-preview.min.js');
    const wrap = el('div', 'kv-docx'); host.appendChild(wrap);
    const render = async (data) => { wrap.textContent = ''; await window.docx.renderAsync(data, wrap, null, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, useBase64URL: true, experimental: true }); fit(); };
    const fit = () => { const sec = wrap.querySelector('section'); const w = sec ? sec.offsetWidth : 794; wrap.style.zoom = String(Math.min(1, fitWidth(host) / (w + 24))); };
    await render(buf); window.addEventListener('resize', fit);
    const unit = () => `${wrap.querySelectorAll('section').length || 1}쪽`;
    info(unit());
    // 편집(docx·docm): 문단 목록에서 글자 고치기 — 바뀐 글자만 넣어 글꼴·크기·색 유지
    let ed = null;
    if (/^(docx|docm)$/.test(extOf(name)) && window.KEdit && hooks && hooks.edit) { try { ed = await window.KEdit.docx(buf); } catch (e) { ed = null; } }
    if (ed) editToggle(host, wrap, ed, () => ed.groups, hooks, info, render, unit);
    return { close: () => window.removeEventListener('resize', fit), editor: ed };
  }

  // ── PowerPoint ──
  async function openPptx(host, buf, info, name, hooks) {
    await script(V + 'pptx-preview.umd.js');
    const W = fitWidth(host);
    const wrap = el('div', 'kv-pptx'); host.appendChild(wrap);
    let pv = null;
    const render = async (data) => { wrap.textContent = ''; pv = window.pptxPreview.init(wrap, { width: W, height: Math.round(W * 9 / 16), mode: 'list' }); await pv.preview(data); };
    await render(buf);
    const unit = () => `${wrap.querySelectorAll('.pptx-preview-slide-wrapper').length || ''}장`.replace(/^장$/, '');
    info(unit());
    // 편집(pptx·pptm): 슬라이드별 문단 목록에서 글자 고치기
    let ed = null;
    if (/^(pptx|pptm)$/.test(extOf(name)) && window.KEdit && hooks && hooks.edit) { try { ed = await window.KEdit.pptx(buf); } catch (e) { ed = null; } }
    if (ed) editToggle(host, wrap, ed, () => ed.slides.map((sl) => ({ label: `슬라이드 ${sl.n}`, paras: sl.paras })), hooks, info, render, unit);
    return { close: () => { try { pv && pv.destroy && pv.destroy(); } catch (e) { /* 무시 */ } }, editor: ed };
  }

  // ── 표(Excel·CSV) ──
  async function openSheet(host, buf, info, name, hooks) {
    await script(V + 'xlsx.full.min.js');
    const X = window.XLSX; const e = extOf(name);
    let wb;
    if (e === 'csv' || e === 'tsv') {   // CSV 는 한글 인코딩(EUC-KR)도 흔하다
      const u8 = new Uint8Array(buf); let txt = new TextDecoder('utf-8').decode(u8);
      if (txt.includes('�')) { try { txt = new TextDecoder('euc-kr').decode(u8); } catch (er) { /* 그대로 */ } }
      wb = X.read(txt, { type: 'string', FS: e === 'tsv' ? '\t' : undefined, raw: true });
    } else wb = X.read(new Uint8Array(buf), { type: 'array', cellDates: true });
    const tabs = el('div', 'kv-tabs'); const box = el('div', 'kv-sheet'); host.appendChild(tabs); host.appendChild(box);
    const MAXR = 3000;
    // 편집(xlsx·xlsm): 셀을 누르면 값 고치기 — 원본 XML 의 그 셀만 바꿔 저장(서식·차트 유지)
    let ed = null, cur = 0;
    if (/^(xlsx|xlsm)$/.test(e) && window.KEdit && hooks && hooks.edit) { try { ed = await window.KEdit.xlsx(buf); } catch (er) { ed = null; } }
    const paint = () => { if (!ed) return; ed.list(cur).forEach((x) => { const td = box.querySelector(`#sjs-${x.addr}`); if (td) { td.textContent = x.value; td.classList.add('kv-changed'); } }); };
    if (ed) box.addEventListener('click', (ev) => {
      const td = ev.target.closest('td'); if (!td || !td.id || !td.id.startsWith('sjs-')) return;
      ev.preventDefault(); const addr = td.id.slice(4); const ws = wb.Sheets[wb.SheetNames[cur]]; const c = ws[addr];
      const shown = c ? (c.v instanceof Date ? (c.w || String(c.v)) : String(c.v != null ? c.v : '')) : '';
      const now = ed.get(cur, addr); const val = now ? now.value : shown;
      hooks.edit({
        title: `${wb.SheetNames[cur]} · ${addr} 셀`, value: val, multiline: false,
        note: c && c.f ? `수식 칸(=${c.f})이에요 — 고치면 수식 대신 값이 들어가요` : '숫자는 숫자로, 그 밖은 글자로 저장돼요. 수식은 PC Excel 에서 열 때 다시 계산돼요',
        canRevert: !!now,
        apply: (v) => { ed.set(cur, addr, v, shown); const x = ed.get(cur, addr); td.textContent = x ? x.value : (c ? (c.w || shown) : ''); td.classList.toggle('kv-changed', !!x); hooks.changed(); },
        revert: () => { ed.set(cur, addr, shown, shown); td.textContent = c ? (c.w || shown) : ''; td.classList.remove('kv-changed'); hooks.changed(); },
      });
    });
    const show = (i) => { cur = i;
      tabs.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      const ws = wb.Sheets[wb.SheetNames[i]]; const ref = ws['!ref']; let cut = false;
      if (ref) { const r = X.utils.decode_range(ref); if (r.e.r - r.s.r + 1 > MAXR) { r.e.r = r.s.r + MAXR - 1; ws['!ref'] = X.utils.encode_range(r); cut = true; } }
      box.innerHTML = X.utils.sheet_to_html(ws, { header: '', footer: '' });
      if (ref) ws['!ref'] = ref;
      if (cut) box.appendChild(el('p', 'kv-note', `앞 ${MAXR.toLocaleString()}줄만 보여요(전체는 PC 에서 확인하세요)`));
      paint();
    };
    wb.SheetNames.forEach((n, i) => { const b = el('button', null, n); b.type = 'button'; b.onclick = () => show(i); tabs.appendChild(b); });
    tabs.hidden = wb.SheetNames.length < 2;
    show(0); info(`시트 ${wb.SheetNames.length}개`);
    return { close: () => {}, editor: ed };
  }

  // ── 이미지·영상·음성 ──
  function openMedia(host, file, kind) {
    const url = URL.createObjectURL(file);
    let m;
    if (kind === 'image') { m = el('img', 'kv-img'); m.alt = file.name; }
    else { m = el(kind, 'kv-media'); m.controls = true; m.preload = 'metadata'; if (kind === 'video') m.playsInline = true; }
    m.src = url; host.appendChild(m);
    return () => URL.revokeObjectURL(url);
  }

  // ── 텍스트(소스 그대로 — HTML 도 실행하지 않고 글자로만) ──
  function openText(host, buf, info, name) {
    const u8 = new Uint8Array(buf); const LIM = 2 * 1024 * 1024;
    let t = new TextDecoder('utf-8').decode(u8.subarray(0, LIM));
    if (t.includes('�')) { try { t = new TextDecoder('euc-kr').decode(u8.subarray(0, LIM)); } catch (e) { /* 그대로 */ } }
    if (extOf(name) === 'json') { try { t = JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* 그대로 */ } }
    const pre = el('pre', 'kv-text', t); host.appendChild(pre);
    if (u8.length > LIM) host.appendChild(el('p', 'kv-note', '앞 2MB 만 보여요'));
    info(`${t.split('\n').length.toLocaleString()}줄`);
    return () => {};
  }

  async function open(host, file, buf, onInfo, hooks) {
    const kind = kindOf(file.name, new Uint8Array(buf, 0, Math.min(8, buf.byteLength)));
    const info = onInfo || (() => {});
    host.textContent = '';
    if (!kind) throw new Error('이 형식은 아직 볼 수 없어요');
    if (kind.startsWith('old:')) throw new Error(`${OLD[kind.slice(4)]} 형식은 볼 수 없어요 — PC 에서 ${kind.slice(4) === 'ppt' ? 'pptx' : 'docx'} 로 저장해 주세요`);
    let close;
    if (kind === 'pdf') close = await openPdf(host, buf, info, file.name, hooks);
    else if (kind === 'docx') close = await openDocx(host, buf, info, file.name, hooks);
    else if (kind === 'pptx') close = await openPptx(host, buf, info, file.name, hooks);
    else if (kind === 'sheet') close = await openSheet(host, buf, info, file.name, hooks);
    else if (kind === 'text') close = openText(host, buf, info, file.name);
    else close = openMedia(host, file, kind);
    let editor = null; if (close && typeof close === 'object') { editor = close.editor || null; close = close.close; }
    return { kind, label: LABEL[kind], editor, close: () => { try { close && close(); } catch (e) { /* 무시 */ } host.textContent = ''; } };
  }

  window.KViewer = { kindOf, open, LABEL, EXT };
})();
