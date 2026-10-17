/* hwp2hwpx.js — 한글 hwp(5.x, 이진) 문서를 휴대폰 안에서 hwpx 로 바꾼다(서버 전송 없음).
 * 한컴이 공개한 「한글 문서 파일 형식 5.0」 규격을 따라 직접 읽는다: 복합 파일(CFB) → 레코드 → header.xml·section*.xml.
 * 바꾼 hwpx 는 기존 편집기(hwpx.js)가 그대로 연다. 배포용(보호) 문서는 열지 않는다.
 * 브라우저·Node(시험용) 양쪽에서 돈다: window.HWP2HWPX / module.exports.
 */
(function (root) {
  'use strict';

  // ── 1. 복합 파일(CFB) 읽기 ──
  function readCfb(buf) {
    const u8 = new Uint8Array(buf); const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0xE011CFD0 || dv.getUint32(4, true) !== 0xE11AB1A1) throw new Error('한글(hwp) 문서가 아니에요');
    const shift = dv.getUint16(0x1E, true), ssz = 1 << shift, mshift = dv.getUint16(0x20, true), msz = 1 << mshift;
    const nFat = dv.getUint32(0x2C, true), dir0 = dv.getUint32(0x30, true), cutoff = dv.getUint32(0x38, true);
    const mfat0 = dv.getUint32(0x3C, true), nMfat = dv.getUint32(0x40, true); let difat = dv.getUint32(0x44, true);
    const secOff = (n) => (n + 1) * ssz;
    const fatSecs = []; for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(0x4C + i * 4, true));
    const per = ssz / 4;
    let guard = 0;
    while (fatSecs.length < nFat && difat < 0xFFFFFFFA && guard++ < 100000) {
      const o = secOff(difat); for (let i = 0; i < per - 1 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(o + i * 4, true));
      difat = dv.getUint32(o + (per - 1) * 4, true);
    }
    const fat = new Uint32Array(fatSecs.length * per);
    fatSecs.forEach((s, k) => { const o = secOff(s); for (let i = 0; i < per; i++) fat[k * per + i] = o + i * 4 + 4 <= u8.length ? dv.getUint32(o + i * 4, true) : 0xFFFFFFFE; });
    const chain = (start, tbl) => { const out = []; let s = start, g = 0; while (s < 0xFFFFFFFA && s < tbl.length && g++ < tbl.length + 1) { out.push(s); s = tbl[s]; } return out; };
    const readChain = (start, size) => {
      const secs = chain(start, fat); const out = new Uint8Array(size === undefined ? secs.length * ssz : size); let p = 0;
      for (const s of secs) { const o = secOff(s); const n = Math.min(ssz, out.length - p); if (n <= 0) break; out.set(u8.subarray(o, o + n), p); p += n; }
      return out;
    };
    const dirBytes = readChain(dir0); const ents = [];
    for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
      const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + o, 128); const nl = d.getUint16(64, true);
      let name = ''; for (let i = 0; i + 2 < nl && i < 64; i += 2) name += String.fromCharCode(d.getUint16(i, true));
      ents.push({ name, type: d.getUint8(66), left: d.getUint32(68, true), right: d.getUint32(72, true), child: d.getUint32(76, true), start: d.getUint32(116, true), size: d.getUint32(120, true) });
    }
    const rootE = ents[0]; const ministream = rootE ? readChain(rootE.start, rootE.size) : new Uint8Array(0);
    const mfat = new Uint32Array(0 + (nMfat ? chain(mfat0, fat).length * per : 0));
    if (nMfat) { const b = readChain(mfat0); const bd = new DataView(b.buffer, b.byteOffset, b.byteLength); for (let i = 0; i < mfat.length; i++) mfat[i] = bd.getUint32(i * 4, true); }
    const readMini = (start, size) => { const out = new Uint8Array(size); let p = 0; for (const s of chain(start, mfat)) { const n = Math.min(msz, size - p); if (n <= 0) break; out.set(ministream.subarray(s * msz, s * msz + n), p); p += n; } return out; };
    const files = new Map();
    const walk = (idx, path, seen) => {
      if (idx >= ents.length || seen.has(idx)) return; seen.add(idx); const e = ents[idx];
      walk(e.left, path, seen); walk(e.right, path, seen);
      const full = path ? `${path}/${e.name}` : e.name;
      if (e.type === 2) files.set(full, e);
      else if (e.type === 1) walk(e.child, full, seen);
    };
    if (rootE) walk(rootE.child, '', new Set());
    return {
      names: [...files.keys()],
      has: (n) => files.has(n),
      read: (n) => { const e = files.get(n); if (!e) return null; return e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size); },
    };
  }

  // 압축 풀기(raw deflate). 한글 hwp 는 압축 끝에 군더더기 바이트가 붙는 일이 있는데,
  // 브라우저 DecompressionStream 은 그때 오류를 내며 이미 풀린 앞부분까지 버린다(실측: 128KB 에서 잘림) → 오류가 나면 아래 JS 풀기로 처음부터 다시 푼다.
  async function inflate(u8) {
    try {
      const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter();
      w.write(u8).catch(() => {}); w.close().catch(() => {});
      const r = ds.readable.getReader(); const parts = []; let n = 0;
      for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
      const out = new Uint8Array(n); let p = 0; for (const c of parts) { out.set(c, p); p += c.length; } return out;
    } catch (e) { return inflateJS(u8); }
  }
  // 순수 JS raw inflate(RFC 1951) — 마지막 블록에서 멈추므로 뒤 군더더기를 무시한다
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function huff(lengths, n) {
    const count = new Uint16Array(16), offs = new Uint16Array(16), symbol = new Uint16Array(n);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0; for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count, symbol };
  }
  let FIXED = null;
  function inflateJS(src) {
    let out = new Uint8Array(Math.max(4096, src.length * 4)), op = 0, ip = 0, bitbuf = 0, bitcnt = 0;
    const need = (n) => { if (op + n > out.length) { let len = out.length * 2; while (len < op + n) len *= 2; const o = new Uint8Array(len); o.set(out.subarray(0, op)); out = o; } };
    const bits = (n) => { while (bitcnt < n) { if (ip >= src.length) throw new Error('eof'); bitbuf |= src[ip++] << bitcnt; bitcnt += 8; } const v = bitbuf & ((1 << n) - 1); bitbuf >>>= n; bitcnt -= n; return v; };
    const decode = (h) => { let code = 0, first = 0, index = 0; for (let len = 1; len < 16; len++) { code |= bits(1); const c = h.count[len]; if (code - c < first) return h.symbol[index + (code - first)]; index += c; first += c; first <<= 1; code <<= 1; } throw new Error('bad code'); };
    try {
      let last = 0;
      do {
        last = bits(1); const type = bits(2);
        if (type === 0) {
          bitbuf = 0; bitcnt = 0; if (ip + 4 > src.length) throw new Error('eof');
          const len = src[ip] | (src[ip + 1] << 8); ip += 4; need(len); out.set(src.subarray(ip, ip + len), op); op += len; ip += len;
          continue;
        }
        let lit, dist;
        if (type === 1) {
          if (!FIXED) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); const d = new Uint8Array(30).fill(5); FIXED = [huff(l, 288), huff(d, 30)]; }
          [lit, dist] = FIXED;
        } else if (type === 2) {
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4; const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
          const ch = huff(cl, 19); const lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const sym = decode(ch);
            if (sym < 16) lens[i++] = sym;
            else { let rep = 0, val = 0; if (sym === 16) { val = lens[i - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep-- && i < hlit + hdist) lens[i++] = val; }
          }
          lit = huff(lens.subarray(0, hlit), hlit); dist = huff(lens.subarray(hlit), hdist);
        } else throw new Error('bad block');
        for (;;) {
          const sym = decode(lit);
          if (sym < 256) { need(1); out[op++] = sym; }
          else if (sym === 256) break;
          else {
            const k = sym - 257; const len = LBASE[k] + bits(LEXT[k]); const dk = decode(dist); const d = DBASE[dk] + bits(DEXT[dk]);
            need(len); for (let i = 0; i < len; i++, op++) out[op] = out[op - d];
          }
        }
      } while (!last);
    } catch (e) { if (!op) throw new Error('문서 압축을 풀지 못했어요(손상된 파일일 수 있어요)'); }
    return out.slice(0, op);
  }

  // ── 2. 레코드 ──
  const T = { DOC_PROPS: 0x10, ID_MAPPINGS: 0x11, BIN_DATA: 0x12, FACE_NAME: 0x13, BORDER_FILL: 0x14, CHAR_SHAPE: 0x15, TAB_DEF: 0x16, NUMBERING: 0x17, BULLET: 0x18, PARA_SHAPE: 0x19, STYLE: 0x1A,
    PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, PARA_LINE_SEG: 0x45, CTRL_HEADER: 0x47, LIST_HEADER: 0x48, PAGE_DEF: 0x49, FOOTNOTE_SHAPE: 0x4A, PAGE_BORDER_FILL: 0x4B,
    SHAPE_COMPONENT: 0x4C, TABLE: 0x4D, SC_LINE: 0x4E, SC_RECT: 0x4F, SC_ELLIPSE: 0x50, SC_ARC: 0x51, SC_POLYGON: 0x52, SC_CURVE: 0x53, SC_OLE: 0x54, SC_PICTURE: 0x55, SC_CONTAINER: 0x56, CTRL_DATA: 0x57, EQEDIT: 0x58, SC_TEXTART: 0x5A };
  function readRecords(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const out = []; let i = 0;
    while (i + 4 <= u8.length) {
      const h = dv.getUint32(i, true); i += 4; let size = h >>> 20;
      if (size === 0xFFF) { if (i + 4 > u8.length) break; size = dv.getUint32(i, true); i += 4; }
      out.push({ tag: h & 0x3FF, level: (h >>> 10) & 0x3FF, data: u8.subarray(i, Math.min(u8.length, i + size)), kids: [] }); i += size;
    }
    return out;
  }
  // 수준(level)으로 나무 만들기
  function tree(recs) {
    const top = []; const stack = [];
    for (const r of recs) {
      while (stack.length && stack[stack.length - 1].level >= r.level) stack.pop();
      if (stack.length) stack[stack.length - 1].kids.push(r); else top.push(r);
      stack.push(r);
    }
    return top;
  }
  // 바이트 읽개
  class R {
    constructor(u8, o) { this.u8 = u8 || new Uint8Array(0); this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength); this.o = o || 0; }
    get left() { return this.u8.length - this.o; }
    ok(n) { return this.o + n <= this.u8.length; }
    u8_() { if (!this.ok(1)) { this.o++; return 0; } return this.dv.getUint8(this.o++); }
    i8() { if (!this.ok(1)) { this.o++; return 0; } return this.dv.getInt8(this.o++); }
    u16() { if (!this.ok(2)) { this.o += 2; return 0; } const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
    i16() { if (!this.ok(2)) { this.o += 2; return 0; } const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
    u32() { if (!this.ok(4)) { this.o += 4; return 0; } const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
    i32() { if (!this.ok(4)) { this.o += 4; return 0; } const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
    f64() { if (!this.ok(8)) { this.o += 8; return 0; } const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
    str() { const n = this.u16(); let s = ''; for (let i = 0; i < n && this.ok(2); i++) s += String.fromCharCode(this.u16()); return s; }
    skip(n) { this.o += n; return this; }
  }

  // ── 3. 값 → hwpx 이름 ──
  const esc = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const A = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const hx2 = (x) => x.toString(16).padStart(2, '0').toUpperCase();
  const col = (v) => ((v >>> 0) === 0xFFFFFFFF ? 'none' : `#${(v >>> 24) ? hx2(v >>> 24) : ''}${hx2(v & 255)}${hx2((v >>> 8) & 255)}${hx2((v >>> 16) & 255)}`);
  const colOr = (v, d) => { const c = col(v); return c === 'none' ? d : c.length === 9 ? `#${c.slice(3)}` : c; };   // 글자·선 색은 #RRGGBB
  const pick = (arr, i, d) => (arr[i] !== undefined ? arr[i] : d);
  const LINE = ['NONE', 'SOLID', 'DOT', 'DASH', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE', 'THICK_3D', 'THICK_3D_REVERS', '3D', '3D_REVERS'];
  const LINE0 = LINE.slice(1);   // 0 부터 SOLID 인 목록(밑줄·취소선·도형 선)
  const WIDTH = ['0.1 mm', '0.12 mm', '0.15 mm', '0.2 mm', '0.25 mm', '0.3 mm', '0.4 mm', '0.5 mm', '0.6 mm', '0.7 mm', '1.0 mm', '1.5 mm', '2.0 mm', '3.0 mm', '4.0 mm', '5.0 mm'];
  const NUMFMT = ['DIGIT', 'CIRCLED_DIGIT', 'ROMAN_CAPITAL', 'ROMAN_SMALL', 'LATIN_CAPITAL', 'LATIN_SMALL', 'CIRCLED_LATIN_CAPITAL', 'CIRCLED_LATIN_SMALL', 'HANGUL_SYLLABLE', 'CIRCLED_HANGUL_SYLLABLE', 'HANGUL_JAMO', 'CIRCLED_HANGUL_JAMO', 'HANGUL_PHONETIC', 'IDEOGRAPH', 'CIRCLED_IDEOGRAPH', 'DECAGON_CIRCLE', 'DECAGON_CIRCLE_HANJA'];
  const numFmt = (v) => (v === 0x80 ? 'SYMBOL' : v === 0x81 ? 'USER_CHAR' : pick(NUMFMT, v, 'DIGIT'));
  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const LK = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
  const FAMILY = ['FCAT_UNKNOWN', 'FCAT_MYUNGJO', 'FCAT_GOTHIC', 'FCAT_SSERIF', 'FCAT_BRUSHSCRIPT', 'FCAT_DECORATIVE', 'FCAT_NONRECTMJ', 'FCAT_NONRECTGT'];
  const FONTTYPE = ['REP', 'TTF', 'HFT'];
  const half = (v) => Math.round(v / 2);   // 문단 여백·탭: hwpx 2016 판(hp:case)은 옛 값(hp:default)의 절반
  const NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
  const CASE = '<hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">';
  const PROLOG = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

  // ── 4. 채우기(테두리·도형 공통) ──
  function readFill(r) {
    const f = { type: r.u32() };
    if (f.type & 1) { f.bg = r.u32(); f.pat = r.u32(); f.patType = r.i32(); }
    if (f.type & 4) {
      f.gType = r.u8_(); f.angle = r.i32(); f.cx = r.i32(); f.cy = r.i32(); f.step = r.i32(); const n = r.i32();   // 실측: 종류 1바이트 + 4바이트씩
      if (n > 2) { f.pos = []; for (let i = 0; i < n; i++) f.pos.push(r.i32()); }
      f.colors = []; for (let i = 0; i < n && i < 64; i++) f.colors.push(r.u32());
    }
    if (f.type & 2) { f.imgMode = r.u8_(); f.bright = r.i8(); f.contrast = r.i8(); f.effect = r.u8_(); f.bin = r.u16(); }
    if (r.left >= 4) { const add = r.u32(); if (f.type & 4 && add >= 1) { f.stepCenter = r.u8_(); r.skip(add - 1); } else r.skip(Math.min(add, r.left)); }
    for (const bit of [1, 4, 2]) if (f.type & bit && r.left >= 1) f.alpha = r.u8_();   // 채우기 종류마다 투명도 1바이트(없으면 없음)
    return f;
  }
  const HATCH = ['HORIZONTAL', 'VERTICAL', 'BACK_SLASH', 'SLASH', 'CROSS', 'CROSS_DIAGONAL'];
  const GRAD = ['LINEAR', 'LINEAR', 'RADIAL', 'CONICAL', 'SQUARE'];
  const IMGMODE = ['TILE', 'TILE_HORZ_TOP', 'TILE_HORZ_BOTTOM', 'TILE_VERT_LEFT', 'TILE_VERT_RIGHT', 'TOTAL', 'CENTER', 'CENTER_TOP', 'CENTER_BOTTOM', 'LEFT_CENTER', 'LEFT_TOP', 'LEFT_BOTTOM', 'RIGHT_CENTER', 'RIGHT_TOP', 'RIGHT_BOTTOM', 'ZOOM'];
  const EFFECT = ['REAL_PIC', 'GRAY_SCALE', 'BLACK_WHITE'];
  function fillXml(f, ctx) {
    if (!f || !f.type) return '';
    let s = '<hc:fillBrush>';
    if (f.type & 1) s += `<hc:winBrush${A({ faceColor: col(f.bg), hatchColor: col(f.pat) === 'none' ? '#000000' : col(f.pat), hatchStyle: f.patType > 0 ? pick(HATCH, f.patType - 1, undefined) : undefined, alpha: '0' })}/>`;
    if (f.type & 4 && f.colors && f.colors.length) s += `<hc:gradation${A({ type: pick(GRAD, f.gType, 'LINEAR'), angle: f.angle, centerX: f.cx, centerY: f.cy, step: f.step || 255, colorNum: f.colors.length, stepCenter: f.stepCenter != null ? f.stepCenter : 50, alpha: '0' })}>${f.colors.map((c) => `<hc:color value="${colOr(c, '#FFFFFF')}"/>`).join('')}</hc:gradation>`;
    if (f.type & 2 && f.bin) s += `<hc:imgBrush mode="${pick(IMGMODE, f.imgMode, 'TOTAL')}"><hc:img${A({ binaryItemIDRef: ctx.binRef(f.bin), bright: f.bright, contrast: f.contrast, effect: pick(EFFECT, f.effect, 'REAL_PIC'), alpha: '0' })}/></hc:imgBrush>`;
    return s + '</hc:fillBrush>';
  }

  // ── 5. DocInfo → header.xml ──
  function docInfo(recs, ver) {
    const H = { faces: [[], [], [], [], [], [], []], borderFills: [], charShapes: [], tabDefs: [], numberings: [], bullets: [], paraShapes: [], styles: [], bins: [], begin: null, counts: null };
    let face = 0;
    for (const rec of recs) {
      const r = new R(rec.data);
      switch (rec.tag) {
        case T.DOC_PROPS: H.begin = { secCnt: r.u16(), page: r.u16(), footnote: r.u16(), endnote: r.u16(), pic: r.u16(), tbl: r.u16(), equation: r.u16() }; break;
        case T.ID_MAPPINGS: { H.counts = []; while (r.left >= 4) H.counts.push(r.i32()); break; }
        case T.BIN_DATA: {
          const p = r.u16(); const b = { type: p & 15, comp: (p >> 4) & 3 };
          if (b.type === 0) { b.abs = r.str(); b.rel = r.str(); } else { b.id = r.u16(); b.ext = r.str(); }
          H.bins.push(b); break;
        }
        case T.FACE_NAME: {
          // 언어별 글꼴 수(ID_MAPPINGS 1~7번)대로 차례대로 담는다
          const cnt = H.counts || []; let lang = 0, acc = 0;
          for (lang = 0; lang < 7; lang++) { acc += cnt[1 + lang] || 0; if (face < acc) break; }
          face++;
          const p = r.u8_(); const f = { type: pick(FONTTYPE, p & 3, 'TTF'), name: r.str() };
          if (p & 0x80) { const at = r.u8_(); f.alt = { type: pick(FONTTYPE, at, 'TTF'), name: r.str() }; }
          if (p & 0x40) { f.info = []; for (let i = 0; i < 10; i++) f.info.push(r.u8_()); }
          if (p & 0x20) f.base = r.str();
          if (lang < 7) H.faces[lang].push(f); break;
        }
        case T.BORDER_FILL: {
          const b = { prop: r.u16(), sides: [] };
          for (let i = 0; i < 4; i++) b.sides.push({ type: r.u8_(), width: r.u8_(), color: r.u32() });
          b.diag = { type: r.u8_(), width: r.u8_(), color: r.u32() };
          b.fill = readFill(r); H.borderFills.push(b); break;
        }
        case T.CHAR_SHAPE: {
          const c = { face: [], ratio: [], spacing: [], rel: [], offset: [] };
          for (let i = 0; i < 7; i++) c.face.push(r.u16()); for (let i = 0; i < 7; i++) c.ratio.push(r.u8_());
          for (let i = 0; i < 7; i++) c.spacing.push(r.i8()); for (let i = 0; i < 7; i++) c.rel.push(r.u8_()); for (let i = 0; i < 7; i++) c.offset.push(r.i8());
          c.height = r.i32(); c.prop = r.u32(); c.shX = r.i8(); c.shY = r.i8(); c.color = r.u32(); c.ulColor = r.u32(); c.shade = r.u32(); c.shColor = r.u32();
          c.bf = r.left >= 2 ? r.u16() : 0; c.stColor = r.left >= 4 ? r.u32() : 0;
          H.charShapes.push(c); break;
        }
        case T.TAB_DEF: {
          const t = { prop: r.u32(), items: [] }; const n = r.i32();
          for (let i = 0; i < n && r.left >= 8; i++) { t.items.push({ pos: r.u32(), type: r.u8_(), leader: r.u8_() }); r.skip(2); }
          H.tabDefs.push(t); break;
        }
        case T.NUMBERING: {
          const heads = []; const one = () => ({ prop: r.u32(), wadj: r.u16(), toff: r.u16(), cs: r.u32(), fmt: r.str() });
          for (let i = 0; i < 7; i++) heads.push(one());
          const n = { heads, start: r.u16(), starts: [] };
          if (r.left >= 28) for (let i = 0; i < 7; i++) n.starts.push(r.u32());
          for (let i = 0; i < 3 && r.left >= 14; i++) heads.push(one());
          for (let i = 0; i < 3 && r.left >= 4; i++) n.starts.push(r.u32());
          H.numberings.push(n); break;
        }
        case T.BULLET: {
          const b = { prop: r.u32(), wadj: r.u16(), toff: r.u16(), cs: r.u32(), ch: String.fromCharCode(r.u16()) };
          if (r.left >= 8) { b.img = r.i32(); b.bright = r.i8(); b.contrast = r.i8(); b.effect = r.u8_(); b.imgId = r.u8_(); }
          if (r.left >= 2) { const c = r.u16(); if (c) b.check = String.fromCharCode(c); }
          H.bullets.push(b); break;
        }
        case T.PARA_SHAPE: {
          const p = { p1: r.u32(), left: r.i32(), right: r.i32(), indent: r.i32(), prev: r.i32(), next: r.i32(), ls: r.i32(), tab: r.u16(), nb: r.u16(), bf: r.u16(), bo: [r.i16(), r.i16(), r.i16(), r.i16()] };
          p.p2 = r.left >= 4 ? r.u32() : 0; p.p3 = r.left >= 4 ? r.u32() : null; p.ls2 = r.left >= 4 ? r.u32() : null;
          H.paraShapes.push(p); break;
        }
        case T.STYLE: { H.styles.push({ name: r.str(), eng: r.str(), prop: r.u8_(), next: r.u8_(), lang: r.i16(), ps: r.u16(), cs: r.u16() }); break; }
        default: break;
      }
    }
    return H;
  }
  function headerXml(H, secCnt, ctx) {
    const b = H.begin || { page: 1, footnote: 1, endnote: 1, pic: 1, tbl: 1, equation: 1 };
    let s = `${PROLOG}<hh:head ${NS} version="1.5" secCnt="${secCnt}"><hh:beginNum${A({ page: b.page || 1, footnote: b.footnote || 1, endnote: b.endnote || 1, pic: b.pic || 1, tbl: b.tbl || 1, equation: b.equation || 1 })}/><hh:refList>`;
    // 글꼴
    s += `<hh:fontfaces itemCnt="7">${LANGS.map((L, li) => `<hh:fontface lang="${L}" fontCnt="${H.faces[li].length}">${H.faces[li].map((f, i) => {
      let x = `<hh:font${A({ id: i, face: f.name, type: f.type, isEmbedded: '0' })}>`;
      if (f.alt) x += `<hh:substFont${A({ face: f.alt.name, type: f.alt.type, isEmbedded: '0', binaryItemIDRef: '' })}/>`;
      if (f.info) { const t = f.info; x += `<hh:typeInfo${A({ familyType: pick(FAMILY, t[0], 'FCAT_UNKNOWN'), weight: t[2], proportion: t[3], contrast: t[4], strokeVariation: t[5], armStyle: t[6], letterform: t[7], midline: t[8], xHeight: t[9] })}/>`; }
      return x + '</hh:font>';
    }).join('')}</hh:fontface>`).join('')}</hh:fontfaces>`;
    // 테두리·배경
    const side = (k, d) => `<hh:${k}${A({ type: pick(LINE, d.type, 'SOLID'), width: pick(WIDTH, d.width, '0.1 mm'), color: colOr(d.color, '#000000') })}/>`;
    s += `<hh:borderFills itemCnt="${H.borderFills.length}">${H.borderFills.map((bf, i) => {
      const p = bf.prop;
      const diagT = (v) => ({ 2: 'CENTER', 3: 'CENTER_BELOW', 6: 'CENTER_ABOVE', 7: 'ALL' })[v] || 'NONE';
      let x = `<hh:borderFill${A({ id: i + 1, threeD: p & 1, shadow: (p >> 1) & 1, centerLine: (p >> 13) & 1 ? 'VERTICAL' : 'NONE', breakCellSeparateLine: '0' })}>`;
      x += `<hh:slash${A({ type: diagT((p >> 2) & 7), Crooked: (p >> 8) & 1, isCounter: (p >> 11) & 1 })}/><hh:backSlash${A({ type: diagT((p >> 5) & 7), Crooked: (p >> 9) & 1, isCounter: (p >> 12) & 1 })}/>`;
      x += side('leftBorder', bf.sides[0]) + side('rightBorder', bf.sides[1]) + side('topBorder', bf.sides[2]) + side('bottomBorder', bf.sides[3]);
      if (bf.diag.type) x += `<hh:diagonal${A({ type: pick(LINE, bf.diag.type, 'SOLID'), width: pick(WIDTH, bf.diag.width, '0.1 mm'), color: colOr(bf.diag.color, '#000000') })}/>`;
      return x + fillXml(bf.fill, ctx) + '</hh:borderFill>';
    }).join('')}</hh:borderFills>`;
    // 글자 모양
    const UL = ['NONE', 'BOTTOM', 'CENTER', 'TOP'];
    const OUTLINE = ['NONE', 'SOLID', 'DOT', 'THICK', 'DASH', 'DASH_DOT', 'DASH_DOT_DOT'];
    const SHADOW = ['NONE', 'DROP', 'CONTINUOUS'];
    const SYM = ['NONE', 'DOT_ABOVE', 'RING_ABOVE', 'TILDE', 'CARON', 'SIDE', 'COLON', 'GRAVE_ACCENT', 'ACUTE_ACCENT', 'CIRCUMFLEX', 'MACRON', 'HOOK_ABOVE', 'DOT_BELOW'];
    const per = (arr) => A(Object.fromEntries(LK.map((k, i) => [k, arr[i]])));
    s += `<hh:charProperties itemCnt="${H.charShapes.length}">${H.charShapes.map((c, i) => {
      const p = c.prop;
      let x = `<hh:charPr${A({ id: i, height: c.height, textColor: colOr(c.color, '#000000'), shadeColor: col(c.shade), useFontSpace: (p >> 25) & 1, useKerning: (p >> 30) & 1, symMark: pick(SYM, (p >> 21) & 15, 'NONE'), borderFillIDRef: c.bf || undefined })}>`;
      x += `<hh:fontRef${per(c.face)}/><hh:ratio${per(c.ratio)}/><hh:spacing${per(c.spacing)}/><hh:relSz${per(c.rel)}/><hh:offset${per(c.offset)}/>`;
      if (p & 1) x += '<hh:italic/>';
      if (p & 2) x += '<hh:bold/>';
      x += `<hh:underline${A({ type: pick(UL, (p >> 2) & 3, 'NONE'), shape: pick(LINE0, (p >> 4) & 15, 'SOLID'), color: colOr(c.ulColor, '#000000') })}/>`;
      const st = (p >> 18) & 7; x += `<hh:strikeout${A({ shape: st ? pick(LINE0, (p >> 26) & 15, 'SOLID') : 'NONE', color: colOr(c.stColor, '#000000') })}/>`;
      x += `<hh:outline type="${pick(OUTLINE, (p >> 8) & 7, 'NONE')}"/>`;
      x += `<hh:shadow${A({ type: pick(SHADOW, (p >> 11) & 3, 'NONE'), color: colOr(c.shColor, '#C0C0C0'), offsetX: c.shX, offsetY: c.shY })}/>`;
      if ((p >> 13) & 1) x += '<hh:emboss/>'; if ((p >> 14) & 1) x += '<hh:engrave/>';
      if ((p >> 15) & 1) x += '<hh:supscript/>'; if ((p >> 16) & 1) x += '<hh:subscript/>';
      return x + '</hh:charPr>';
    }).join('')}</hh:charProperties>`;
    // 탭
    const TABT = ['LEFT', 'RIGHT', 'CENTER', 'DECIMAL'];
    s += `<hh:tabProperties itemCnt="${H.tabDefs.length}">${H.tabDefs.map((t, i) => {
      const head = `<hh:tabPr${A({ id: i, autoTabLeft: t.prop & 1, autoTabRight: (t.prop >> 1) & 1 })}`;
      if (!t.items.length) return head + '/>';
      return head + '>' + t.items.map((it) => { const a = { type: pick(TABT, it.type, 'LEFT'), leader: pick(LINE, it.leader, 'NONE') };
        return `<hp:switch>${CASE}<hh:tabItem${A({ pos: half(it.pos), ...a, unit: 'HWPUNIT' })}/></hp:case><hp:default><hh:tabItem${A({ pos: it.pos, ...a })}/></hp:default></hp:switch>`; }).join('') + '</hh:tabPr>';
    }).join('')}</hh:tabProperties>`;
    // 문단 번호·글머리표
    const HALIGN = ['LEFT', 'CENTER', 'RIGHT'];
    const headA = (h, level, start) => A({ start, level, align: pick(HALIGN, h.prop & 3, 'LEFT'), useInstWidth: (h.prop >> 2) & 1, autoIndent: (h.prop >> 3) & 1, widthAdjust: h.wadj, textOffsetType: (h.prop >> 4) & 1 ? 'HWPUNIT' : 'PERCENT', textOffset: h.toff, numFormat: numFmt((h.prop >> 5) & 15), charPrIDRef: h.cs >>> 0, checkable: (h.prop >> 9) & 1 });
    if (H.numberings.length) s += `<hh:numberings itemCnt="${H.numberings.length}">${H.numberings.map((n, i) => `<hh:numbering id="${i + 1}" start="${n.start}">${n.heads.map((h, lv) => (h.fmt ? `<hh:paraHead${headA(h, lv + 1, n.starts[lv] || 1)}>${esc(h.fmt)}</hh:paraHead>` : `<hh:paraHead${headA(h, lv + 1, n.starts[lv] || 1)}/>`)).join('')}</hh:numbering>`).join('')}</hh:numberings>`;
    if (H.bullets.length) s += `<hh:bullets itemCnt="${H.bullets.length}">${H.bullets.map((b, i) => `<hh:bullet${A({ id: i + 1, char: b.ch, checkedChar: b.check, useImage: b.img ? 1 : 0 })}><hh:paraHead${headA(b, 0, undefined)}/></hh:bullet>`).join('')}</hh:bullets>`;
    // 문단 모양
    const PALIGN = ['JUSTIFY', 'LEFT', 'RIGHT', 'CENTER', 'DISTRIBUTE', 'DISTRIBUTE_SPACE'];
    const VALIGN = ['BASELINE', 'TOP', 'CENTER', 'BOTTOM'];
    const HEAD = ['NONE', 'OUTLINE', 'NUMBER', 'BULLET'];
    const LSTYPE = ['PERCENT', 'FIXED', 'BETWEEN_LINES', 'AT_LEAST'];
    const BLW = ['KEEP_WORD', 'HYPHENATION', 'BREAK_WORD'];
    s += `<hh:paraProperties itemCnt="${H.paraShapes.length}">${H.paraShapes.map((p, i) => {
      const p1 = p.p1, p2 = p.p2 || 0;
      const lsType = p.p3 != null ? pick(LSTYPE, p.p3 & 31, 'PERCENT') : pick(LSTYPE, p1 & 3, 'PERCENT');
      const lsVal = p.ls2 != null ? p.ls2 : p.ls;
      const headType = pick(HEAD, (p1 >> 23) & 3, 'NONE');
      let x = `<hh:paraPr${A({ id: i, tabPrIDRef: p.tab, condense: (p1 >> 9) & 127, fontLineHeight: (p1 >> 22) & 1, snapToGrid: (p1 >> 8) & 1, suppressLineNumbers: (p2 >> 2) & 1, checked: '0', textDir: 'AUTO' })}>`;
      x += `<hh:align${A({ horizontal: pick(PALIGN, (p1 >> 2) & 7, 'JUSTIFY'), vertical: pick(VALIGN, (p1 >> 20) & 3, 'BASELINE') })}/>`;
      x += `<hh:heading${A({ type: headType, idRef: headType === 'NONE' ? 0 : p.nb, level: (p1 >> 25) & 7 })}/>`;
      x += `<hh:breakSetting${A({ breakLatinWord: pick(BLW, (p1 >> 5) & 3, 'KEEP_WORD'), breakNonLatinWord: (p1 >> 7) & 1 ? 'KEEP_WORD' : 'BREAK_WORD', widowOrphan: (p1 >> 16) & 1, keepWithNext: (p1 >> 17) & 1, keepLines: (p1 >> 18) & 1, pageBreakBefore: (p1 >> 19) & 1, lineWrap: ['BREAK', 'SQUEEZE', 'KEEP'][p2 & 3] || 'BREAK' })}/>`;
      x += `<hh:autoSpacing${A({ eAsianEng: (p2 >> 4) & 1, eAsianNum: (p2 >> 5) & 1 })}/>`;
      const mg = (k, v) => `<hc:${k} value="${v}" unit="HWPUNIT"/>`;
      const block = (f) => `<hh:margin>${mg('intent', f(p.indent))}${mg('left', f(p.left))}${mg('right', f(p.right))}${mg('prev', f(p.prev))}${mg('next', f(p.next))}</hh:margin><hh:lineSpacing type="${lsType}" value="${lsType === 'PERCENT' ? lsVal : f(lsVal)}" unit="HWPUNIT"/>`;
      x += `<hp:switch>${CASE}${block(half)}</hp:case><hp:default>${block((v) => v)}</hp:default></hp:switch>`;
      x += `<hh:border${A({ borderFillIDRef: p.bf, offsetLeft: p.bo[0], offsetRight: p.bo[1], offsetTop: p.bo[2], offsetBottom: p.bo[3], connect: (p1 >> 28) & 1, ignoreMargin: (p1 >> 29) & 1 })}/>`;
      return x + '</hh:paraPr>';
    }).join('')}</hh:paraProperties>`;
    // 스타일
    s += `<hh:styles itemCnt="${H.styles.length}">${H.styles.map((st, i) => `<hh:style${A({ id: i, type: (st.prop & 7) === 1 ? 'CHAR' : 'PARA', name: st.name, engName: st.eng, paraPrIDRef: st.ps, charPrIDRef: st.cs, nextStyleIDRef: st.next, langID: st.lang, lockForm: '0' })}/>`).join('')}</hh:styles>`;
    s += '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>';
    return s;
  }

  // ── 6. 본문 ──
  const VREL = ['PAPER', 'PAGE', 'PARA'], VAL = ['TOP', 'CENTER', 'BOTTOM', 'INSIDE', 'OUTSIDE'], HREL = ['PAPER', 'PAGE', 'COLUMN', 'PARA'], HAL = ['LEFT', 'CENTER', 'RIGHT', 'INSIDE', 'OUTSIDE'];
  const WREL = ['PAPER', 'PAGE', 'COLUMN', 'PARA', 'ABSOLUTE'], HTREL = ['PAPER', 'PAGE', 'ABSOLUTE'], WRAP = ['SQUARE', 'TOP_AND_BOTTOM', 'BEHIND_TEXT', 'IN_FRONT_OF_TEXT'], FLOW = ['BOTH_SIDES', 'LEFT_ONLY', 'RIGHT_ONLY', 'LARGEST_ONLY'], NUMT = ['NONE', 'PICTURE', 'TABLE', 'EQUATION'];
  function objCommon(data) {
    const r = new R(data, 4); const p = r.u32();
    const o = { p, vOff: r.i32(), hOff: r.i32(), w: r.u32(), h: r.u32(), z: r.i32(), om: [r.i16(), r.i16(), r.i16(), r.i16()], inst: r.u32() };
    if (r.left >= 4) o.pbp = r.i32(); if (r.left >= 2) o.desc = r.str();
    return o;
  }
  const objHead = (o) => A({ id: o.inst, zOrder: o.z, numberingType: pick(NUMT, (o.p >> 26) & 7, 'NONE'), textWrap: pick(WRAP, (o.p >> 21) & 7, 'TOP_AND_BOTTOM'), textFlow: pick(FLOW, (o.p >> 24) & 3, 'BOTH_SIDES'), lock: '0', dropcapstyle: 'None' });
  const objTail = (o, protect) => `<hp:sz${A({ width: o.w, widthRelTo: pick(WREL, (o.p >> 15) & 7, 'ABSOLUTE'), height: o.h, heightRelTo: pick(HTREL, (o.p >> 18) & 3, 'ABSOLUTE'), protect: protect ? 1 : (o.p >> 20) & 1 })}/>`
    + `<hp:pos${A({ treatAsChar: o.p & 1, affectLSpacing: (o.p >> 2) & 1, flowWithText: (o.p >> 13) & 1, allowOverlap: (o.p >> 14) & 1, holdAnchorAndSO: '0', vertRelTo: pick(VREL, (o.p >> 3) & 3, 'PARA'), horzRelTo: pick(HREL, (o.p >> 8) & 3, 'PARA'), vertAlign: pick(VAL, (o.p >> 5) & 7, 'TOP'), horzAlign: pick(HAL, (o.p >> 10) & 7, 'LEFT'), vertOffset: o.vOff, horzOffset: o.hOff })}/>`
    + `<hp:outMargin${A({ left: o.om[0], right: o.om[1], top: o.om[2], bottom: o.om[3] })}/>`;

  const comment = (o) => (o.desc ? `<hp:shapeComment>${esc(o.desc.replace(/\r\n?/g, '\n'))}</hp:shapeComment>` : '');
  class Body {
    constructor(ctx) { this.ctx = ctx; }
    // 문단 목록: PARA_HEADER 들(+ 그 자식)
    paras(nodes) { return nodes.filter((n) => n.tag === T.PARA_HEADER).map((n) => this.para(n)).join(''); }
    // 목록 머리(LIST_HEADER) 뒤에 이어지는 문단 n 개
    listAfter(sibs, i) {
      const lh = sibs[i]; const cnt = new R(lh.data).u16(); const ps = [];
      for (let j = i + 1; j < sibs.length && ps.length < cnt; j++) { if (sibs[j].tag === T.PARA_HEADER) ps.push(sibs[j]); else if (sibs[j].tag === T.LIST_HEADER) break; }
      return ps;
    }
    subList(lh, paras, extra) {
      const p = new R(lh.data, 4).u32();
      return `<hp:subList${A({ id: '', textDirection: (p & 7) ? 'VERTICAL' : 'HORIZONTAL', lineWrap: ['BREAK', 'SQUEEZE', 'KEEP'][(p >> 3) & 3] || 'BREAK', vertAlign: pick(['TOP', 'CENTER', 'BOTTOM'], (p >> 5) & 3, 'TOP'), linkListIDRef: '0', linkListNextIDRef: '0', textWidth: (extra && extra.tw) || 0, textHeight: (extra && extra.th) || 0, hasTextRef: '0', hasNumRef: '0' })}>${paras.map((n) => this.para(n)).join('')}</hp:subList>`;
    }
    para(ph) {
      const r = new R(ph.data);
      const nChars = r.u32() & 0x7FFFFFFF; r.u32(); const ps = r.u16(); const st = r.u8_(); const brk = r.u8_(); r.skip(6); const inst = r.u32();
      const kidsOf = (tag) => ph.kids.filter((k) => k.tag === tag);
      const textRec = kidsOf(T.PARA_TEXT)[0];
      const csRec = kidsOf(T.PARA_CHAR_SHAPE)[0];
      const ctrls = kidsOf(T.CTRL_HEADER);
      // 글자 모양 바뀌는 자리
      const marks = []; if (csRec) { const cr = new R(csRec.data); while (cr.left >= 8) marks.push([cr.u32(), cr.u32()]); }
      if (!marks.length) marks.push([0, 0]);
      const csAt = (pos) => { let id = marks[0][1]; for (const [p, c] of marks) { if (p <= pos) id = c; else break; } return id; };
      // 글자 단위 풀기
      const units = []; if (textRec) { const tr = new R(textRec.data); while (tr.left >= 2) units.push(tr.u16()); }
      const runs = []; let cur = null; let ci = 0;
      const open = (pos) => { const id = csAt(pos); if (!cur || cur.cs !== id) { cur = { cs: id, parts: [] }; runs.push(cur); } };
      const addText = (s) => { const last = cur.parts[cur.parts.length - 1]; if (last && last.t != null) last.t += s; else cur.parts.push({ t: s }); };
      const addInT = (x) => { const last = cur.parts[cur.parts.length - 1]; if (last && last.t != null) last.t += `\u0000${x}\u0000`; else cur.parts.push({ t: `\u0000${x}\u0000` }); };
      const addObj = (x) => { if (x) cur.parts.push({ x }); };
      let i = 0;
      while (i < units.length) {
        const c = units[i];
        open(i);
        if (c >= 32) {
          let s = ''; const start = i;
          while (i < units.length && units[i] >= 32 && (i === start || csAt(i) === cur.cs)) { s += String.fromCharCode(units[i]); i++; }
          addText(s); continue;
        }
        if (c === 13) { i++; continue; }
        if (c === 10) { addInT('<hp:lineBreak/>'); i++; continue; }
        if (c === 24) { addInT('<hp:hyphen/>'); i++; continue; }
        if (c === 30) { addInT('<hp:nbSpace/>'); i++; continue; }
        if (c === 31) { addInT('<hp:fwSpace/>'); i++; continue; }
        if (c === 0 || (c >= 25 && c <= 29)) { i++; continue; }
        // 8칸짜리 조판 부호
        if (c === 9) { const w = (units[i + 1] | (units[i + 2] << 16)) >>> 0; addInT(`<hp:tab${A({ width: w, leader: units[i + 3] & 255, type: (units[i + 3] >> 8) & 255 || 1 })}/>`); i += 8; continue; }
        if ([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23].includes(c)) { const ch = ctrls[ci++]; if (ch) addObj(this.ctrl(ch, c)); i += 8; continue; }
        i += 8;   // 그 밖의 인라인 부호(필드 끝 등)는 건너뜀
      }
      if (!runs.length) runs.push({ cs: csAt(0), parts: [] });
      const runXml = runs.map((rn) => {
        const inner = rn.parts.map((pt) => {
          if (pt.x) return pt.x;
          const segs = pt.t.split('\u0000'); return `<hp:t>${segs.map((sg, k) => (k % 2 ? sg : esc(sg))).join('')}</hp:t>`;
        }).join('');
        return inner ? `<hp:run charPrIDRef="${rn.cs}">${inner}</hp:run>` : `<hp:run charPrIDRef="${rn.cs}"/>`;
      }).join('');
      let segs = ''; const ls = kidsOf(T.PARA_LINE_SEG)[0];
      if (ls) { const q = new R(ls.data); const L = []; while (q.left >= 36) L.push(`<hp:lineseg${A({ textpos: q.u32(), vertpos: q.i32(), vertsize: q.i32(), textheight: q.i32(), baseline: q.i32(), spacing: q.i32(), horzpos: q.i32(), horzsize: q.i32(), flags: q.u32() })}/>`); if (L.length) segs = `<hp:linesegarray>${L.join('')}</hp:linesegarray>`; }
      return `<hp:p${A({ id: inst, paraPrIDRef: ps, styleIDRef: st, pageBreak: (brk >> 2) & 1, columnBreak: (brk >> 3) & 1, merged: '0' })}>${runXml}${segs}</hp:p>`;
    }
    ctrl(ch, code) {
      const id = String.fromCharCode(ch.data[3], ch.data[2], ch.data[1], ch.data[0]);
      try {
        switch (id) {
          case 'secd': return this.secd(ch);
          case 'cold': return this.cold(ch);
          case 'tbl ': return this.table(ch);
          case 'gso ': return this.gso(ch);
          case 'eqed': return this.equation(ch);
          case 'head': case 'foot': return this.headFoot(ch, id === 'head' ? 'header' : 'footer');
          case 'fn  ': case 'en  ': return this.note(ch, id === 'fn  ' ? 'footNote' : 'endNote');
          case 'atno': return this.autoNum(ch);
          case 'nwno': return this.newNum(ch);
          case 'pgnp': return this.pageNum(ch);
          case 'pghd': return this.pageHide(ch);
          default: return '';   // 필드·책갈피·숨은 설명 등은 글자만 남긴다
        }
      } catch (e) { if (typeof process !== 'undefined' && process.env && process.env.HWPDBG) console.error('ctrl', id, e.stack); return ''; }
    }
    secd(ch) {
      const r = new R(ch.data, 4); const p = r.u32(); const gap = r.u16(); r.u16(); r.u16(); const tabStop = r.u32(); const outline = r.u16(); const pageStart = r.u16(); const picS = r.u16(), tblS = r.u16(), eqS = r.u16();
      const pd = ch.kids.find((k) => k.tag === T.PAGE_DEF); const notes = ch.kids.filter((k) => k.tag === T.FOOTNOTE_SHAPE); const pbf = ch.kids.filter((k) => k.tag === T.PAGE_BORDER_FILL);
      let x = `<hp:secPr${A({ id: '', textDirection: (p >> 16) & 1 ? 'VERTICAL' : 'HORIZONTAL', spaceColumns: gap, tabStop, tabStopVal: Math.round(tabStop / 2), tabStopUnit: 'HWPUNIT', outlineShapeIDRef: outline, memoShapeIDRef: '0', textVerticalWidthHead: '0', masterPageCnt: '0' })}>`;
      x += `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum${A({ pageStartsOn: ['BOTH', 'EVEN', 'ODD'][(p >> 20) & 3] || 'BOTH', page: pageStart, pic: picS, tbl: tblS, equation: eqS })}/>`;
      x += `<hp:visibility${A({ hideFirstHeader: (p >> 8) & 1, hideFirstFooter: (p >> 9) & 1, hideFirstMasterPage: (p >> 10) & 1, border: (p >> 11) & 1 ? 'HIDE_FIRST' : (p >> 12) & 1 ? 'SHOW_FIRST' : 'SHOW_ALL', fill: (p >> 13) & 1 ? 'HIDE_FIRST' : (p >> 14) & 1 ? 'SHOW_FIRST' : 'SHOW_ALL', hideFirstPageNum: (p >> 15) & 1, hideFirstEmptyLine: (p >> 19) & 1, showLineNumber: '0' })}/>`;
      x += '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>';
      if (pd) {
        const q = new R(pd.data); const w = q.u32(), h = q.u32(), l = q.u32(), rt = q.u32(), t = q.u32(), b = q.u32(), hd = q.u32(), ft = q.u32(), gt = q.u32(), pp = q.u32();
        x += `<hp:pagePr${A({ landscape: pp & 1 ? 'NARROWLY' : 'WIDELY', width: w, height: h, gutterType: ['LEFT_ONLY', 'LEFT_RIGHT', 'TOP_BOTTOM'][(pp >> 1) & 3] || 'LEFT_ONLY' })}><hp:margin${A({ header: hd, footer: ft, gutter: gt, left: l, right: rt, top: t, bottom: b })}/></hp:pagePr>`;
      }
      notes.forEach((n, k) => {
        const q = new R(n.data); const np = q.u32(); const uc = q.u16(), pc = q.u16(), sc = q.u16(); const start = q.u16(); const len = q.i32(); const above = q.u16(), below = q.u16(), between = q.u16(); const lt = q.u8_(), lw = q.u8_(); const lc = q.u32();
        const tag = k === 0 ? 'footNotePr' : 'endNotePr'; const chs = (v) => (v ? String.fromCharCode(v) : '');
        x += `<hp:${tag}><hp:autoNumFormat${A({ type: numFmt(np & 255), userChar: chs(uc), prefixChar: chs(pc), suffixChar: chs(sc), supscript: (np >> 12) & 1 })}/>`;
        x += `<hp:noteLine${A({ length: len, type: pick(LINE, lt, 'SOLID'), width: pick(WIDTH, lw, '0.12 mm'), color: colOr(lc, '#000000') })}/><hp:noteSpacing${A({ betweenNotes: between, belowLine: below, aboveLine: above })}/>`;
        x += `<hp:numbering${A({ type: ['CONTINUOUS', 'ON_SECTION', 'ON_PAGE'][(np >> 10) & 3] || 'CONTINUOUS', newNum: start || 1 })}/>`;
        x += `<hp:placement${A({ place: k === 0 ? (['EACH_COLUMN', 'MERGED_COLUMN', 'RIGHT_MOST_COLUMN'][(np >> 8) & 3] || 'EACH_COLUMN') : (['END_OF_DOCUMENT', 'END_OF_SECTION'][(np >> 8) & 3] || 'END_OF_DOCUMENT'), beneathText: (np >> 13) & 1 })}/></hp:${tag}>`;
      });
      ['BOTH', 'EVEN', 'ODD'].forEach((ty, k) => {
        const n = pbf[k]; if (!n) return; const q = new R(n.data); const pp = q.u32(); const ol = q.i16(), or = q.i16(), ot = q.i16(), ob = q.i16(); const bf = q.u16();
        x += `<hp:pageBorderFill${A({ type: ty, borderFillIDRef: bf || 1, textBorder: pp & 1 ? 'PAPER' : 'CONTENT', headerInside: (pp >> 1) & 1, footerInside: (pp >> 2) & 1, fillArea: ['PAPER', 'PAGE', 'BORDER'][(pp >> 3) & 3] || 'PAPER' })}><hp:offset${A({ left: ol, right: or, top: ot, bottom: ob })}/></hp:pageBorderFill>`;
      });
      return x + '</hp:secPr>';
    }
    cold(ch) {
      const r = new R(ch.data, 4); const p = r.u16(); const cnt = (p >> 2) & 255; const same = (p >> 12) & 1; const gap = r.u16();
      const widths = []; if (!same) for (let i = 0; i < cnt; i++) { widths.push([r.u16(), r.u16()]); }
      r.u16(); const lt = r.u8_(), lw = r.u8_(), lc = r.u32();
      let x = `<hp:ctrl><hp:colPr${A({ id: '', type: ['NEWSPAPER', 'BALANCED_NEWSPAPER', 'PARALLEL'][p & 3] || 'NEWSPAPER', layout: ['LEFT', 'RIGHT', 'MIRROR'][(p >> 10) & 3] || 'LEFT', colCount: cnt || 1, sameSz: same, sameGap: same ? gap : 0 })}`;
      const inner = (lt ? `<hp:colLine${A({ type: pick(LINE, lt, 'SOLID'), width: pick(WIDTH, lw, '0.12 mm'), color: colOr(lc, '#000000') })}/>` : '') + (!same ? widths.map(([w, g]) => `<hp:colSz width="${w}" gap="${g}"/>`).join('') : '');
      return x + (inner ? `>${inner}</hp:colPr></hp:ctrl>` : '/></hp:ctrl>');
    }
    // 캡션(있으면): LIST_HEADER(캡션) + 문단
    caption(ch) {
      const i = ch.kids.findIndex((k) => k.tag === T.LIST_HEADER);
      const firstSC = ch.kids.findIndex((k) => k.tag === T.TABLE || k.tag === T.SHAPE_COMPONENT || k.tag === T.EQEDIT);
      if (i < 0 || (firstSC >= 0 && i > firstSC)) return '';
      const lh = ch.kids[i]; const r = new R(lh.data, 8); const cp = r.u32(); const w = r.u32(); const gap = r.i16(); const lastW = r.u32();
      return `<hp:caption${A({ side: ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'][cp & 3] || 'BOTTOM', fullSz: (cp >> 2) & 1, width: w, gap, lastWidth: lastW })}>${this.subList(lh, this.listAfter(ch.kids, i))}</hp:caption>`;
    }
    table(ch) {
      const o = objCommon(ch.data); const tr = ch.kids.find((k) => k.tag === T.TABLE); if (!tr) return '';
      const r = new R(tr.data); const p = r.u32(); const rows = r.u16(), cols = r.u16(), sp = r.u16(); const im = [r.u16(), r.u16(), r.u16(), r.u16()];
      for (let i = 0; i < rows; i++) r.u16(); const bf = r.u16(); const zones = []; const nz = r.left >= 2 ? r.u16() : 0;
      for (let i = 0; i < nz && r.left >= 10; i++) zones.push({ sr: r.u16(), sc: r.u16(), er: r.u16(), ec: r.u16(), bf: r.u16() });
      const cells = [];
      const start = ch.kids.indexOf(tr);
      ch.kids.forEach((k, i) => {
        if (k.tag !== T.LIST_HEADER || i < start) return;
        const q = new R(k.data); q.u16(); q.skip(2); const lp = q.u32();
        const c = { lp, col: q.u16(), row: q.u16(), cs: q.u16(), rs: q.u16(), w: q.u32(), h: q.u32(), m: [q.i16(), q.i16(), q.i16(), q.i16()].map((v) => v >>> 0), bf: q.u16() };   // -1(표 기본값 따름)은 한글처럼 부호 없는 수로
        c.xml = this.subList(k, this.listAfter(ch.kids, i));
        cells.push(c);
      });
      let x = `<hp:tbl${objHead(o)}${A({ pageBreak: ['NONE', 'TABLE', 'CELL'][p & 3] || 'CELL', repeatHeader: (p >> 2) & 1, rowCnt: rows, colCnt: cols, cellSpacing: sp, borderFillIDRef: bf, noAdjust: '0' })}>`;
      x += objTail(o) + `<hp:inMargin${A({ left: im[0], right: im[1], top: im[2], bottom: im[3] })}/>`;
      if (zones.length) x += `<hp:cellzoneList>${zones.map((z) => `<hp:cellzone${A({ startRowAddr: z.sr, startColAddr: z.sc, endRowAddr: z.er, endColAddr: z.ec, borderFillIDRef: z.bf })}/>`).join('')}</hp:cellzoneList>`;
      for (let rr = 0; rr < rows; rr++) {
        const rc = cells.filter((c) => c.row === rr); if (!rc.length) continue;   // 원본(한글) 순서 그대로
        x += '<hp:tr>' + rc.map((c) => `<hp:tc${A({ name: '', header: (c.lp >> 18) & 1, hasMargin: (c.lp >> 16) & 1, protect: (c.lp >> 17) & 1, editable: (c.lp >> 19) & 1, dirty: '0', borderFillIDRef: c.bf })}>${c.xml}<hp:cellAddr colAddr="${c.col}" rowAddr="${c.row}"/><hp:cellSpan colSpan="${c.cs}" rowSpan="${c.rs}"/><hp:cellSz width="${c.w}" height="${c.h}"/><hp:cellMargin${A({ left: c.m[0], right: c.m[1], top: c.m[2], bottom: c.m[3] })}/></hp:tc>`).join('') + '</hp:tr>';
      }
      return x + '</hp:tbl>';
    }
    // 그리기 개체 공통(SHAPE_COMPONENT)
    shapeComp(sc, top) {
      const r = new R(sc.data, top ? 8 : 4);
      const s = { x: r.i32(), y: r.i32(), group: r.u16(), ver: r.u16(), ow: r.u32(), oh: r.u32(), cw: r.u32(), ch: r.u32(), p: r.u32(), rot: r.i16(), rcx: r.i32(), rcy: r.i32() };
      const n = r.u16(); const mat = () => { const m = []; for (let i = 0; i < 6; i++) m.push(r.f64()); return m; };
      s.trans = mat(); s.sca = []; s.rotm = []; for (let i = 0; i < n; i++) { s.sca.push(mat()); s.rotm.push(mat()); }
      s.r = r; return s;
    }
    shapeHead(s) {
      const m = (k, v) => `<hc:${k}${A({ e1: +v[0].toFixed(6), e2: +v[1].toFixed(6), e3: +v[2].toFixed(6), e4: +v[3].toFixed(6), e5: +v[4].toFixed(6), e6: +v[5].toFixed(6) })}/>`;
      let x = `<hp:offset x="${s.x >>> 0}" y="${s.y >>> 0}"/><hp:orgSz width="${s.ow}" height="${s.oh}"/><hp:curSz width="${s.cw}" height="${s.ch}"/><hp:flip horizontal="${s.p & 1}" vertical="${(s.p >> 1) & 1}"/><hp:rotationInfo${A({ angle: s.rot, centerX: s.rcx, centerY: s.rcy, rotateimage: '1' })}/>`;
      x += `<hp:renderingInfo>${m('transMatrix', s.trans)}${s.sca.map((v, i) => m('scaMatrix', v) + m('rotMatrix', s.rotm[i])).join('')}</hp:renderingInfo>`;
      return x;
    }
    // 선·채우기·그림자(그리기 개체만)
    drawStyle(s) {
      const r = s.r; if (r.left < 13) return { line: '', fill: '', shadow: '' };
      const lc = r.u32(), lw = r.i32(), lp = r.u32(), ol = r.u8_();
      const ARROW = ['NORMAL', 'ARROW', 'SPEAR', 'CONCAVE_ARROW', 'EMPTY_DIAMOND', 'EMPTY_CIRCLE', 'EMPTY_BOX', 'FILLED_DIAMOND', 'FILLED_CIRCLE', 'FILLED_BOX'];
      const ASZ = ['SMALL_SMALL', 'SMALL_MEDIUM', 'SMALL_LARGE', 'MEDIUM_SMALL', 'MEDIUM_MEDIUM', 'MEDIUM_LARGE', 'LARGE_SMALL', 'LARGE_MEDIUM', 'LARGE_LARGE'];
      const line = `<hp:lineShape${A({ color: colOr(lc, '#000000'), width: lw, style: pick(LINE, lp & 63, 'SOLID'), endCap: ['ROUND', 'FLAT'][(lp >> 6) & 15] || 'FLAT', headStyle: pick(ARROW, (lp >> 10) & 63, 'NORMAL'), tailStyle: pick(ARROW, (lp >> 16) & 63, 'NORMAL'), headfill: (lp >> 30) & 1, tailfill: (lp >>> 31) & 1, headSz: pick(ASZ, (lp >> 22) & 15, 'MEDIUM_MEDIUM'), tailSz: pick(ASZ, (lp >> 26) & 15, 'MEDIUM_MEDIUM'), outlineStyle: ['NORMAL', 'OUTER', 'INNER'][ol] || 'NORMAL', alpha: '0' })}/>`;
      let fill = ''; let shadow = '<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>';
      if (r.left >= 4) { fill = fillXml(readFill(r), this.ctx); }
      if (r.left >= 16) { const st = r.u32(), sc = r.u32(), sx = r.i32(), sy = r.i32(); const SH = ['NONE', 'PARELLEL_LEFTTOP', 'PARELLEL_RIGHTTOP', 'PARELLEL_LEFTBOTTOM', 'PARELLEL_RIGHTBOTTOM', 'SHEAR_LEFTTOP', 'SHEAR_RIGHTTOP', 'SHEAR_LEFTBOTTOM', 'SHEAR_RIGHTBOTTOM', 'SCALE_NARROW', 'SCALE_ENLARGE']; shadow = `<hp:shadow${A({ type: pick(SH, st, 'NONE'), color: colOr(sc, '#B2B2B2'), offsetX: sx, offsetY: sy, alpha: '0' })}/>`; }
      return { line, fill, shadow };
    }
    // 글상자(그리기 개체 안 LIST_HEADER + 문단)
    drawText(sc) {
      const i = sc.kids.findIndex((k) => k.tag === T.LIST_HEADER); if (i < 0) return '';
      const lh = sc.kids[i]; const r = new R(lh.data, 8); const m = [r.i16(), r.i16(), r.i16(), r.i16()]; const lastW = r.u32();
      return `<hp:drawText${A({ lastWidth: lastW, name: '', editable: '0' })}><hp:textMargin${A({ left: m[0], right: m[1], top: m[2], bottom: m[3] })}/>${this.subList(lh, this.listAfter(sc.kids, i))}</hp:drawText>`;
    }
    gso(ch) {
      const o = objCommon(ch.data); const sc = ch.kids.find((k) => k.tag === T.SHAPE_COMPONENT); if (!sc) return '';
      const body = this.shape(sc, true, o); if (!body) return '';
      return body.replace('</hp:__TAIL__>', objTail(o) + comment(o));
    }
    // 개체 하나(그림·사각형·선·타원·묶음…). top: 문단에 바로 붙은 개체(속성 머리 2번), o: 공통 속성(top 만)
    shape(sc, top, o) {
      const sid = String.fromCharCode(sc.data[3], sc.data[2], sc.data[1], sc.data[0]);
      const s = this.shapeComp(sc, top);
      const head = top ? objHead(o) : A({ id: '', zOrder: 0, numberingType: 'NONE', textWrap: 'TOP_AND_BOTTOM', textFlow: 'BOTH_SIDES', lock: '0', dropcapstyle: 'None' });
      const common = A({ href: '', groupLevel: s.group, instid: top ? o.inst : 0 });
      const tail = top ? '</hp:__TAIL__>' : `<hp:sz width="${s.cw}" widthRelTo="ABSOLUTE" height="${s.ch}" heightRelTo="ABSOLUTE" protect="0"/>`;
      const kid = (tag) => sc.kids.find((k) => k.tag === tag);
      if (sid === '$pic') {
        const pr = kid(T.SC_PICTURE); if (!pr) return '';
        const r = new R(pr.data); const bc = r.u32(), bw = r.i32(), bp = r.u32(); const pts = []; for (let i = 0; i < 4; i++) pts.push([r.i32(), r.i32()]);
        const cl = r.i32(), ct = r.i32(), cr = r.i32(), cb = r.i32(); const im = [r.i16(), r.i16(), r.i16(), r.i16()];
        const bright = r.i8(), contrast = r.i8(), effect = r.u8_(), bin = r.u16();
        const dims = pr.data.length >= 90 ? new R(pr.data, 82) : null; /* 원본 그림 크기(실측: 82번째 바이트부터) */ const dw = dims ? dims.u32() : 0, dh = dims ? dims.u32() : 0;
        let x = `<hp:pic${head}${common}${A({ reverse: '0' })}>${this.shapeHead(s)}`;
        if (bw > 0 && (bp & 63)) x += `<hp:lineShape${A({ color: colOr(bc, '#000000'), width: bw, style: pick(LINE, bp & 63, 'SOLID'), endCap: 'FLAT', headStyle: 'NORMAL', tailStyle: 'NORMAL', headfill: '1', tailfill: '1', headSz: 'MEDIUM_MEDIUM', tailSz: 'MEDIUM_MEDIUM', outlineStyle: 'NORMAL', alpha: '0' })}/>`;
        x += `<hc:img${A({ binaryItemIDRef: this.ctx.binRef(bin), bright, contrast, effect: pick(EFFECT, effect, 'REAL_PIC'), alpha: '0' })}/>`;
        x += `<hp:imgRect>${pts.map(([px, py], i) => `<hc:pt${i} x="${px}" y="${py}"/>`).join('')}</hp:imgRect><hp:imgClip${A({ left: cl, right: cr, top: ct, bottom: cb })}/><hp:inMargin${A({ left: im[0], right: im[1], top: im[2], bottom: im[3] })}/>`;
        if (dw && dh && dw < 1e8 && dh < 1e8) x += `<hp:imgDim dimwidth="${dw}" dimheight="${dh}"/>`;
        return x + `<hp:effects/>${tail}</hp:pic>`;
      }
      if (sid === '$con') {
        const subs = sc.kids.filter((k) => k.tag === T.SHAPE_COMPONENT).map((k) => this.shape(k, false)).filter(Boolean).join('');
        return `<hp:container${head}${common}>${this.shapeHead(s)}${subs}${tail}</hp:container>`;
      }
      const ds = this.drawStyle(s); const style = ds.line + ds.fill + ds.shadow;
      if (sid === '$rec') {
        const rr = kid(T.SC_RECT); const r = new R(rr ? rr.data : null); const ratio = r.u8_(); const pts = []; for (let i = 0; i < 4; i++) pts.push([r.i32(), r.i32()]);
        return `<hp:rect${head}${common}${A({ ratio })}>${this.shapeHead(s)}${style}${this.drawText(sc)}${pts.map(([px, py], i) => `<hc:pt${i} x="${px}" y="${py}"/>`).join('')}${tail}</hp:rect>`;
      }
      if (sid === '$lin') {
        const lr = kid(T.SC_LINE); const r = new R(lr ? lr.data : null); const sx = r.i32(), sy = r.i32(), ex = r.i32(), ey = r.i32(); const rev = r.left >= 2 ? r.u16() : 0;
        return `<hp:line${head}${common}${A({ isReverseHV: rev & 1 })}>${this.shapeHead(s)}${style}<hc:startPt x="${sx}" y="${sy}"/><hc:endPt x="${ex}" y="${ey}"/>${tail}</hp:line>`;
      }
      if (sid === '$ell') {
        const er = kid(T.SC_ELLIPSE); const r = new R(er ? er.data : null); const ep = r.u32(); const v = []; for (let i = 0; i < 12; i++) v.push(r.i32());
        return `<hp:ellipse${head}${common}${A({ intervalDirty: (ep >> 0) & 1, hasArcPr: (ep >> 1) & 1, arcType: ['NORMAL', 'PIE', 'CHORD'][(ep >> 2) & 3] || 'NORMAL' })}>${this.shapeHead(s)}${style}${this.drawText(sc)}<hc:center x="${v[0]}" y="${v[1]}"/><hc:ax1 x="${v[2]}" y="${v[3]}"/><hc:ax2 x="${v[4]}" y="${v[5]}"/><hc:start1 x="${v[6]}" y="${v[7]}"/><hc:end1 x="${v[8]}" y="${v[9]}"/><hc:start2 x="${v[6]}" y="${v[7]}"/><hc:end2 x="${v[10]}" y="${v[11]}"/>${tail}</hp:ellipse>`;
      }
      if (sid === '$pol') {
        const pr = kid(T.SC_POLYGON); const r = new R(pr ? pr.data : null); const n = r.i32(); const pts = []; for (let i = 0; i < n && r.left >= 8; i++) pts.push([r.i32(), r.i32()]);
        if (!pts.length) return '';
        return `<hp:polygon${head}${common}>${this.shapeHead(s)}${style}${this.drawText(sc)}${pts.map(([px, py]) => `<hc:pt x="${px}" y="${py}"/>`).join('')}${tail}</hp:polygon>`;
      }
      if (sid === '$arc') {
        const ar = kid(T.SC_ARC); const r = new R(ar ? ar.data : null); const ap = r.u8_(); const v = []; for (let i = 0; i < 6; i++) v.push(r.i32());
        return `<hp:arc${head}${common}${A({ type: ['NORMAL', 'PIE', 'CHORD'][ap & 3] || 'NORMAL' })}>${this.shapeHead(s)}${style}${this.drawText(sc)}<hc:center x="${v[0]}" y="${v[1]}"/><hc:ax1 x="${v[2]}" y="${v[3]}"/><hc:ax2 x="${v[4]}" y="${v[5]}"/>${tail}</hp:arc>`;
      }
      if (sid === '$cur') {
        const cr = kid(T.SC_CURVE); const r = new R(cr ? cr.data : null); const n = r.i32(); const pts = []; for (let i = 0; i < n && r.left >= 8; i++) pts.push([r.i32(), r.i32()]); const types = []; for (let i = 0; i < n - 1 && r.left >= 1; i++) types.push(r.u8_());
        if (pts.length < 2) return '';
        const segs = []; for (let i = 0; i < pts.length - 1; i++) segs.push(`<hp:seg${A({ type: types[i] === 1 ? 'CURVE' : 'LINE', x1: pts[i][0], y1: pts[i][1], x2: pts[i + 1][0], y2: pts[i + 1][1] })}/>`);
        return `<hp:curve${head}${common}>${this.shapeHead(s)}${style}${this.drawText(sc)}${segs.join('')}${tail}</hp:curve>`;
      }
      return '';   // 글맵시·OLE 등은 아직 못 옮김
    }
    equation(ch) {
      const o = objCommon(ch.data); const eq = ch.kids.find((k) => k.tag === T.EQEDIT); if (!eq) return '';
      const r = new R(eq.data); const ep = r.u32(); const script = r.str(); const size = r.u32(); const color = r.u32(); const base = r.i16(); r.skip(2); const ver = r.left >= 2 ? r.str() : 'Equation Version 60'; const font = r.left >= 2 ? r.str() : 'HYhwpEQ';
      return `<hp:equation${objHead(o)}${A({ version: ver || 'Equation Version 60', baseLine: base, textColor: colOr(color, '#000000'), baseUnit: size, lineMode: ep & 1 ? 'LINE' : 'CHAR', font: font || 'HYhwpEQ' })}>${objTail(o)}${comment(o)}<hp:script>${esc(script)}</hp:script></hp:equation>`;
    }
    headFoot(ch, tag) {
      const r = new R(ch.data, 4); const p = r.u32();
      const i = ch.kids.findIndex((k) => k.tag === T.LIST_HEADER); if (i < 0) return '';
      const lh = ch.kids[i]; const q = new R(lh.data, 8); const tw = q.u32(), th = q.u32();
      return `<hp:ctrl><hp:${tag}${A({ id: '', applyPageType: ['BOTH', 'EVEN', 'ODD'][p & 3] || 'BOTH' })}>${this.subList(lh, this.listAfter(ch.kids, i), { tw, th })}</hp:${tag}></hp:ctrl>`;
    }
    note(ch, tag) {
      const r = new R(ch.data, 4); const num = r.u32() || 1;
      const i = ch.kids.findIndex((k) => k.tag === T.LIST_HEADER); if (i < 0) return '';
      return `<hp:ctrl><hp:${tag}${A({ number: num, suffixChar: '41', instId: '' })}>${this.subList(ch.kids[i], this.listAfter(ch.kids, i))}</hp:${tag}></hp:ctrl>`;
    }
    autoNum(ch) {
      const r = new R(ch.data, 4); const p = r.u32(); const num = r.u16(); const uc = r.u16(), pc = r.u16(), sc = r.u16(); const chs = (v) => (v ? String.fromCharCode(v) : '');
      const NT = ['PAGE', 'FOOTNOTE', 'ENDNOTE', 'PICTURE', 'TABLE', 'EQUATION'];
      return `<hp:ctrl><hp:autoNum${A({ num: num || 1, numType: pick(NT, p & 15, 'PAGE') })}><hp:autoNumFormat${A({ type: numFmt((p >> 4) & 255), userChar: chs(uc), prefixChar: chs(pc), suffixChar: chs(sc), supscript: (p >> 12) & 1 })}/></hp:autoNum></hp:ctrl>`;
    }
    newNum(ch) {
      const r = new R(ch.data, 4); const p = r.u32(); const num = r.u16();
      return `<hp:ctrl><hp:newNum${A({ num: num || 1, numType: pick(['PAGE', 'FOOTNOTE', 'ENDNOTE', 'PICTURE', 'TABLE', 'EQUATION'], p & 15, 'PAGE') })}/></hp:ctrl>`;
    }
    pageNum(ch) {
      const r = new R(ch.data, 4); const p = r.u32(); r.u16(); r.u16(); r.u16(); const dash = r.u16();
      const POS = ['NONE', 'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT', 'OUTSIDE_TOP', 'OUTSIDE_BOTTOM', 'INSIDE_TOP', 'INSIDE_BOTTOM'];
      return `<hp:ctrl><hp:pageNum${A({ pos: pick(POS, (p >> 8) & 15, 'BOTTOM_CENTER'), formatType: numFmt(p & 255), sideChar: dash ? String.fromCharCode(dash) : '' })}/></hp:ctrl>`;
    }
    pageHide(ch) {
      const r = new R(ch.data, 4); const p = r.u32();
      return `<hp:ctrl><hp:pageHiding${A({ hideHeader: p & 1, hideFooter: (p >> 1) & 1, hideMasterPage: (p >> 2) & 1, hideBorder: (p >> 3) & 1, hideFill: (p >> 4) & 1, hidePageNum: (p >> 5) & 1 })}/></hp:ctrl>`;
    }
  }

  // ── 7. zip(저장 방식, 압축 없음) ──
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflate(u8) {
    const cs = new CompressionStream('deflate-raw'); const w = cs.writable.getWriter(); w.write(u8); w.close();
    const parts = []; let n = 0; const r = cs.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; }
    const out = new Uint8Array(n); let p = 0; for (const c of parts) { out.set(c, p); p += c.length; } return out;
  }
  async function zip(files) {
    const enc = new TextEncoder(); const parts = []; const cd = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name); const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data; const crc = crc32(raw);
      let data = raw, method = 0;
      if (f.name !== 'mimetype' && raw.length > 512 && typeof CompressionStream === 'function') { try { const z = await deflate(raw); if (z.length < raw.length * 0.95) { data = z; method = 8; } } catch (e) { /* 그대로 */ } }
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true); h.setUint16(10, 0, true); h.setUint16(12, 0x21, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true); c.setUint16(14, 0x21, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      cd.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = cd.reduce((n, p) => n + p.length, 0);
    const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    const all = [...parts, ...cd, new Uint8Array(e.buffer)]; const total = all.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(total); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  // ── 8. 전체 변환 ──
  const MIME = { png: 'image/png', jpg: 'image/jpg', jpeg: 'image/jpg', gif: 'image/gif', bmp: 'image/bmp', wmf: 'image/x-wmf', emf: 'image/x-emf', tif: 'image/tif', tiff: 'image/tif', svg: 'image/svg+xml' };
  async function convert(buf, opts) {
    const cfb = readCfb(buf);
    const fh = cfb.read('FileHeader'); if (!fh || fh.length < 40) throw new Error('한글(hwp) 문서가 아니에요');
    const fdv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
    const sig = String.fromCharCode(...fh.subarray(0, 17)); if (sig !== 'HWP Document File') throw new Error('한글(hwp) 문서가 아니에요');
    const ver = fdv.getUint32(32, true), prop = fdv.getUint32(36, true);
    if ((ver >>> 24) < 5) throw new Error('한글 97 이전 형식은 열 수 없어요. 한글에서 hwpx 로 저장해 주세요');
    if (prop & 2) throw new Error('암호가 걸린 문서는 열 수 없어요');
    if (prop & 4) throw new Error('배포용(보호) 문서는 열 수 없어요');
    const compressed = !!(prop & 1);
    const stream = async (n) => { const d = cfb.read(n); if (!d) return null; return compressed ? inflate(d) : d; };
    const H = docInfo(readRecords(await stream('DocInfo')), ver);
    // 그림 등 바이너리: BIN_DATA 순서(1부터) → BinData/BIN%04X.ext
    const bins = new Map(); const files = [];
    for (const b of H.bins) {
      if (b.type === 0 || b.id == null) continue;
      const ext = (b.ext || 'bin').toLowerCase(); const sname = `BinData/BIN${b.id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`;
      let raw = cfb.read(sname); if (!raw) { const alt = cfb.names.find((n) => n.toLowerCase() === sname.toLowerCase()); raw = alt ? cfb.read(alt) : null; }
      if (!raw) continue;
      const comp = b.comp === 1 || (b.comp === 0 && compressed);
      let data = raw; if (comp) { try { data = await inflate(raw); } catch (e) { data = raw; } }
      const id = `image${b.id}`; bins.set(b.id, id);
      files.push({ id, name: `BinData/${id}.${ext}`, data, mime: MIME[ext] || 'application/octet-stream' });
    }
    const ctx = { binRef: (n) => bins.get(n) || `image${n}` };
    const secNames = cfb.names.filter((n) => /^BodyText\/Section\d+$/.test(n)).sort((a, b) => parseInt(a.slice(16), 10) - parseInt(b.slice(16), 10));
    if (!secNames.length) throw new Error('본문이 없어요');
    const sections = [];
    for (const n of secNames) {
      const recs = tree(readRecords(await stream(n)));
      const body = new Body(ctx);
      sections.push(`${PROLOG}<hs:sec ${NS}>${body.paras(recs)}</hs:sec>`);
      if (opts && opts.onProgress) opts.onProgress(sections.length / secNames.length);
    }
    const header = headerXml(H, sections.length, ctx);
    const manifest = files.map((f) => `<opf:item id="${f.id}" href="${f.name}" media-type="${f.mime}" isEmbeded="1"/>`).join('');
    const hpf = `${PROLOG}<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title/><opf:language>ko</opf:language></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${manifest}${sections.map((_, i) => `<opf:item id="section${i}" href="Contents/section${i}.xml" media-type="application/xml"/>`).join('')}<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/>${sections.map((_, i) => `<opf:itemref idref="section${i}" linear="yes"/>`).join('')}</opf:spine></opf:package>`;
    const v = (k) => (ver >>> (24 - k * 8)) & 255;
    const out = [
      { name: 'mimetype', data: 'application/hwp+zip' },
      { name: 'version.xml', data: `${PROLOG}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="${v(0)}" minor="${v(1)}" micro="${v(2)}" buildNumber="${v(3)}" os="1" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="12, 0, 0, 0 WIN32LEWindows_10"/>` },
      { name: 'META-INF/container.xml', data: `${PROLOG}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>` },
      { name: 'META-INF/manifest.xml', data: `${PROLOG}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>` },
      { name: 'Contents/content.hpf', data: hpf },
      { name: 'Contents/header.xml', data: header },
      ...sections.map((s, i) => ({ name: `Contents/section${i}.xml`, data: s })),
      { name: 'settings.xml', data: `${PROLOG}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>` },
      ...files.map((f) => ({ name: f.name, data: f.data })),
    ];
    return (await zip(out)).buffer;
  }
  // hwp 인지(복합 파일 + 한글 서명) 빠르게 확인
  function isHwp(buf) { const u = new Uint8Array(buf, 0, Math.min(8, buf.byteLength)); return u.length === 8 && u[0] === 0xD0 && u[1] === 0xCF && u[2] === 0x11 && u[3] === 0xE0; }

  const api = { convert, isHwp, _readCfb: readCfb, _readRecords: readRecords, _inflateJS: inflateJS };
  root.HWP2HWPX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
