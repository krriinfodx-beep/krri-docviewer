/* hwpx.js — 휴대폰 브라우저에서 hwpx 를 열고 문단·표 칸의 글자만 고쳐 다시 저장한다(서버로 보내지 않음).
 * window.HWPX = { open(arrayBuffer) → doc, paraText(p), setParaText(doc, p, text), save(doc) → Blob }
 * - 압축: 브라우저 내장 DecompressionStream/CompressionStream('deflate-raw'). 고치지 않은 항목은 원래 압축 바이트를 그대로 옮긴다.
 * - 편집 단위는 문단(hp:p). 그 문단 바로 아래 글자(hp:run > hp:t)만 바꾸고 표·그림·글상자·머리말 같은 개체는 건드리지 않는다.
 *   바뀐 글자만 그 자리의 글자 묶음에 넣으므로 서식(굵게·색)은 유지된다. 고친 문단의 줄 배치 정보(hp:linesegarray)는 지워 한글이 다시 계산하게 한다.
 */
(function () {
  'use strict';
  const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const dec = new TextDecoder('utf-8'), enc = new TextEncoder();

  // ── zip 읽기·쓰기 ─────────────────────────────────────────────
  let CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function streamBytes(u8, stream) { const r = new Response(new Blob([u8]).stream().pipeThrough(stream)); return new Uint8Array(await r.arrayBuffer()); }
  function readZip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('hwpx(zip) 파일이 아니에요');
    const n = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip 목록이 깨졌어요');
      const flags = dv.getUint16(off + 8, true), method = dv.getUint16(off + 10, true), time = dv.getUint16(off + 12, true), date = dv.getUint16(off + 14, true);
      const crc = dv.getUint32(off + 16, true), csize = dv.getUint32(off + 20, true), usize = dv.getUint32(off + 24, true);
      const nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
      const name = dec.decode(u8.subarray(off + 46, off + 46 + nl));   // 한글 hwpx 항목 이름은 영문
      const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnl + lxl;
      out.push({ name, method, crc, csize, usize, time, date, raw: u8.subarray(start, start + csize) });
      off += 46 + nl + xl + cl;
    }
    return out;
  }
  async function entryBytes(e) {
    if (e.method === 0) return e.raw;
    if (e.method === 8) return streamBytes(e.raw, new DecompressionStream('deflate-raw'));
    throw new Error(`지원하지 않는 압축 방식(${e.method}): ${e.name}`);
  }
  async function writeZip(entries) {   // entries: [{name, data?:Uint8Array(새 내용) | 원래 항목(raw)}]
    const parts = [], central = []; let off = 0;
    const now = new Date(); const t = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1); const d = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const e of entries) {
      let method, crc, usize, raw, time = e.time, date = e.date;
      if (e.data) {   // 새 내용: mimetype 은 무압축, 나머지는 deflate(안 되면 무압축)
        crc = crc32(e.data); usize = e.data.length; time = t; date = d;
        if (e.name !== 'mimetype' && typeof CompressionStream === 'function') { try { raw = await streamBytes(e.data, new CompressionStream('deflate-raw')); method = 8; } catch (err) { raw = e.data; method = 0; } }
        else { raw = e.data; method = 0; }
      } else { method = e.method; crc = e.crc; usize = e.usize; raw = e.raw; }
      const name = enc.encode(e.name);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, raw.length, true); h.setUint32(22, usize, true);
      h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, raw);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, raw.length, true); c.setUint32(24, usize, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + raw.length;
    }
    const cs = central.reduce((a, b) => a + b.length, 0);
    const z = new DataView(new ArrayBuffer(22));
    z.setUint32(0, 0x06054b50, true); z.setUint16(8, entries.length, true); z.setUint16(10, entries.length, true); z.setUint32(12, cs, true); z.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(z.buffer)], { type: 'application/hwp+zip' });
  }

  // ── 문서 ──────────────────────────────────────────────────
  const prologOf = (s) => { const m = s.match(/^\s*<\?xml[^>]*\?>/); return m ? m[0].trim() : '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'; };
  function parseXml(s, name) {
    const x = new DOMParser().parseFromString(s, 'application/xml');
    if (x.getElementsByTagName('parsererror').length) throw new Error(`XML 을 읽지 못했어요: ${name}`);
    return x;
  }
  const kids = (el, local) => Array.from(el.children).filter((c) => c.localName === local);
  const attr = (el, n) => (el ? el.getAttribute(n) : null);

  async function open(buf) {
    const entries = readZip(buf);
    const byName = new Map(entries.map((e) => [e.name, e]));
    const mt = byName.get('mimetype');
    if (!mt || !dec.decode(await entryBytes(mt)).includes('hwp')) throw new Error('hwpx 문서가 아니에요(한글에서 「다른 이름으로 저장 → hwpx」로 바꿔 주세요)');
    const secNames = entries.map((e) => e.name).filter((n) => /^Contents\/section\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (!secNames.length) throw new Error('본문(section)이 없어요');
    const sections = [];
    for (const n of secNames) {
      const s = dec.decode(await entryBytes(byName.get(n))); const xml = parseXml(s, n);
      // 용지(보기용): 첫 pagePr 의 폭·높이·여백(HWPUNIT = 1/7200 인치). 본문 위·아래는 여백 + 머리말·꼬리말 칸
      const pp = xml.getElementsByTagNameNS('*', 'pagePr')[0]; const mg = pp && pp.getElementsByTagNameNS('*', 'margin')[0];
      const num = (el, k, d) => { const v = parseInt(attr(el, k), 10); return isFinite(v) ? v : d; };
      const page = { w: num(pp, 'width', 59528), h: num(pp, 'height', 84186), ml: num(mg, 'left', 8504), mr: num(mg, 'right', 8504), mt: num(mg, 'top', 5668) + num(mg, 'header', 4252), mb: num(mg, 'bottom', 4252) + num(mg, 'footer', 4252) };
      sections.push({ name: n, prolog: prologOf(s), xml, dirty: false, page });
    }
    // 글자·문단·테두리 모양(보기용 — 한글 문서처럼 보이게): 글꼴·크기·굵게·색·자간, 정렬·줄 간격·여백·들여쓰기, 칸 테두리·배경
    const style = { chars: {}, paras: {}, borders: {} };
    const hd = byName.get('Contents/header.xml'); let header = null;
    if (hd) {
      try {
        const htxt = dec.decode(await entryBytes(hd)); const hx = parseXml(htxt, 'header.xml');
        header = { name: 'Contents/header.xml', prolog: prologOf(htxt), xml: hx, dirty: false };
        const fontsByLang = {};   // 언어(HANGUL·LATIN…)별 글꼴 목록 [{id, face}]
        for (const ff of hx.getElementsByTagNameNS('*', 'fontface')) fontsByLang[attr(ff, 'lang')] = kids(ff, 'font').map((f) => ({ id: attr(f, 'id'), face: attr(f, 'face') || '' }));
        style.fontsByLang = fontsByLang;
        const first = (el, local) => el.getElementsByTagNameNS('*', local)[0] || null;
        for (const c of hx.getElementsByTagNameNS('*', 'charPr')) style.chars[attr(c, 'id')] = readCharPr(c, fontsByLang);
        for (const p of hx.getElementsByTagNameNS('*', 'paraPr')) style.paras[attr(p, 'id')] = readParaPr(p);
        for (const b of hx.getElementsByTagNameNS('*', 'borderFill')) {
          const side = (k) => { const e = first(b, k); return e ? { type: attr(e, 'type') || 'NONE', width: parseFloat(attr(e, 'width')) || 0.1, color: attr(e, 'color') || '#000000' } : { type: 'NONE' }; };
          const wb = first(b, 'winBrush'); const fc = attr(wb, 'faceColor');
          const ib = first(b, 'imgBrush'); const gr = first(b, 'gradation');   // 칸 배경: 그림 채우기(제목 띠 등)·그러데이션
          const grad = gr ? { angle: parseInt(attr(gr, 'angle'), 10) || 0, type: attr(gr, 'type') || 'LINEAR', colors: Array.from(gr.getElementsByTagNameNS('*', 'color')).map((c) => attr(c, 'value')).filter((v) => /^#[0-9a-f]{6}$/i.test(v || '')) } : null;
          style.borders[attr(b, 'id')] = { left: side('leftBorder'), right: side('rightBorder'), top: side('topBorder'), bottom: side('bottomBorder'), fill: fc && fc !== 'none' && /^#[0-9a-f]{6}$/i.test(fc) ? fc : '',
            img: ib ? attr(first(ib, 'img'), 'binaryItemIDRef') || '' : '', imgMode: ib ? attr(ib, 'mode') || 'TOTAL' : '', grad: grad && grad.colors.length > 1 ? grad : null };
        }
      } catch (e) { /* 보기용이라 실패해도 연다 */ }
    }
    // 그림: content.hpf 의 id → BinData 경로
    const images = {};
    const hpf = byName.get('Contents/content.hpf');
    if (hpf) {
      try {
        const px = parseXml(dec.decode(await entryBytes(hpf)), 'content.hpf');
        for (const it of px.getElementsByTagNameNS('*', 'item')) { const href = attr(it, 'href'); if (href && byName.has(href)) images[attr(it, 'id')] = { href, type: attr(it, 'media-type') || '' }; }
      } catch (e) { /* 그림 없이 연다 */ }
    }
    return { entries, byName, sections, style, images, header, paras: [] };
  }
  // 문단 모양(paraPr) 읽기 — 값은 첫 hh:margin(hp:case, 2016 판) 기준. hp:default(옛 판 호환) 쪽은 같은 뜻을 2배 값으로 적는다(실측: 1500 ↔ 3000)
  function readParaPr(p) {
    const first = (el, local) => el.getElementsByTagNameNS('*', local)[0] || null;
    const a = first(p, 'align'), ls = first(p, 'lineSpacing'), m = first(p, 'margin');
    const mv = (k) => { const e = m && Array.from(m.children).find((x) => x.localName === k); return e ? parseInt(attr(e, 'value'), 10) || 0 : 0; };
    return { align: attr(a, 'horizontal') || 'JUSTIFY', lineType: attr(ls, 'type') || 'PERCENT', lineValue: parseInt(attr(ls, 'value'), 10) || 160,
      intent: mv('intent'), left: mv('left'), right: mv('right'), prev: mv('prev'), next: mv('next') };
  }
  // 글자 모양(charPr) 읽기 — 글꼴은 한글(HANGUL) 글꼴 이름, 자간·장평은 한글 값
  function readCharPr(c, fontsByLang) {
    const first = (el, local) => el.getElementsByTagNameNS('*', local)[0] || null;
    const ul = first(c, 'underline'); const fr = first(c, 'fontRef');
    const hf = ((fontsByLang || {}).HANGUL || []).find((f) => f.id === attr(fr, 'hangul'));
    return { size: (parseInt(attr(c, 'height'), 10) || 1000) / 100, bold: kids(c, 'bold').length > 0, italic: kids(c, 'italic').length > 0, color: attr(c, 'textColor') || '#000000',
      underline: !!ul && !!attr(ul, 'type') && attr(ul, 'type') !== 'NONE', font: hf ? hf.face : '', fontId: attr(fr, 'hangul') || '',
      spacing: parseInt(attr(first(c, 'spacing'), 'hangul'), 10) || 0, ratio: parseInt(attr(first(c, 'ratio'), 'hangul'), 10) || 100 };
  }
  const charPrEl = (doc, id) => Array.from(doc.header.xml.getElementsByTagNameNS('*', 'charPr')).find((e) => attr(e, 'id') === String(id)) || null;
  const LANG = { hangul: 'HANGUL', latin: 'LATIN', hanja: 'HANJA', japanese: 'JAPANESE', other: 'OTHER', symbol: 'SYMBOL', user: 'USER' };
  // 원래 글자 모양을 복제해 바꿀 값(ch)만 적용 → 새 번호. ch = {size, spacing, ratio, bold, italic, underline, color, font}(바꿀 것만)
  function cloneCharPr(doc, srcId, ch) {
    const src = charPrEl(doc, srcId); if (!src) throw new Error('글자 모양을 찾지 못했어요');
    const list = src.parentNode; const all = kids(list, 'charPr');
    const id = String(Math.max(...all.map((e) => parseInt(attr(e, 'id'), 10) || 0)) + 1);
    const el = src.cloneNode(true); el.setAttribute('id', id); list.appendChild(el);
    if (list.hasAttribute('itemCnt')) list.setAttribute('itemCnt', String(kids(list, 'charPr').length));
    const x = el.ownerDocument; const pre = (kids(el, 'underline')[0] || el).prefix || 'hh'; const NSH = el.namespaceURI;
    const sub = (local) => kids(el, local)[0];
    if (ch.size != null) el.setAttribute('height', String(Math.round(ch.size * 100)));
    if (ch.color) el.setAttribute('textColor', ch.color.toUpperCase());
    const allLangs = (local, v) => { const e = sub(local); if (e) for (const k of Object.keys(LANG)) if (e.hasAttribute(k)) e.setAttribute(k, String(Math.round(v))); };
    if (ch.spacing != null) allLangs('spacing', ch.spacing);
    if (ch.ratio != null) allLangs('ratio', ch.ratio);
    if (ch.font) {   // 언어마다 같은 이름 글꼴이 있으면 그 번호로(없으면 그 언어는 그대로)
      const fr = sub('fontRef');
      if (fr) for (const [k, L] of Object.entries(LANG)) { const f = ((doc.style.fontsByLang || {})[L] || []).find((q) => q.face === ch.font); if (f && fr.hasAttribute(k)) fr.setAttribute(k, f.id); }
    }
    // 굵게·기울임: 요소가 있으면 켜짐. 순서 offset → italic → bold → underline 을 지킨다
    const place = (local, on, beforeList) => {
      kids(el, local).forEach((e) => el.removeChild(e));
      if (!on) return;
      const ne = x.createElementNS(NSH, `${pre}:${local}`);
      const ref = beforeList.map((l) => sub(l)).find(Boolean);
      if (ref) el.insertBefore(ne, ref); else el.appendChild(ne);
    };
    if (ch.italic != null) place('italic', ch.italic, ['bold', 'underline', 'strikeout', 'outline', 'shadow']);
    if (ch.bold != null) place('bold', ch.bold, ['underline', 'strikeout', 'outline', 'shadow']);
    if (ch.underline != null) {
      let u = sub('underline');
      if (!u) { u = x.createElementNS(NSH, `${pre}:underline`); u.setAttribute('shape', 'SOLID'); u.setAttribute('color', '#000000'); const ref = ['strikeout', 'outline', 'shadow'].map(sub).find(Boolean); if (ref) el.insertBefore(u, ref); else el.appendChild(u); }
      u.setAttribute('type', ch.underline ? 'BOTTOM' : 'NONE');
    }
    doc.style.chars[id] = readCharPr(el, doc.style.fontsByLang);
    doc.header.dirty = true;
    return id;
  }
  // 글자 모양 바꾸기. range = null(문단 전체) | [시작, 끝)(paraText 글자 위치). 걸치는 글자 묶음(run)은 나눠서 그 부분만 새 모양으로
  function setCharShape(doc, p, range, ch) {
    if (!doc.header) throw new Error('글자 모양 정보(header.xml)가 없어요');
    const cache = new Map(); const nid = (orig) => { if (!cache.has(orig)) cache.set(orig, cloneCharPr(doc, orig, ch)); return cache.get(orig); };
    const runs = kids(p, 'run'); let n = 0;
    if (!range) {
      for (const r of runs) if (kids(r, 't').length) { r.setAttribute('charPrIDRef', nid(attr(r, 'charPrIDRef'))); n++; }
    } else {
      const [A, B] = range; let pos = 0; const x = p.ownerDocument;
      for (const run of runs) {
        // run 안 글자를 낱자(글자 또는 tab·lineBreak 요소)로 펼쳐 범위 안/밖을 표시
        const items = [];   // {kind:'tok', t, v(문자|요소), in} | {kind:'node', node}
        for (const c of Array.from(run.childNodes)) {
          if (c.nodeType === 1 && c.localName === 't') {
            for (const nd of Array.from(c.childNodes)) {
              if (nd.nodeType === 3) for (const chv of Array.from(nd.nodeValue)) { const i = pos; pos += chv.length; items.push({ kind: 'tok', t: c, v: chv, in: i >= A && i < B }); }
              else if (nd.nodeType === 1) { const i = pos; pos += 1; items.push({ kind: 'tok', t: c, v: nd, in: i >= A && i < B }); }
            }
            if (!c.childNodes.length) items.push({ kind: 'empty', t: c });
          } else items.push({ kind: 'node', node: c });
        }
        const toks = items.filter((i) => i.kind === 'tok');
        if (!toks.some((i) => i.in)) continue;
        if (toks.every((i) => i.in)) { run.setAttribute('charPrIDRef', nid(attr(run, 'charPrIDRef'))); n++; continue; }
        // 나누기: 같은 안/밖이 이어지는 묶음마다 새 run
        const orig = attr(run, 'charPrIDRef'); const groups = []; let cur = null;
        for (const it of items) {
          const flag = it.kind === 'tok' ? it.in : (cur ? cur.in : false);
          if (!cur || cur.in !== flag) { cur = { in: flag, parts: [] }; groups.push(cur); }
          cur.parts.push(it);
        }
        for (const g of groups) {
          const nr = run.cloneNode(false); nr.setAttribute('charPrIDRef', g.in ? nid(orig) : orig);
          let t = null, tSrc = null;
          for (const it of g.parts) {
            if (it.kind === 'node') { nr.appendChild(it.node); t = null; continue; }
            if (it.kind === 'empty') continue;
            if (!t || tSrc !== it.t) { t = it.t.cloneNode(false); tSrc = it.t; nr.appendChild(t); }
            if (typeof it.v === 'string') { const last = t.lastChild; if (last && last.nodeType === 3) last.nodeValue += it.v; else t.appendChild(x.createTextNode(it.v)); }
            else t.appendChild(it.v.cloneNode(true));
          }
          run.parentNode.insertBefore(nr, run);
        }
        run.parentNode.removeChild(run); n++;
      }
    }
    kids(p, 'linesegarray').forEach((l) => p.removeChild(l));
    const sec = doc.sections.find((q) => q.xml === p.ownerDocument); if (sec) sec.dirty = true;
    return n;
  }
  // 용지 여백(mm). 구역(section)마다 첫 pagePr 의 margin(HWPUNIT = 1/7200 인치)
  const MM = 7200 / 25.4;
  function pageMarginEl(sec) { const pp = sec.xml.getElementsByTagNameNS('*', 'pagePr')[0]; return pp ? pp.getElementsByTagNameNS('*', 'margin')[0] || null : null; }
  function pageMargins(doc, exact) {
    const m = pageMarginEl(doc.sections[0]); const v = (k) => { const x = (parseInt(attr(m, k), 10) || 0) / MM; return exact ? x : Math.round(x * 10) / 10; };
    return m ? { top: v('top'), bottom: v('bottom'), left: v('left'), right: v('right'), header: v('header'), footer: v('footer') } : null;
  }
  function setPageMargins(doc, mm) {
    let n = 0;
    for (const sec of doc.sections) {
      const m = pageMarginEl(sec); if (!m) continue;
      for (const k of ['top', 'bottom', 'left', 'right', 'header', 'footer']) if (mm[k] != null) m.setAttribute(k, String(Math.round(mm[k] * MM)));
      const num = (k) => parseInt(attr(m, k), 10) || 0;
      sec.page = Object.assign({}, sec.page, { ml: num('left'), mr: num('right'), mt: num('top') + num('header'), mb: num('bottom') + num('footer') });
      // 줄 배치가 모두 바뀌므로 이 구역의 줄 배치 정보는 지워 한글이 다시 계산
      Array.from(sec.xml.getElementsByTagNameNS('*', 'linesegarray')).forEach((l) => l.parentNode.removeChild(l));
      sec.dirty = true; n++;
    }
    return n;
  }
  const paraPrEl = (doc, id) => Array.from(doc.header.xml.getElementsByTagNameNS('*', 'paraPr')).find((e) => attr(e, 'id') === String(id)) || null;
  // 화면용 모양(pt): 1pt = 100(hp:case 값)
  function paraShape(doc, p) {
    const id = attr(p, 'paraPrIDRef'); const r = doc.style.paras[id] || readParaPr(paraPrEl(doc, id) || doc.header.xml.createElement('x'));
    return { id, align: r.align, line: r.lineType === 'PERCENT' ? r.lineValue : 160, lineType: r.lineType, left: r.left / 100, right: r.right / 100, intent: r.intent / 100, prev: r.prev / 100, next: r.next / 100 };
  }
  // 모양 값을 paraPr 요소에 쓴다(hp:case 는 1배, hp:default 는 2배)
  function writeParaPr(el, sh) {
    const a = el.getElementsByTagNameNS('*', 'align')[0]; if (a && sh.align) a.setAttribute('horizontal', sh.align);
    for (const ls of el.getElementsByTagNameNS('*', 'lineSpacing')) { if (sh.line != null) { ls.setAttribute('type', 'PERCENT'); ls.setAttribute('value', String(Math.round(sh.line))); } }
    for (const m of el.getElementsByTagNameNS('*', 'margin')) {
      const f = m.parentElement && m.parentElement.localName === 'default' ? 2 : 1;
      for (const c of m.children) { const k = c.localName; if (['intent', 'left', 'right', 'prev', 'next'].includes(k) && sh[k] != null) c.setAttribute('value', String(Math.round(sh[k] * 100 * f))); }
    }
  }
  // 문단 모양 바꾸기. mode 'this' = 이 문단(들)만(모양을 복제해 새 번호) · 'same' = 같은 모양을 쓰는 문단 모두(그 모양 자체를 고침)
  function setParaShape(doc, paras, sh, mode) {
    if (!doc.header) throw new Error('문단 모양 정보(header.xml)가 없어요');
    const id = attr(paras[0], 'paraPrIDRef'); const src = paraPrEl(doc, id); if (!src) throw new Error('문단 모양을 찾지 못했어요');
    let target = src, newId = id;
    if (mode !== 'same') {
      const all = Array.from(doc.header.xml.getElementsByTagNameNS('*', 'paraPr'));
      newId = String(Math.max(...all.map((e) => parseInt(attr(e, 'id'), 10) || 0)) + 1);
      target = src.cloneNode(true); target.setAttribute('id', newId); src.parentNode.appendChild(target);
      const list = src.parentNode; if (list.hasAttribute('itemCnt')) list.setAttribute('itemCnt', String(kids(list, 'paraPr').length));
    }
    writeParaPr(target, sh);
    doc.style.paras[newId] = readParaPr(target);
    doc.header.dirty = true;
    // 영향을 받는 문단: 줄 배치 정보는 지워 한글이 다시 계산
    const touched = mode === 'same' ? doc.sections.flatMap((s) => Array.from(s.xml.getElementsByTagNameNS('*', 'p')).filter((q) => attr(q, 'paraPrIDRef') === id)) : paras;
    for (const q of touched) {
      if (mode !== 'same') q.setAttribute('paraPrIDRef', newId);
      kids(q, 'linesegarray').forEach((l) => q.removeChild(l));
      const sec = doc.sections.find((s) => s.xml === q.ownerDocument); if (sec) sec.dirty = true;
    }
    return { id: newId, count: touched.length };
  }
  const countSameShape = (doc, p) => { const id = attr(p, 'paraPrIDRef'); return doc.sections.reduce((n, s) => n + Array.from(s.xml.getElementsByTagNameNS('*', 'p')).filter((q) => attr(q, 'paraPrIDRef') === id).length, 0); };
  async function imageUrl(doc, id) {
    const im = doc.images[id]; if (!im) return '';
    if (!im.url) { const b = await entryBytes(doc.byName.get(im.href)); im.url = URL.createObjectURL(new Blob([b], { type: im.type || 'image/png' })); }
    return im.url;
  }

  // 문단 글자: 이 문단 바로 아래 run > t 만(표·글상자 안 문단은 따로 센다)
  const ownTs = (p) => kids(p, 'run').flatMap((r) => kids(r, 't'));
  const SOFT = { tab: '\t', lineBreak: '\n', nbSpace: ' ', fwSpace: '　', hyphen: '-' };
  function paraText(p) {
    let s = '', locked = false;
    for (const t of ownTs(p)) for (const n of t.childNodes) {
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1) { if (n.localName in SOFT) s += SOFT[n.localName]; else locked = true; }
    }
    return { text: s, locked, editable: !locked && kids(p, 'run').length > 0, mixed: new Set(kids(p, 'run').filter((r) => kids(r, 't').length).map((r) => attr(r, 'charPrIDRef'))).size > 1 };
  }
  function setParaText(doc, p, text) {
    const info = paraText(p); if (!info.editable) throw new Error('이 문단은 고칠 수 없어요');
    const x = p.ownerDocument; const pre = p.prefix || 'hp';
    let ts = ownTs(p);
    if (!ts.length) { const run = kids(p, 'run').find((r) => !kids(r, 'ctrl').length && !kids(r, 'secPr').length) || kids(p, 'run')[kids(p, 'run').length - 1]; const t = x.createElementNS(HP, `${pre}:t`); run.appendChild(t); ts = [t]; }
    // 바뀐 부분만 고친다: 앞뒤로 같은 글자는 원래 글자 묶음(서식) 그대로 두고, 달라진 가운데만 그 자리가 속한 묶음에 넣는다
    // → '(추진내용) 본문' 처럼 굵은 머리말 + 보통 본문인 문단도 서식이 유지된다
    const tText = (t) => Array.from(t.childNodes).map((n) => (n.nodeType === 3 ? n.nodeValue : SOFT[n.localName] || '')).join('');
    const texts = ts.map(tText); const orig = texts.join(''); const neu = String(text).replace(/\r\n?/g, '\n');
    let P = 0; while (P < orig.length && P < neu.length && orig[P] === neu[P]) P++;
    let Q = 0; while (Q < orig.length - P && Q < neu.length - P && orig[orig.length - 1 - Q] === neu[neu.length - 1 - Q]) Q++;
    const mid = neu.slice(P, neu.length - Q), cutEnd = orig.length - Q;
    let pos = 0, inserted = false;
    const next = texts.map((str, i) => {
      const st = pos, en = pos + str.length; pos = en;
      const keepA = str.slice(0, Math.max(0, Math.min(str.length, P - st)));
      const keepB = str.slice(Math.max(0, Math.min(str.length, cutEnd - st)));
      let ins = '';
      if (!inserted && P >= st && (P < en || i === texts.length - 1)) { ins = mid; inserted = true; }
      return keepA + ins + keepB;
    });
    ts.forEach((t, i) => {
      if (next[i] === texts[i]) return;
      while (t.firstChild) t.removeChild(t.firstChild);
      next[i].split(/(\t|\n)/).forEach((seg) => {
        if (seg === '\t') t.appendChild(x.createElementNS(HP, `${pre}:tab`));
        else if (seg === '\n') t.appendChild(x.createElementNS(HP, `${pre}:lineBreak`));
        else if (seg) t.appendChild(x.createTextNode(seg));
      });
    });
    kids(p, 'linesegarray').forEach((l) => p.removeChild(l));   // 한글이 줄 배치를 다시 계산
    const sec = doc.sections.find((s) => s.xml === x); if (sec) sec.dirty = true;
  }
  async function save(doc) {
    const out = [];
    const mt = doc.byName.get('mimetype'); out.push(mt);   // mimetype 이 맨 앞(무압축 원본 그대로)
    const ser = new XMLSerializer();
    for (const e of doc.entries) {
      if (e.name === 'mimetype') continue;
      const sec = doc.sections.find((s) => s.name === e.name) || (doc.header && doc.header.name === e.name ? doc.header : null);
      if (sec && sec.dirty) {
        let s = ser.serializeToString(sec.xml); if (!/^\s*<\?xml/.test(s)) s = `${sec.prolog}${s}`;
        out.push({ name: e.name, data: enc.encode(s) });
      } else out.push(e);
    }
    return writeZip(out);
  }
  window.HWPX = { open, paraText, setParaText, save, imageUrl, kids, attr, crc32, paraShape, setParaShape, countSameShape, readParaPr, setCharShape, cloneCharPr, pageMargins, setPageMargins,
    zip: { readZip, entryBytes, writeZip } };   // officeedit.js(xlsx·pptx 편집)도 같은 zip 도구를 쓴다
})();
