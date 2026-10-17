/* officeedit.js — Excel(xlsx) 셀 값 · PowerPoint(pptx) 글자를 휴대폰 안에서 고쳐 저장한다(서버로 보내지 않음).
 * 한글(hwpx)과 같은 방식: 고친 셀·문단의 XML 만 바꾸고 나머지 항목(서식·차트·그림·다른 시트/슬라이드)은 원래 압축 바이트 그대로 옮긴다.
 * - Excel: 숫자는 <v>, 글자는 inlineStr 로 넣고 셀 서식(s)은 유지. 수식 칸을 고치면 값으로 바뀐다. 휴대폰은 수식을 다시 계산하지 못하므로
 *   workbook 에 fullCalcOnLoad 를 켜고 calcChain 을 지워 PC Excel 이 열 때 다시 계산하게 한다.
 * - PowerPoint: 문단(a:p) 안 글자(a:t)에서 바뀐 부분만 바꿔 글꼴·색·위치를 유지한다. 줄(a:br) 수는 그대로여야 한다.
 * window.KEdit = { xlsx(buf) → editor, pptx(buf) → editor }   editor = { ext, mime, count(), save() → Blob, … }
 */
(function () {
  'use strict';
  const dec = new TextDecoder('utf-8'), enc = new TextEncoder();
  const PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const parse = (s, name) => { const x = new DOMParser().parseFromString(s, 'application/xml'); if (x.getElementsByTagName('parsererror').length) throw new Error(`문서를 읽지 못했어요(${name})`); return x; };
  const ser = (x) => PROLOG + new XMLSerializer().serializeToString(x.documentElement);
  const kids = (el, local) => Array.from(el.children).filter((c) => c.localName === local);
  const all = (el, local) => Array.from(el.getElementsByTagNameNS('*', local));

  async function loadZip(buf) {
    const Z = window.HWPX.zip; const entries = Z.readZip(buf); const byName = new Map(entries.map((e) => [e.name, e]));
    const text = async (n) => { const e = byName.get(n); return e ? dec.decode(await Z.entryBytes(e)) : null; };
    // 고친 항목(out)만 새 내용으로, 지울 항목(drop)은 빼고 다시 묶는다
    const pack = (out, drop) => Z.writeZip(entries.filter((e) => !(drop && drop.has(e.name))).map((e) => (out.has(e.name) ? { name: e.name, data: enc.encode(out.get(e.name)) } : e)));
    return { entries, byName, text, pack };
  }
  // 관계 파일(_rels) → { Id: 'xl/worksheets/sheet1.xml' }
  async function rels(z, base, relsPath) {
    const s = await z.text(relsPath); const map = {}; if (!s) return map;
    for (const r of all(parse(s, relsPath), 'Relationship')) {
      let t = r.getAttribute('Target') || ''; if (r.getAttribute('TargetMode') === 'External') continue;
      t = t.startsWith('/') ? t.slice(1) : base + t.replace(/^\.\//, '');
      while (/[^/]+\/\.\.\//.test(t)) t = t.replace(/[^/]+\/\.\.\//, '');
      map[r.getAttribute('Id')] = { target: t, type: r.getAttribute('Type') || '', el: r };
    }
    return map;
  }

  // ── Excel ──
  const colNum = (s) => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const NUM = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
  const NUM_COMMA = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  async function xlsx(buf) {
    const z = await loadZip(buf);
    const wbText = await z.text('xl/workbook.xml'); if (!wbText) throw new Error('Excel 통합 문서가 아니에요');
    const wb = parse(wbText, 'workbook.xml'); const wbRels = await rels(z, 'xl/', 'xl/_rels/workbook.xml.rels');
    const sheets = all(wb, 'sheet').map((s) => { const rid = s.getAttributeNS(R_NS, 'id') || s.getAttribute('r:id'); return { name: s.getAttribute('name'), path: (wbRels[rid] || {}).target }; });
    const edits = new Map();   // '시트번호!주소' → { si, addr, value, orig }
    function setCell(doc, addr, value) {
      const sd = all(doc, 'sheetData')[0]; if (!sd) throw new Error('시트 내용을 찾지 못했어요');
      const NS = sd.namespaceURI, pre = sd.prefix; const mk = (n) => doc.createElementNS(NS, pre ? `${pre}:${n}` : n);
      const m = addr.match(/^([A-Z]+)(\d+)$/); const rn = +m[2], cn = colNum(m[1]);
      let row = kids(sd, 'row').find((r) => +r.getAttribute('r') === rn);
      if (!row) { row = mk('row'); row.setAttribute('r', String(rn)); const after = kids(sd, 'row').find((r) => +r.getAttribute('r') > rn); sd.insertBefore(row, after || null); }
      let c = kids(row, 'c').find((x) => x.getAttribute('r') === addr);
      if (!c) { c = mk('c'); c.setAttribute('r', addr); const after = kids(row, 'c').find((x) => colNum((x.getAttribute('r') || 'A').replace(/\d+/g, '')) > cn); row.insertBefore(c, after || null); row.removeAttribute('spans'); }
      for (const n of ['f', 'v', 'is']) kids(c, n).forEach((e) => c.removeChild(e));
      const v = String(value);
      if (v === '') { c.removeAttribute('t'); return; }
      const num = NUM.test(v.trim()) ? v.trim() : NUM_COMMA.test(v.trim()) ? v.trim().replace(/,/g, '') : null;
      if (num != null) { c.removeAttribute('t'); const e = mk('v'); e.textContent = num; c.appendChild(e); return; }
      c.setAttribute('t', 'inlineStr'); const is = mk('is'), t = mk('t');
      if (/^\s|\s$|\n/.test(v)) t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
      t.textContent = v; is.appendChild(t); c.appendChild(is);
    }
    return {
      kind: 'xlsx', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sheets,
      count: () => edits.size,
      get: (si, addr) => edits.get(`${si}!${addr}`),
      list: (si) => Array.from(edits.values()).filter((e) => e.si === si),
      set(si, addr, value, orig) {
        const k = `${si}!${addr}`; const o = edits.has(k) ? edits.get(k).orig : orig;
        if (String(value) === String(o)) edits.delete(k); else edits.set(k, { si, addr, value: String(value), orig: o });
      },
      async save() {
        const out = new Map(); const bySheet = new Map();
        for (const e of edits.values()) { if (!bySheet.has(e.si)) bySheet.set(e.si, []); bySheet.get(e.si).push(e); }
        for (const [si, list] of bySheet) {
          const path = sheets[si] && sheets[si].path; const s = path && await z.text(path); if (!s) throw new Error(`시트를 찾지 못했어요: ${sheets[si] ? sheets[si].name : si}`);
          const doc = parse(s, path); list.forEach((e) => setCell(doc, e.addr, e.value)); out.set(path, ser(doc));
        }
        // PC Excel 이 열 때 수식을 다시 계산하도록
        const w = parse(wbText, 'workbook.xml'); let calc = all(w, 'calcPr')[0];
        if (!calc) {
          const root = w.documentElement; calc = w.createElementNS(root.namespaceURI, root.prefix ? `${root.prefix}:calcPr` : 'calcPr');
          const after = ['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst'].map((n) => kids(root, n)[0]).find(Boolean);
          root.insertBefore(calc, after || null);
        }
        calc.setAttribute('fullCalcOnLoad', '1'); out.set('xl/workbook.xml', ser(w));
        // 계산 순서 기록(calcChain)은 지운다 — 수식이 값으로 바뀐 칸이 있으면 Excel 이 '복구' 를 묻기 때문(열 때 다시 만든다)
        const drop = new Set();
        if (z.byName.has('xl/calcChain.xml')) {
          drop.add('xl/calcChain.xml');
          const ct = parse(await z.text('[Content_Types].xml'), 'Content_Types'); all(ct, 'Override').filter((o) => o.getAttribute('PartName') === '/xl/calcChain.xml').forEach((o) => o.parentNode.removeChild(o)); out.set('[Content_Types].xml', ser(ct));
          const rt = parse(await z.text('xl/_rels/workbook.xml.rels'), 'rels'); all(rt, 'Relationship').filter((r) => /calcChain/.test(r.getAttribute('Type') || '')).forEach((r) => r.parentNode.removeChild(r)); out.set('xl/_rels/workbook.xml.rels', ser(rt));
        }
        return z.pack(out, drop);
      },
    };
  }

  // ── 문단 글자(PowerPoint·Word 공용) ──
  // 문단 하나의 글자: 글자 노드(t)와 나눔표(줄 바꿈 \n · 탭 \t)를 차례대로. cfg.wrap = 안으로 들어가 볼 요소, cfg.seps = 나눔표 요소
  const PPT = { wrap: ['r', 'fld'], seps: { br: '\n' } };
  const DOC = { wrap: ['r', 'hyperlink', 'ins', 'smartTag', 'sdt', 'sdtContent', 'customXml', 'fldSimple', 'moveTo'], seps: { br: '\n', cr: '\n', tab: '\t' } };
  function paraItems(p, cfg) {
    const c0 = cfg || PPT; const items = [];
    const walk = (el) => { for (const c of Array.from(el.children)) { if (c.localName === 't') items.push({ t: c }); else if (c0.seps[c.localName]) items.push({ sep: c0.seps[c.localName] }); else if (c0.wrap.includes(c.localName)) walk(c); } };
    walk(p); return items;
  }
  const paraText = (p, cfg) => paraItems(p, cfg).map((i) => (i.sep || i.t.textContent)).join('');
  // 글자 노드들에서 바뀐 가운데 부분만 바꾼다(앞·뒤 같은 부분과 글자 모양은 그대로)
  function replaceIn(ts, next) {
    const olds = ts.map((t) => t.textContent); const old = olds.join('');
    if (old === next || !ts.length) return;
    let a = 0; while (a < old.length && a < next.length && old[a] === next[a]) a++;
    let b = 0; while (b < old.length - a && b < next.length - a && old[old.length - 1 - b] === next[next.length - 1 - b]) b++;
    const mid = next.slice(a, next.length - b), cutEnd = old.length - b;
    // 가운데 글자를 넣을 노드: 위치 a 를 품은 첫 노드(끝이면 마지막 노드)
    let ins = ts.length - 1; for (let i = 0, st = 0; i < ts.length; st += olds[i].length, i++) if (a < st + olds[i].length) { ins = i; break; }
    ts.forEach((t, i) => {
      const s = olds[i], st = olds.slice(0, i).join('').length;
      const l = Math.min(Math.max(a - st, 0), s.length), r = Math.min(Math.max(cutEnd - st, 0), s.length);
      const ns = s.slice(0, l) + (i === ins ? mid : '') + s.slice(Math.max(l, r));
      if (ns !== s) { t.textContent = ns; if (/^\s|\s$/.test(ns)) t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); }
    });
  }
  function setParaText(p, next, cfg) {
    const items = paraItems(p, cfg); const segs = [[]]; const seps = [];
    items.forEach((i) => { if (i.sep) { seps.push(i.sep); segs.push([]); } else segs[segs.length - 1].push(i.t); });
    // 새 글자도 같은 나눔표(줄 바꿈·탭)로 나눈다 — 나눔표 수·순서는 그대로여야 한다
    const parts = next.split(/(\n|\t)/); let lines = parts.filter((_, k) => k % 2 === 0); const nseps = parts.filter((_, k) => k % 2 === 1);
    if (nseps.join('') !== seps.join('')) {
      if (!seps.length) lines = [next.replace(/[\n\t]+/g, ' ')];   // 나눔표 없는 문단: 엔터·탭은 띄어쓰기로
      else throw new Error(`이 문단의 줄 바꿈·탭(${seps.length}개)은 그대로 두고 고쳐 주세요`);
    }
    segs.forEach((ts, i) => {
      if (!ts.length && lines[i]) throw new Error('빈 칸에는 글자를 넣을 수 없어요(PC 에서 고쳐 주세요)');
      replaceIn(ts, lines[i]);
    });
  }
  async function pptx(buf) {
    const z = await loadZip(buf);
    const pt = await z.text('ppt/presentation.xml'); if (!pt) throw new Error('PowerPoint 문서가 아니에요');
    const pres = parse(pt, 'presentation.xml'); const pr = await rels(z, 'ppt/', 'ppt/_rels/presentation.xml.rels');
    const slides = [];
    for (const s of all(pres, 'sldId')) {
      const rid = s.getAttributeNS(R_NS, 'id') || s.getAttribute('r:id'); const path = (pr[rid] || {}).target; const xt = path && await z.text(path);
      if (!xt) continue;
      const doc = parse(xt, path);
      const paras = all(doc, 'p').filter((p) => p.namespaceURI && /drawingml/.test(p.namespaceURI)).map((p) => ({ p, orig: paraText(p) })).filter((x) => x.orig.trim());
      slides.push({ n: slides.length + 1, path, doc, paras, dirty: false });
    }
    let changed = 0; const recount = () => { changed = slides.reduce((n, s) => n + s.paras.filter((x) => paraText(x.p) !== x.orig).length, 0); };
    return {
      kind: 'pptx', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', slides,
      count: () => changed,
      text: (si, pi) => paraText(slides[si].paras[pi].p),
      isChanged: (si, pi) => paraText(slides[si].paras[pi].p) !== slides[si].paras[pi].orig,
      set(si, pi, next) { const s = slides[si]; setParaText(s.paras[pi].p, next); s.dirty = true; recount(); },
      revert(si, pi) { const s = slides[si]; const x = s.paras[pi]; setParaText(x.p, x.orig); s.dirty = true; recount(); },
      async save() { const out = new Map(); slides.filter((s) => s.dirty).forEach((s) => out.set(s.path, ser(s.doc))); return z.pack(out); },
    };
  }

  // ── Word ── word/document.xml 의 문단(w:p, 표 칸·글상자 포함). 지워진 글자(w:del)·필드 코드(w:instrText)는 건드리지 않는다
  async function docx(buf) {
    const z = await loadZip(buf);
    const path = 'word/document.xml'; const xt = await z.text(path); if (!xt) throw new Error('Word 문서가 아니에요');
    const doc = parse(xt, path);
    const paras = all(doc, 'p').filter((p) => p.namespaceURI && /wordprocessingml/.test(p.namespaceURI) && !all(p, 'p').length)
      .map((p) => ({ p, orig: paraText(p, DOC) })).filter((x) => x.orig.trim());
    let dirty = false, changed = 0; const recount = () => { changed = paras.filter((x) => paraText(x.p, DOC) !== x.orig).length; };
    return {
      kind: 'docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      groups: [{ label: '본문', paras }],
      count: () => changed,
      text: (gi, pi) => paraText(paras[pi].p, DOC),
      isChanged: (gi, pi) => paraText(paras[pi].p, DOC) !== paras[pi].orig,
      set(gi, pi, next) { setParaText(paras[pi].p, next, DOC); dirty = true; recount(); },
      revert(gi, pi) { setParaText(paras[pi].p, paras[pi].orig, DOC); dirty = true; recount(); },
      async save() { const out = new Map(); if (dirty) out.set(path, ser(doc)); return z.pack(out); },
    };
  }

  window.KEdit = { xlsx, pptx, docx, _setParaText: setParaText, _paraText: paraText, PPT, DOC };
})();
