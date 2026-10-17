/* app.js — 한글 모바일 편집 화면. 문서 구조를 휴대폰용으로 펼쳐 보이고, 문단·표 칸을 눌러 글자를 고친다. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const { kids, attr } = window.HWPX;
  const S = { doc: null, file: null, paras: [], changes: new Map(), cur: -1, blob: null, draftKey: '', ops: [], fmtPids: new Set(), fmtOrigRef: new Map(), fmtOrigShape: new Map(), charPids: new Set(), charOrig: new Map(), pageOrig: null, pageChanged: false, lastTab: 'text' };

  function toast(m, err) { const t = $('#toast'); t.textContent = m; t.className = `toast${err ? ' err' : ''}`; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 무시 */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } } };

  // ── 아이폰(iOS)·설치형 웹앱 ──
  const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const STANDALONE = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (IOS) {
    $('#file').removeAttribute('accept');   // iOS 는 hwpx 를 모르는 형식이라 accept 가 있으면 파일이 흐리게 막힌다
    if (!STANDALONE) $('#iosInstall').hidden = false;
    if (!('DecompressionStream' in window) || !('CompressionStream' in window)) $('#iosOld').hidden = false;
  }
  // 오프라인 실행(https 웹에서만 — 안드로이드 앱은 자체 파일이라 필요 없음)
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // ── 열기 ──
  const pick = () => $('#file').click();
  $('#btnOpen2').onclick = pick;
  // 형식 타일: 그 형식 파일만 보이게 고르기(아이폰은 hwp 를 모르는 형식이라 hwp 타일만 거르지 않음)
  const ACCEPT_ALL = $('#file').getAttribute('accept') || '';
  const restoreAccept = () => { if (IOS) $('#file').removeAttribute('accept'); else $('#file').setAttribute('accept', ACCEPT_ALL); };
  document.querySelectorAll('#fmtGrid .fmt').forEach((b) => { b.onclick = () => {
    const acc = b.dataset.accept || ''; const i = $('#file');
    if (IOS && /hwp/.test(acc)) i.removeAttribute('accept'); else i.setAttribute('accept', acc);
    pickFrom = b.querySelector('.fn').firstChild.textContent.trim();
    i.click(); setTimeout(restoreAccept, 1500);
  }; });
  // 형식 타일로 고르다 그냥 돌아오면(취소) 「모든 파일 보기 / 돌아가기」 안내 — 안드로이드 앱은 네이티브가, 브라우저는 cancel 이벤트가 알려 준다
  let pickFrom = '';
  const pickCancel = () => {
    if (!pickFrom) return; const k = pickFrom; pickFrom = '';
    $('#pmT').textContent = `${k} 파일이 안 보이나요?`; $('#pmSub').textContent = `방금 목록은 ${k} 파일만 보여 줬어요`; $('#pickMiss').hidden = false;
  };
  window.hwpxPickCancel = pickCancel;
  $('#file').addEventListener('cancel', pickCancel);
  const pmClose = () => { $('#pickMiss').hidden = true; };
  $('#pmX').onclick = pmClose; $('#pmBack').onclick = pmClose;
  $('#pickMiss').onclick = (e) => { if (e.target === $('#pickMiss')) pmClose(); };
  $('#pmAll').onclick = () => { pmClose(); $('#btnOpenAll').onclick(); };
  // 「모든 파일에서 찾기」: 기기에 따라 hwpx 를 한글 형식으로 모르면 기본 목록에 안 보이므로
  $('#btnOpenAll').onclick = () => { const i = $('#file'); const a = i.getAttribute('accept'); i.setAttribute('accept', '*/*'); i.click(); setTimeout(() => { if (a != null && !IOS) i.setAttribute('accept', a); }, 1500); };
  // 위쪽 「열기」: 최근 문서가 있으면 시작 화면(최근 목록)을, 없으면 바로 파일 고르기
  // 위쪽 「⌂ 처음」·앱 이름: 첫 화면(문서 열기·최근 문서)으로. 보던 문서는 그대로 두어 「보던 문서로 돌아가기」로 다시 연다
  $('#btnOpen').onclick = () => showStart(true);
  document.querySelector('.top .brand').onclick = () => showStart(true);
  $('#btnBack').onclick = () => showStart(false);
  // 첫 화면일 때는 위쪽 열기·저장 줄을 숨긴다(:has 를 모르는 구형 웹뷰 대비)
  const homeMark = () => document.body.classList.toggle('home', !$('#start').hidden);
  new MutationObserver(homeMark).observe($('#start'), { attributes: true, attributeFilter: ['hidden'] }); homeMark();
  function showStart(on) {
    $('#start').hidden = !on; $('#doc').hidden = on || !S.doc; $('#toolbar').hidden = on || !S.doc; $('#viewer').hidden = on || !S.view;
    $('#btnBack').hidden = !(on && (S.doc || S.view));
    if (on) { renderRecent(); window.scrollTo(0, 0); } else fitPages();
  }
  $('#file').onchange = (e) => { pickFrom = ''; const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return; if (!/\.hwpx?$/i.test(f.name) && !(window.KViewer && window.KViewer.kindOf(f.name))) { toast('열 수 없는 형식이에요', true); return; } openFile(f); };
  // 안드로이드 앱: 다른 앱에서 「다른 앱으로 열기」로 받은 파일(이름·base64)을 연다
  window.openHwpxFromNative = (name, b64) => {
    try { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); openFile(new File([u8], name || '문서.hwpx')); }
    catch (err) { toast('파일을 받지 못했어요', true); }
  };
  async function openFile(f) {
    if ((S.doc || viewEd()) && nChanged() && !confirm('고친 내용을 저장하지 않고 다른 문서를 열까요?')) return;
    try {
      $('#fname').textContent = '여는 중…';
      // hwp(이진)는 휴대폰 안에서 hwpx 로 바꿔 연다(hwp2hwpx.js) — 저장도 hwpx
      const raw = await f.arrayBuffer(); const isHwp = !!(window.HWP2HWPX && window.HWP2HWPX.isHwp(raw));
      // 한글(hwp·hwpx)이 아니면 보기 전용(PDF·Word·PowerPoint·Excel·이미지·영상·텍스트)
      if (!isHwp && !/\.hwpx?$/i.test(f.name) && window.KViewer && window.KViewer.kindOf(f.name, new Uint8Array(raw, 0, Math.min(8, raw.byteLength)))) { await openViewer(f, raw); return; }
      if (!isHwp && /\.hwp$/i.test(f.name)) throw new Error('한글(hwp) 문서가 아니에요');
      if (isHwp) $('#fname').textContent = 'hwp 를 hwpx 로 바꾸는 중…';
      const buf = isHwp ? await window.HWP2HWPX.convert(raw) : raw;
      const orig = buf.slice(0); const doc = await window.HWPX.open(buf);
      S.orig = orig; S.redo = []; S.isHwp = isHwp;
      S.doc = doc; S.file = f; S.changes = new Map(); S.blob = null; S.cur = -1; S.ops = []; S.fmtPids = new Set(); S.fmtOrigRef = new Map(); S.fmtOrigShape = new Map(); S.charPids = new Set(); S.charOrig = new Map(); S.pageOrig = null; S.pageChanged = false;
      $('#sheet').hidden = true; $('#saveSheet').hidden = true; $('#pageSheet').hidden = true; $('#q').value = '';
      S.draftKey = `hwpxm:${f.name}:${f.size}:${window.HWPX.crc32(new Uint8Array(raw)).toString(16)}`;   // 내용 기준(다른 앱에서 받을 때마다 수정 시각이 바뀌므로)
      render();
      $('#fname').textContent = f.name;
      closeViewer();
      $('#start').hidden = true; $('#doc').hidden = false; $('#toolbar').hidden = false; $('#btnBack').hidden = true;
      rememberRecent(f, isHwp ? raw : orig, S.draftKey);   // hwp 는 원본을 보관(다시 열 때 다시 바꾼다)
      fitPages(); window.scrollTo(0, 0);   // 보이게 한 뒤에 화면 폭을 재서 쪽을 맞춘다
      const draft = store.get(S.draftKey);
      const nDraft = draft ? (draft.v === 3 ? (draft.ops || []).length : draft.v === 2 ? Object.keys(draft.text || {}).length + (draft.fmt || []).length : Object.keys(draft).length) : 0;
      if (nDraft && confirm(`이 문서에서 저장하지 않은 고친 내용(${nDraft}건)이 있어요. 이어서 할까요?`)) restoreDraft(draft);
      else store.del(S.draftKey);
      updateBar();
      toast(S.isHwp ? `hwp 를 hwpx 로 바꿔 열었어요(문단 ${S.paras.length}개). 저장은 hwpx 로 돼요` : `문단 ${S.paras.length}개를 읽었어요. 고칠 곳을 누르세요`);
    } catch (err) { console.error(err); $('#fname').textContent = '문서 열기 · 고치기'; toast(err.message || '열지 못했어요', true); }
  };

  // ── 보기 전용(한글 외 형식) ──
  function closeViewer() { if (S.view) { S.view.close(); S.view = null; } $('#viewer').hidden = true; }
  async function openViewer(f, raw) {
    closeViewer();
    $('#start').hidden = true; $('#doc').hidden = true; $('#toolbar').hidden = true; $('#viewer').hidden = false; $('#btnBack').hidden = true;
    $('#kvKind').textContent = '여는 중'; $('#kvInfo').textContent = '';
    try {
      S.view = await window.KViewer.open($('#kvHost'), f, raw, (t) => { $('#kvInfo').textContent = t; }, { edit: openEdit, changed: () => { S.blob = null; updateBar(); }, toast });
      // 한글 문서를 닫고 보기로(고치던 내용은 위에서 확인함)
      S.doc = null; S.file = f; S.ops = []; S.redo = []; S.changes = new Map(); S.fmtPids = new Set(); S.charPids = new Set(); S.pageChanged = false;
      $('#kvKind').textContent = S.view.label; $('#fname').textContent = f.name; window.scrollTo(0, 0);
      rememberRecent(f, raw, `view:${f.name}:${f.size}`);
      updateBar();
      $('#kvRo').textContent = S.view.editor ? (S.view.editor.kind === 'xlsx' ? '셀을 눌러 고치기' : '「글자 고치기」로 고치기') : '보기 전용';
      toast(S.view.editor ? `${S.view.label} — ${S.view.editor.kind === 'xlsx' ? '셀을 눌러 값을 고칠 수 있어요' : '「글자 고치기」에서 글자를 고칠 수 있어요'}` : `${S.view.label} 보기 — 고치기는 hwp·hwpx·xlsx·pptx·docx·pdf 만 돼요`);
    } catch (err) {
      console.error(err); closeViewer();
      if (S.doc) { $('#doc').hidden = false; $('#toolbar').hidden = false; $('#fname').textContent = S.file.name; } else showStart(true);
      toast(err.message || '열지 못했어요', true);
    }
  }

  // ── 그리기: 한글 문서처럼 — 실제 용지 폭·여백의 흰 쪽에 글꼴·크기·줄 간격·들여쓰기·표 테두리를 그대로, 화면 폭에 맞춰 축소 ──
  const U = (v) => (v || 0) / 75;   // HWPUNIT(1/7200 인치) → CSS px(96dpi)
  const ALIGN = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFY: 'justify', DISTRIBUTE: 'justify', DISTRIBUTE_SPACE: 'justify' };
  const HEAVY = /헤드라인|견고딕|견명|굵은|태고딕|Black|Bold|ExtraBold|중고딕/i;
  const SERIF = /바탕|명조|궁서|신명|견명|Batang|Myeongjo|Gungsuh|Times|Serif/i;
  const fontStack = (face) => {
    const q = face ? `"${face.replace(/"/g, '')}", ` : '';
    return SERIF.test(face || '')
      ? `${q}"함초롬바탕", "HCR Batang", "바탕", Batang, "Noto Serif CJK KR", "Noto Serif KR", serif`
      : `${q}"함초롬돋움", "HCR Dotum", "맑은 고딕", "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR", sans-serif`;
  };
  function charStyle(id) {
    const c = S.doc.style.chars[id]; if (!c) return '';
    let s = `font-size:${c.size}pt;font-family:${fontStack(c.font)};`;
    if (c.bold || HEAVY.test(c.font || '')) s += 'font-weight:700;';   // 헤드라인·견고딕 등은 글꼴 자체가 굵다(휴대폰 대체 글꼴은 보통 굵기)
    if (c.italic) s += 'font-style:italic;'; if (c.underline) s += 'text-decoration:underline;';
    if (c.color && /^#[0-9a-f]{6}$/i.test(c.color)) s += `color:${c.color};`;
    if (c.spacing) s += `letter-spacing:${(c.spacing / 100).toFixed(3)}em;`;
    return s;
  }
  function paraStyle(div, id) {
    const pp = S.doc.style.paras[id]; if (!pp) return;
    const st = div.style;
    st.textAlign = ALIGN[pp.align] || 'justify';
    st.lineHeight = pp.lineType === 'PERCENT' ? String(pp.lineValue / 100) : `${U(pp.lineValue)}px`;
    // 들여쓰기(+)·내어쓰기(-): 내어쓰기는 둘째 줄부터 들어가도록 왼쪽 여백을 더하고 첫 줄을 당긴다
    const left = U(pp.left), ind = U(pp.intent);
    st.paddingLeft = `${ind < 0 ? left - ind : left}px`; st.textIndent = `${ind}px`;
    st.paddingRight = pp.right ? `${U(pp.right)}px` : ''; st.marginTop = pp.prev ? `${U(pp.prev)}px` : ''; st.marginBottom = pp.next ? `${U(pp.next)}px` : '';
  }
  function render() {
    S.paras = [];
    const root = $('#doc'); root.textContent = ''; root.classList.remove('only-changed'); $('#btnChanged').setAttribute('aria-pressed', 'false');
    for (const sec of S.doc.sections) {
      const pg = sec.page;
      const frame = document.createElement('div'); frame.className = 'page-frame';
      const page = document.createElement('section'); page.className = 'hpage'; page.dataset.sec = String(S.doc.sections.indexOf(sec));
      page.style.width = `${U(pg.w)}px`; page.style.minHeight = `${U(pg.h)}px`;
      page.style.padding = `${U(pg.mt)}px ${U(pg.mr)}px ${U(pg.mb)}px ${U(pg.ml)}px`;
      for (const p of kids(sec.xml.documentElement, 'p')) renderP(p, page);
      frame.appendChild(page); root.appendChild(frame);
    }
    fitPages();
  }
  // 화면 폭에 맞춰 쪽 전체를 축소(zoom — 줄바꿈은 실제 용지 폭 그대로)
  function fitPages() {
    const avail = Math.max(240, $('#doc').clientWidth - 16);
    document.querySelectorAll('.hpage').forEach((pg) => { const w = parseFloat(pg.style.width) || 794; pg.style.zoom = String(Math.min(1, avail / w)); });
  }
  window.addEventListener('resize', () => { if (S.doc) fitPages(); });
  function renderP(p, host) {
    const pid = S.paras.length; S.paras.push(p);
    const info = window.HWPX.paraText(p);
    const div = document.createElement('div');
    div.className = `para${info.text.trim() ? '' : ' empty'}${info.editable ? '' : ' locked'}`;
    div.dataset.pid = pid;
    paraStyle(div, attr(p, 'paraPrIDRef'));
    host.appendChild(div);
    fillPara(div, p);
    // 개체(표·그림·글상자)는 문단 뒤에 차례대로 — 문단이 개체만 담고 있으면 빈 줄을 만들지 않는다
    let objs = 0;
    for (const run of kids(p, 'run')) for (const el of run.children) if (renderObj(el, host, div)) objs++;
    if (objs && !info.text.trim()) div.classList.add('holder');
    return div;
  }
  function fillPara(div, p) {
    div.textContent = '';
    let firstStyle = '';
    for (const run of kids(p, 'run')) {
      const st = charStyle(attr(run, 'charPrIDRef')); if (!firstStyle) firstStyle = st;
      for (const t of kids(run, 't')) {
        const span = document.createElement('span'); if (st) span.style.cssText = st;
        for (const n of t.childNodes) {
          if (n.nodeType === 3) span.appendChild(document.createTextNode(n.nodeValue));
          else if (n.localName === 'tab') { const b = document.createElement('span'); b.className = 'tab'; span.appendChild(b); }
          else if (n.localName === 'lineBreak') span.appendChild(document.createElement('br'));
          else if (n.localName === 'nbSpace' || n.localName === 'fwSpace') span.appendChild(document.createTextNode(' '));
        }
        div.appendChild(span);
      }
    }
    // 빈 문단도 그 글자 크기만큼 한 줄 높이를 차지(한글처럼)
    if (!div.textContent) { const z = document.createElement('span'); if (firstStyle) z.style.cssText = firstStyle; z.textContent = '​'; div.appendChild(z); }
  }
  function sizeOf(el) { const sz = kids(el, 'sz')[0] || kids(el, 'curSz')[0]; return { w: parseInt(attr(sz, 'width'), 10) || 0, h: parseInt(attr(sz, 'height'), 10) || 0 }; }
  function renderObj(el, host, para) {
    const n = el.localName;
    if (n === 'tbl') { host.appendChild(renderTable(el, para)); return true; }
    if (n === 'pic') {
      const img = el.getElementsByTagNameNS('*', 'img')[0]; const ref = attr(img, 'binaryItemIDRef');
      const w = document.createElement('div'); w.className = 'obj'; w.style.textAlign = para.style.textAlign || 'center';
      const sz = sizeOf(el);
      if (ref && S.doc.images[ref]) { const im = document.createElement('img'); im.alt = '그림'; im.loading = 'lazy'; if (sz.w) im.style.width = `${U(sz.w)}px`; window.HWPX.imageUrl(S.doc, ref).then((u) => { im.src = u; }); w.appendChild(im); }
      else { w.classList.add('ph'); w.textContent = '[그림]'; }
      host.appendChild(w); return true;
    }
    if (n === 'equation') { const w = document.createElement('div'); w.className = 'obj ph'; w.textContent = '[수식 — 한글에서 고쳐 주세요]'; host.appendChild(w); return true; }
    // 글상자·도형: 안에 문단 목록(drawText > subList)이 있으면 상자로
    if (['rect', 'ellipse', 'polygon', 'curve', 'arc', 'container', 'connectLine', 'textart'].includes(n)) {
      const lists = Array.from(el.getElementsByTagNameNS('*', 'subList')).filter((s) => s.parentElement && s.parentElement.localName === 'drawText');
      if (!lists.length) { let any = false; if (n === 'container') for (const c of el.children) any = renderObj(c, host, para) || any; return any; }
      const box = document.createElement('div'); box.className = 'box';
      const sz = sizeOf(el); if (sz.w) box.style.width = `${U(sz.w)}px`;
      for (const sl of lists) for (const p of kids(sl, 'p')) renderP(p, box);
      host.appendChild(box); return true;
    }
    return false;   // ctrl(머리말·꼬리말·쪽 번호·단 설정), secPr 등은 보이지 않는다
  }
  // 칸 테두리: 한글 선 종류 → CSS (굵기는 mm → px, 0.5px 이하는 가는 선)
  const LINE = { SOLID: 'solid', DASH: 'dashed', DOT: 'dotted', DASH_DOT: 'dashed', DASH_DOT_DOT: 'dashed', LONG_DASH: 'dashed', CIRCLE: 'dotted', DOUBLE_SLIM: 'double', SLIM_THICK: 'double', THICK_SLIM: 'double', SLIM_THICK_SLIM: 'double' };
  function borderCss(b) { if (!b || !b.type || b.type === 'NONE') return 'none'; const px = Math.max(0.6, b.width * 96 / 25.4); const k = LINE[b.type] || 'solid'; return `${k === 'double' ? Math.max(3, px) : px.toFixed(2)}px ${k} ${b.color}`; }
  function renderTable(tbl, para) {
    const wrap = document.createElement('div'); wrap.className = 'tbl-wrap';
    const align = para && para.style.textAlign;
    const table = document.createElement('table');
    table.style.marginLeft = align === 'center' || align === 'right' ? 'auto' : '0'; table.style.marginRight = align === 'center' ? 'auto' : '0';   // 블록 표(글자 줄 높이가 끼지 않게)
    const tsz = sizeOf(tbl); if (tsz.w) table.style.width = `${U(tsz.w)}px`;
    const inM = kids(tbl, 'inMargin')[0];
    const rows = kids(tbl, 'tr'); const cells = [];
    for (const tr of rows) for (const tc of kids(tr, 'tc')) {
      const ad = kids(tc, 'cellAddr')[0], sp = kids(tc, 'cellSpan')[0], cz = kids(tc, 'cellSz')[0];
      cells.push({ tc, col: +attr(ad, 'colAddr') || 0, cs: parseInt(attr(sp, 'colSpan'), 10) || 1, rs: parseInt(attr(sp, 'rowSpan'), 10) || 1, w: parseInt(attr(cz, 'width'), 10) || 0, h: parseInt(attr(cz, 'height'), 10) || 0 });
    }
    // 열 폭: 한 칸짜리 셀의 폭으로 정하고, 모르는 열은 여러 칸 셀의 남는 폭을 나눠 채운다
    const ncol = Math.max(1, ...cells.map((c) => c.col + c.cs)); const colW = new Array(ncol).fill(0);
    for (const c of cells) if (c.cs === 1 && c.w) colW[c.col] = Math.max(colW[c.col], c.w);
    for (const c of cells) if (c.cs > 1) { const span = colW.slice(c.col, c.col + c.cs); const unknown = span.filter((v) => !v).length; if (unknown) { const rest = Math.max(0, c.w - span.reduce((a, b) => a + b, 0)) / unknown; for (let i = c.col; i < c.col + c.cs; i++) if (!colW[i]) colW[i] = rest; } }
    if (colW.some((v) => v > 0)) { const cg = document.createElement('colgroup'); for (const v of colW) { const col = document.createElement('col'); if (v) col.style.width = `${U(v)}px`; cg.appendChild(col); } table.appendChild(cg); }
    let i = 0;
    for (const tr of rows) {
      const row = document.createElement('tr');
      for (const tc of kids(tr, 'tc')) {
        const c = cells[i++]; const td = document.createElement('td');
        if (c.cs > 1) td.colSpan = c.cs; if (c.rs > 1) td.rowSpan = c.rs;
        if (c.h && c.rs === 1) td.style.height = `${U(c.h)}px`;
        const bf = S.doc.style.borders[attr(tc, 'borderFillIDRef')];
        if (bf) { td.style.borderLeft = borderCss(bf.left); td.style.borderRight = borderCss(bf.right); td.style.borderTop = borderCss(bf.top); td.style.borderBottom = borderCss(bf.bottom); if (bf.fill) td.style.background = bf.fill;
          if (bf.grad) td.style.backgroundImage = `${bf.grad.type === 'RADIAL' ? 'radial-gradient(' : `linear-gradient(${90 + bf.grad.angle}deg, `}${bf.grad.colors.join(', ')})`;
          if (bf.img && S.doc.images[bf.img]) { td.style.backgroundSize = bf.imgMode === 'TOTAL' ? '100% 100%' : 'auto'; td.style.backgroundRepeat = bf.imgMode === 'TOTAL' ? 'no-repeat' : 'repeat'; window.HWPX.imageUrl(S.doc, bf.img).then((u) => { td.style.backgroundImage = `url("${u}")`; }); } }
        const m = attr(tc, 'hasMargin') === '1' ? kids(tc, 'cellMargin')[0] : inM;
        if (m) td.style.padding = `${U(+attr(m, 'top'))}px ${U(+attr(m, 'right'))}px ${U(+attr(m, 'bottom'))}px ${U(+attr(m, 'left'))}px`;
        const sl = kids(tc, 'subList')[0]; const va = attr(sl, 'vertAlign'); td.style.verticalAlign = va === 'TOP' ? 'top' : va === 'BOTTOM' ? 'bottom' : 'middle';
        for (const s of kids(tc, 'subList')) for (const p of kids(s, 'p')) renderP(p, td);
        row.appendChild(td);
      }
      table.appendChild(row);
    }
    wrap.appendChild(table);
    return wrap;
  }

  // ── 고치기: 글자 · 문단 모양 ──
  const H = window.HWPX;
  $('#doc').addEventListener('click', (e) => {
    const d = e.target.closest('.para'); if (!d) return;
    const pid = +d.dataset.pid; const p = S.paras[pid]; const info = H.paraText(p);
    S.cur = pid;
    $('#sheetT').textContent = d.closest('td') ? '표 칸 고치기' : '문단 고치기';
    const w = $('#sheetWarn');
    w.hidden = !info.mixed; if (info.mixed) w.textContent = '글자 모양이 여러 가지인 문단이에요. 바꾼 글자는 그 자리 앞 글자의 모양을 따라가요.';
    $('#ta').value = info.text;
    $('#btnRevert').disabled = !S.changes.has(pid);
    // 특수 요소가 든 문단은 글자는 못 고치지만 문단 모양은 바꿀 수 있다
    $('#tabText').disabled = !info.editable;
    fillFmt(pid); fillChar(pid);
    showTab(!info.editable && S.lastTab === 'text' ? 'para' : S.lastTab || 'text');
    $('#sheet').hidden = false;
    if (!$('#panelText').hidden) setTimeout(() => { const t = $('#ta'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 60);
  });
  function showTab(tab) {
    S.lastTab = tab;
    for (const [t, b, pn] of [['text', '#tabText', '#panelText'], ['char', '#tabChar', '#panelChar'], ['para', '#tabPara', '#panelPara']]) { $(b).setAttribute('aria-selected', String(tab === t)); $(pn).hidden = tab !== t; }
  }
  $('#tabText').onclick = () => showTab('text'); $('#tabPara').onclick = () => showTab('para'); $('#tabChar').onclick = () => { showTab('char'); if (S.cur >= 0) fillChar(S.cur, true); };
  const closeSheet = () => { $('#sheet').hidden = true; S.cur = -1; };
  $('#sheetX').onclick = closeSheet; $('#btnCancel').onclick = closeSheet; $('#btnFmtClose').onclick = closeSheet;
  $('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('#btnApply').onclick = () => { if (S.cur < 0) return; applyEdit(S.cur, $('#ta').value); closeSheet(); };
  $('#btnRevert').onclick = () => { const c = S.changes.get(S.cur); if (!c) return; applyEdit(S.cur, c.orig); S.changes.delete(S.cur); markDiv(S.cur); saveDraft(); updateBar(); closeSheet(); toast('원래대로 돌렸어요'); };
  function applyEdit(pid, text, quiet) {
    const p = S.paras[pid]; if (!p) return;
    const before = H.paraText(p).text;
    if (before === text) return;
    const c = S.changes.get(pid) || { orig: before };
    H.setParaText(S.doc, p, text);
    if (text === c.orig) S.changes.delete(pid); else S.changes.set(pid, c);
    S.ops.push({ t: 'text', pid, text });
    markDiv(pid);
    const div = divOf(pid); if (div) { fillPara(div, p); div.classList.toggle('empty', !text.trim()); }
    S.blob = null; saveDraft(); updateBar();
    if (!quiet) toast('고쳤어요 — 다 고친 뒤 「저장」을 누르세요');
  }

  // 문단 모양 패널
  const segVal = (id) => { const b = $(`#${id} [aria-pressed="true"]`); return b ? b.dataset.v : ''; };
  const setSeg = (id, v) => document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  document.querySelectorAll('#fAlign button, #fFirst button').forEach((b) => { b.onclick = () => setSeg(b.parentElement.id, b.dataset.v); });
  document.querySelectorAll('#fLinePre button').forEach((b) => { b.onclick = () => { $('#fLine').value = b.dataset.v; }; });
  document.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { const i = $(`#${b.dataset.step}`); const v = (parseFloat(i.value) || 0) + parseFloat(b.dataset.d); i.value = String(Math.max(i.min !== '' ? parseFloat(i.min) : -999, Math.round(v * 10) / 10)); }; });
  const r1 = (v) => Math.round(v * 10) / 10;
  function fillFmt(pid) {
    const p = S.paras[pid]; const sh = H.paraShape(S.doc, p);
    setSeg('fAlign', sh.align === 'DISTRIBUTE_SPACE' ? 'DISTRIBUTE' : sh.align);
    $('#fLine').value = sh.line; $('#fLeft').value = r1(sh.left); $('#fRight').value = r1(sh.right);
    setSeg('fFirst', sh.intent > 0 ? 'indent' : sh.intent < 0 ? 'hang' : 'none'); $('#fIndent').value = r1(Math.abs(sh.intent));
    $('#fPrev').value = r1(sh.prev); $('#fNext').value = r1(sh.next);
    const n = H.countSameShape(S.doc, p); $('#fSameN').textContent = `(${n}개)`;
    document.querySelector('input[name="fScope"][value="this"]').checked = true;
    document.querySelector('input[name="fScope"][value="same"]').disabled = n <= 1;
    $('#btnFmtRevert').disabled = !S.fmtPids.has(pid);
  }
  function readFmt() {
    const num = (id) => { const v = parseFloat($(`#${id}`).value); return isFinite(v) ? v : 0; };
    const first = segVal('fFirst'); const ind = Math.abs(num('fIndent'));
    return { align: segVal('fAlign') || 'JUSTIFY', line: Math.max(50, Math.min(500, num('fLine') || 160)), left: num('fLeft'), right: num('fRight'),
      intent: first === 'indent' ? ind : first === 'hang' ? -ind : 0, prev: Math.max(0, num('fPrev')), next: Math.max(0, num('fNext')) };
  }
  $('#btnFmtApply').onclick = () => {
    if (S.cur < 0) return;
    const mode = document.querySelector('input[name="fScope"]:checked').value;
    try { const n = applyFmt([S.cur], readFmt(), mode); fillFmt(S.cur); toast(mode === 'same' ? `같은 모양 문단 ${n}개에 적용했어요` : '문단 모양을 바꿨어요'); }
    catch (err) { console.error(err); toast(err.message || '바꾸지 못했어요', true); }
  };
  $('#btnFmtRevert').onclick = () => { if (S.cur < 0) return; revertFmt(S.cur); fillFmt(S.cur); toast('원래 모양으로 돌렸어요'); };
  const pidsWithId = (id) => S.paras.map((q, i) => (attr(q, 'paraPrIDRef') === id ? i : -1)).filter((i) => i >= 0);
  function restyle(pids) { for (const i of pids) { const d = divOf(i); if (d) paraStyle(d, attr(S.paras[i], 'paraPrIDRef')); markDiv(i); } }
  function applyFmt(pids, shape, mode, replay) {
    const p0 = S.paras[pids[0]]; const oldId = attr(p0, 'paraPrIDRef');
    if (mode === 'same') { if (!S.fmtOrigShape.has(oldId)) S.fmtOrigShape.set(oldId, H.paraShape(S.doc, p0)); }
    else for (const i of pids) if (!S.fmtOrigRef.has(i)) S.fmtOrigRef.set(i, attr(S.paras[i], 'paraPrIDRef'));
    const r = H.setParaShape(S.doc, pids.map((i) => S.paras[i]), shape, mode);
    const touched = mode === 'same' ? pidsWithId(r.id) : pids;
    touched.forEach((i) => S.fmtPids.add(i)); restyle(touched);
    S.ops.push({ t: 'fmt', pids, shape, mode });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
    return touched.length;
  }
  function revertFmt(pid, replay) {
    const p = S.paras[pid]; let touched = [pid];
    if (S.fmtOrigRef.has(pid)) { p.setAttribute('paraPrIDRef', S.fmtOrigRef.get(pid)); S.fmtOrigRef.delete(pid); }
    const id = attr(p, 'paraPrIDRef');
    if (S.fmtOrigShape.has(id)) { const sh = S.fmtOrigShape.get(id); H.setParaShape(S.doc, [p], { ...sh, line: sh.lineType === 'PERCENT' ? sh.line : null }, 'same'); S.fmtOrigShape.delete(id); touched = pidsWithId(id); }
    touched.forEach((i) => { if (!S.fmtOrigRef.has(i)) S.fmtPids.delete(i); }); restyle(touched);
    S.ops.push({ t: 'fmtRevert', pid });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
  }
  // 글자 모양 패널 — 바꾼 항목만 적용(범위 안 글자들의 다른 모양은 그대로 둔다)
  const COLORS = ['#000000', '#FF0000', '#0000FF', '#2E5FA3', '#00804D', '#C00000', '#7F7F7F', '#E36C09'];
  $('#cColors').innerHTML = COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="글자 색 ${c}" aria-pressed="false"></button>`).join('');
  const cDirty = new Set();
  const markC = (f) => cDirty.add(f);
  ['cSize', 'cSpacing', 'cRatio'].forEach((id) => $(`#${id}`).addEventListener('input', () => markC($(`#${id}`).dataset.f)));
  document.querySelectorAll('#panelChar [data-step]').forEach((b) => b.addEventListener('click', () => markC($(`#${b.dataset.step}`).dataset.f)));
  ['cBold', 'cItalic', 'cUnder'].forEach((id) => { $(`#${id}`).onclick = () => { const b = $(`#${id}`); b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); markC(b.dataset.f); }; });
  const pickColor = (c) => { $('#cColor').value = c.toLowerCase(); document.querySelectorAll('#cColors button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c.toLowerCase() === c.toLowerCase()))); };
  $('#cColors').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; pickColor(b.dataset.c); markC('color'); });
  $('#cColor').addEventListener('input', () => { pickColor($('#cColor').value); markC('color'); });
  $('#cFont').addEventListener('change', () => markC('font'));
  document.querySelectorAll('#cScope button').forEach((b) => { b.onclick = () => { setSeg('cScope', b.dataset.v); selInfo(); }; });
  function selInfo() {
    const ta = $('#cTa'); const n = Math.max(0, ta.selectionEnd - ta.selectionStart);
    const sel = segVal('cScope') === 'sel';
    $('#cSelInfo').textContent = sel ? (n ? `${n}자 고름` : '아직 고른 글자 없음') : '';
    $('#cSelHint').hidden = !sel;
  }
  document.addEventListener('selectionchange', () => { if (document.activeElement === $('#cTa')) { if (segVal('cScope') !== 'sel' && $('#cTa').selectionEnd > $('#cTa').selectionStart) setSeg('cScope', 'sel'); selInfo(); } });
  $('#cTa').addEventListener('select', selInfo);
  // 화면에 보일 현재 모양: 고른 범위의 첫 글자(없으면 문단 첫 글자 묶음)의 모양
  function charIdAt(p, at) {
    let pos = 0, firstId = '';
    for (const r of kids(p, 'run')) {
      const len = kids(r, 't').reduce((n, t) => n + Array.from(t.childNodes).reduce((m, nd) => m + (nd.nodeType === 3 ? nd.nodeValue.length : 1), 0), 0);
      if (!len) continue; if (!firstId) firstId = attr(r, 'charPrIDRef');
      if (at < pos + len) return attr(r, 'charPrIDRef'); pos += len;
    }
    return firstId;
  }
  function fillChar(pid, keepSel) {
    const p = S.paras[pid]; const info = H.paraText(p);
    const ta = $('#cTa'); if (!keepSel) { ta.value = info.text; setSeg('cScope', 'all'); }
    // 특수 요소가 든 문단은 범위 선택 불가(문단 전체만)
    document.querySelector('#cScope [data-v="sel"]').disabled = !info.editable;
    const at = segVal('cScope') === 'sel' ? ta.selectionStart : 0;
    const c = S.doc.style.chars[charIdAt(p, at)] || {};
    $('#cSize').value = c.size || 10; $('#cSpacing').value = c.spacing || 0; $('#cRatio').value = c.ratio || 100;
    $('#cBold').setAttribute('aria-pressed', String(!!c.bold)); $('#cItalic').setAttribute('aria-pressed', String(!!c.italic)); $('#cUnder').setAttribute('aria-pressed', String(!!c.underline));
    pickColor(/^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#000000');
    const faces = [...new Set(((S.doc.style.fontsByLang || {}).HANGUL || []).map((f) => f.face).filter(Boolean))];
    $('#cFont').innerHTML = faces.map((f) => `<option${f === c.font ? ' selected' : ''}>${f.replace(/[&<>"]/g, '')}</option>`).join('');
    cDirty.clear(); selInfo();
    $('#btnCharRevert').disabled = !S.charOrig.has(pid);
  }
  $('#btnCharApply').onclick = () => {
    if (S.cur < 0) return;
    if (!cDirty.size) { toast('바꿀 항목을 먼저 고르세요', true); return; }
    const ta = $('#cTa'); let range = null;
    if (segVal('cScope') === 'sel') {
      if (ta.selectionEnd <= ta.selectionStart) { toast('글자를 길게 눌러 범위를 먼저 고르세요', true); return; }
      range = [ta.selectionStart, ta.selectionEnd];
    }
    const ch = {};
    if (cDirty.has('size')) ch.size = Math.max(4, Math.min(96, parseFloat($('#cSize').value) || 10));
    if (cDirty.has('spacing')) ch.spacing = Math.max(-50, Math.min(50, parseInt($('#cSpacing').value, 10) || 0));
    if (cDirty.has('ratio')) ch.ratio = Math.max(50, Math.min(200, parseInt($('#cRatio').value, 10) || 100));
    if (cDirty.has('bold')) ch.bold = $('#cBold').getAttribute('aria-pressed') === 'true';
    if (cDirty.has('italic')) ch.italic = $('#cItalic').getAttribute('aria-pressed') === 'true';
    if (cDirty.has('underline')) ch.underline = $('#cUnder').getAttribute('aria-pressed') === 'true';
    if (cDirty.has('color')) ch.color = $('#cColor').value;
    if (cDirty.has('font')) ch.font = $('#cFont').value;
    try { applyChar(S.cur, range, ch); cDirty.clear(); $('#btnCharRevert').disabled = false; toast(range ? `고른 ${range[1] - range[0]}자의 글자 모양을 바꿨어요` : '문단 글자 모양을 바꿨어요'); }
    catch (err) { console.error(err); toast(err.message || '바꾸지 못했어요', true); }
  };
  $('#btnCharRevert').onclick = () => { if (S.cur < 0) return; revertChar(S.cur); fillChar(S.cur); toast('원래 글자 모양으로 돌렸어요'); };
  $('#btnCharClose').onclick = closeSheet;
  function applyChar(pid, range, ch, replay) {
    const p = S.paras[pid];
    if (!S.charOrig.has(pid)) S.charOrig.set(pid, kids(p, 'run').map((r) => r.cloneNode(true)));   // 되돌리기용 원래 글자 묶음
    H.setCharShape(S.doc, p, range, ch);
    S.charPids.add(pid);
    const div = divOf(pid); if (div) fillPara(div, p); markDiv(pid);
    S.ops.push({ t: 'char', pid, range, ch });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
  }
  function revertChar(pid, replay) {
    const p = S.paras[pid]; const orig = S.charOrig.get(pid); if (!orig) return;
    const text = H.paraText(p).text;   // 글자 고친 내용은 살리고 모양만 되돌린다
    const first = kids(p, 'run')[0];
    kids(p, 'run').forEach((r) => { if (r !== first) p.removeChild(r); });
    orig.forEach((r) => p.insertBefore(r.cloneNode(true), first)); p.removeChild(first);
    if (H.paraText(p).text !== text) H.setParaText(S.doc, p, text); else { const sec = S.doc.sections.find((q) => q.xml === p.ownerDocument); if (sec) sec.dirty = true; }
    S.charOrig.delete(pid); S.charPids.delete(pid);
    const div = divOf(pid); if (div) fillPara(div, p); markDiv(pid);
    S.ops.push({ t: 'charRevert', pid });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
  }
  // 용지 여백(mm) — 모든 구역
  const PF = [['pTop', 'top'], ['pBottom', 'bottom'], ['pLeft', 'left'], ['pRight', 'right'], ['pHeader', 'header'], ['pFooter', 'footer']];
  function fillPage() {
    const m = H.pageMargins(S.doc); if (!m) { toast('이 문서는 용지 정보를 찾지 못했어요', true); return false; }
    PF.forEach(([id, k]) => { $(`#${id}`).value = m[k]; });
    $('#btnPageRevert').disabled = !S.pageChanged; return true;
  }
  $('#btnPage').onclick = () => { if (S.doc && fillPage()) $('#pageSheet').hidden = false; };
  const closePage = () => { $('#pageSheet').hidden = true; };
  $('#pageX').onclick = closePage; $('#btnPageClose').onclick = closePage;
  $('#pageSheet').addEventListener('click', (e) => { if (e.target.id === 'pageSheet') closePage(); });
  document.querySelectorAll('#pPre button').forEach((b) => { b.onclick = () => { b.dataset.p.split(',').forEach((v, i) => { $(`#${PF[i][0]}`).value = v; }); }; });
  $('#btnPageApply').onclick = () => {
    const mm = {}; for (const [id, k] of PF) { const v = parseFloat($(`#${id}`).value); mm[k] = isFinite(v) ? Math.max(0, Math.min(100, v)) : 0; }
    const pg = S.doc.sections[0].page; if ((mm.left + mm.right) * 7200 / 25.4 > pg.w * 0.8) { toast('왼쪽·오른쪽 여백이 너무 커요', true); return; }
    applyPage(mm); $('#btnPageRevert').disabled = false; toast('용지 여백을 바꿨어요');
  };
  $('#btnPageRevert').onclick = () => { revertPage(); fillPage(); toast('원래 여백으로 돌렸어요'); };
  function paintPages() {
    document.querySelectorAll('.hpage').forEach((el) => { const pg = (S.doc.sections[+el.dataset.sec] || {}).page; if (pg) el.style.padding = `${U(pg.mt)}px ${U(pg.mr)}px ${U(pg.mb)}px ${U(pg.ml)}px`; });
    fitPages();
  }
  function applyPage(mm, replay) {
    if (!S.pageOrig) S.pageOrig = H.pageMargins(S.doc, true);   // 되돌리기는 원래 값 그대로
    H.setPageMargins(S.doc, mm); S.pageChanged = true; paintPages();
    S.ops.push({ t: 'page', mm });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
  }
  function revertPage(replay) {
    if (!S.pageOrig) return;
    H.setPageMargins(S.doc, S.pageOrig); S.pageOrig = null; S.pageChanged = false; paintPages();
    S.ops.push({ t: 'pageRevert' });
    S.blob = null; if (!replay) { saveDraft(); updateBar(); }
  }
  const divOf = (pid) => document.querySelector(`.para[data-pid="${pid}"]`);
  function markDiv(pid) {
    const div = divOf(pid); if (!div) return;
    div.classList.toggle('changed', S.changes.has(pid) || S.fmtPids.has(pid) || S.charPids.has(pid));
    for (const sel of ['.tbl-wrap', '.box']) { const w = div.closest(sel); if (w) w.classList.toggle('has-changed', !!w.querySelector('.para.changed')); }
  }
  // 저장 전 고친 내용(글자 + 문단 모양 작업 순서)을 이 기기에 잠시 보관
  function saveDraft() { if (!S.replaying) S.redo = []; if (nChanged()) store.set(S.draftKey, { v: 3, ops: S.ops }); else store.del(S.draftKey); }
  function restoreDraft(draft) {
    const run = (op) => { try {
      if (op.t === 'text') applyEdit(op.pid, op.text, true);
      else if (op.t === 'fmt') applyFmt(op.pids, op.shape, op.mode, true);
      else if (op.t === 'fmtRevert') revertFmt(op.pid, true);
      else if (op.t === 'char') applyChar(op.pid, op.range, op.ch, true);
      else if (op.t === 'charRevert') revertChar(op.pid, true);
      else if (op.t === 'page') applyPage(op.mm, true);
      else if (op.t === 'pageRevert') revertPage(true);
    } catch (e) { /* 건너뜀 */ } };
    if (draft && draft.v === 3) (draft.ops || []).forEach(run);
    else {   // 예전 형식(v1: {pid:text}, v2: {text, fmt})
      const text = draft && draft.v === 2 ? draft.text || {} : draft || {};
      for (const [pid, t] of Object.entries(text)) run({ t: 'text', pid: +pid, text: t });
      for (const op of (draft && draft.v === 2 ? draft.fmt || [] : [])) run(op.revert != null ? { t: 'fmtRevert', pid: op.revert } : { t: 'fmt', ...op });
    }
    saveDraft();
  }
  const viewEd = () => (S.view && S.view.editor) || null;
  const nChanged = () => new Set([...S.changes.keys(), ...S.fmtPids, ...S.charPids]).size + (S.pageChanged ? 1 : 0) + (viewEd() ? viewEd().count() : 0);
  function updateBar() { $('#nChanged').textContent = nChanged(); $('#btnSave').disabled = !(S.doc || viewEd()); if (viewEd()) $('#kvEdits').textContent = viewEd().count() ? `고친 곳 ${viewEd().count()}` : ''; $('#btnUndo').disabled = !(S.ops && S.ops.length) || !!S.busy; $('#btnRedo').disabled = !(S.redo && S.redo.length) || !!S.busy; }

  // ── 찾기 · 고친 곳만 ──
  const Q = { hits: [], i: -1 };
  function runSearch() {
    const q = $('#q').value.trim(); Q.hits = [];
    document.querySelectorAll('.para').forEach((d) => { const hit = !!q && d.textContent.includes(q); d.classList.toggle('hit', hit); if (hit) Q.hits.push(d); });
    Q.i = Q.hits.length ? 0 : -1; showHit();
  }
  function showHit() {
    const q = $('#q').value.trim();
    $('#qCount').textContent = q ? (Q.hits.length ? `${Q.i + 1}/${Q.hits.length}` : '없음') : '';
    $('#qPrev').disabled = $('#qNext').disabled = Q.hits.length < 2;
    document.querySelectorAll('.para.cur').forEach((d) => d.classList.remove('cur'));
    const d = Q.hits[Q.i]; if (d) { d.classList.add('cur'); d.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  const stepHit = (k) => { if (!Q.hits.length) return; Q.i = (Q.i + k + Q.hits.length) % Q.hits.length; showHit(); };
  $('#q').addEventListener('input', runSearch);
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } });
  $('#qNext').onclick = () => stepHit(1); $('#qPrev').onclick = () => stepHit(-1);

  // ── 되돌리기 · 다시 실행: 처음 연 원본에 작업 기록(ops)을 하나 빼고/더해 다시 적용 ──
  async function rebuild(ops) {
    const y = window.scrollY; S.busy = true; S.replaying = true; updateBar();
    try {
      const doc = await window.HWPX.open(S.orig.slice(0));
      Object.assign(S, { doc, changes: new Map(), blob: null, cur: -1, ops: [], fmtPids: new Set(), fmtOrigRef: new Map(), fmtOrigShape: new Map(), charPids: new Set(), charOrig: new Map(), pageOrig: null, pageChanged: false });
      ['#sheet', '#saveSheet', '#pageSheet'].forEach((id) => { $(id).hidden = true; });
      render(); restoreDraft({ v: 3, ops });
      $('#doc').classList.toggle('only-changed', $('#btnChanged').getAttribute('aria-pressed') === 'true');
      $('#btnChanged').setAttribute('aria-pressed', String($('#doc').classList.contains('only-changed')));
      if ($('#q').value.trim()) runSearch();
    } catch (err) { console.error(err); toast('되돌리지 못했어요', true); }
    finally { S.replaying = false; S.busy = false; updateBar(); window.scrollTo(0, y); }
  }
  $('#btnUndo').onclick = async () => { if (S.busy || !S.ops.length) return; const ops = S.ops.slice(0, -1); const redo = [...S.redo, S.ops[S.ops.length - 1]]; await rebuild(ops); S.redo = redo; updateBar(); toast('되돌렸어요'); };
  $('#btnRedo').onclick = async () => { if (S.busy || !S.redo.length) return; const redo = S.redo.slice(0, -1); await rebuild([...S.ops, S.redo[S.redo.length - 1]]); S.redo = redo; updateBar(); toast('다시 실행했어요'); };

  // ── PDF 로 저장: 인쇄 창(「PDF로 저장」)에 문서 쪽만 실제 크기로 ──
  $('#btnPdf').onclick = () => {
    if (!S.doc) return;
    if ($('#btnChanged').getAttribute('aria-pressed') === 'true') $('#btnChanged').onclick();   // 고친 곳만 보기면 전체로
    const pg = S.doc.sections[0].page; const mm = (v) => `${((v || 0) / 7200 * 25.4).toFixed(1)}mm`;
    let st = $('#printPage'); if (!st) { st = document.createElement('style'); st.id = 'printPage'; document.head.appendChild(st); }
    st.textContent = `@page { size: ${mm(pg.w)} ${mm(pg.h)}; margin: ${mm(pg.mt)} ${mm(pg.mr)} ${mm(pg.mb)} ${mm(pg.ml)}; }`;
    const name = S.file.name.replace(/\.hwpx?$/i, '');
    toast('인쇄 창에서 프린터를 「PDF로 저장」으로 고르세요');
    if (window.AndroidBridge && window.AndroidBridge.printPdf) { const r = window.AndroidBridge.printPdf(name); if (r !== 'ok') toast(`PDF 를 만들지 못했어요: ${r}`, true); return; }
    const t = document.title; document.title = name; setTimeout(() => { window.print(); document.title = t; }, 300);
  };

  // ── 최근 문서: 이 휴대폰 안(IndexedDB)에 원본 사본을 최대 12개 보관 · 별표 · 이름 찾기 ──
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('hwpxm', 1); r.onupgradeneeded = () => r.result.createObjectStore('recent', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const run = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('recent', mode); const q = fn(t.objectStore('recent')); t.oncomplete = () => res(q ? q.result : undefined); t.onerror = () => rej(t.error); }); };
    return { all: () => run('readonly', (s) => s.getAll()), count: () => run('readonly', (s) => s.count()), get: (id) => run('readonly', (s) => s.get(id)),
      put: (v) => run('readwrite', (s) => s.put(v)), del: (id) => run('readwrite', (s) => s.delete(id)), clear: () => run('readwrite', (s) => s.clear()) };
  })();
  const RECENT_MAX = 12, RECENT_BYTES = 30 * 1024 * 1024;
  async function rememberRecent(f, buf, id) {
    try {
      if (buf.byteLength > RECENT_BYTES) return;
      const old = await idb.get(id);
      await idb.put({ id, name: f.name, size: buf.byteLength, at: Date.now(), star: !!(old && old.star), buf });
      const all = (await idb.all()).sort((a, b) => (b.star - a.star) || (b.at - a.at));
      for (const r of all.slice(RECENT_MAX)) await idb.del(r.id);
    } catch (e) { /* 저장공간이 없으면 최근 목록 없이 쓴다 */ }
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = (t) => { const d = new Date(t), n = new Date(); const p2 = (x) => String(x).padStart(2, '0');
    return d.toDateString() === n.toDateString() ? `오늘 ${p2(d.getHours())}:${p2(d.getMinutes())}` : `${d.getMonth() + 1}월 ${d.getDate()}일`; };
  async function renderRecent() {
    let all = [];
    try { all = (await idb.all()).sort((a, b) => (b.star - a.star) || (b.at - a.at)); } catch (e) { /* 저장공간 없음 */ }
    $('#recent').hidden = !all.length; $('#rq').hidden = all.length <= 5;
    const q = $('#rq').value.trim();
    const list = q ? all.filter((r) => r.name.includes(q)) : all;
    $('#recentList').innerHTML = list.map((r) => `<li data-id="${esc(r.id)}">
      <button type="button" class="rstar" aria-pressed="${r.star}" aria-label="${r.star ? '별표 빼기' : '별표'}">${r.star ? '★' : '☆'}</button>
      <button type="button" class="ropen"><b>${esc(r.name)}</b><small>${when(r.at)} · ${Math.max(1, Math.round(r.size / 1024))}KB${store.get(r.id) ? ' · <span class="draft">고치던 중</span>' : ''}</small></button>
      <button type="button" class="rdel" aria-label="목록에서 지우기">×</button></li>`).join('') || '<li class="muted" style="padding:10px 2px">찾는 이름이 없어요</li>';
  }
  $('#rq').addEventListener('input', renderRecent);
  $('#recentList').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]'); if (!li) return; const id = li.dataset.id;
    const r = await idb.get(id).catch(() => null); if (!r) { renderRecent(); return; }
    if (e.target.closest('.rstar')) { r.star = !r.star; await idb.put(r); renderRecent(); return; }
    if (e.target.closest('.rdel')) { await idb.del(id); renderRecent(); return; }
    if (e.target.closest('.ropen')) openFile(new File([r.buf], r.name));
  });
  $('#btnRecentClear').onclick = async () => { if (!confirm('최근 문서 목록을 모두 지울까요? (휴대폰의 원래 파일은 그대로예요)')) return; await idb.clear().catch(() => {}); renderRecent(); };
  renderRecent();
  $('#btnChanged').onclick = () => { const on = $('#btnChanged').getAttribute('aria-pressed') !== 'true'; $('#btnChanged').setAttribute('aria-pressed', String(on)); $('#doc').classList.toggle('only-changed', on); };

  // ── 저장 · 공유 ──
  const outName = () => (viewEd() ? `${S.file.name.replace(/\.[^.]+$/, '')}_수정.${viewEd().ext}` : `${S.file.name.replace(/\.hwpx?$/i, '')}_수정.hwpx`);
  const outMime = () => (viewEd() ? viewEd().mime : 'application/hwp+zip');
  // 한글 외(Excel·PowerPoint) 고치기 창 — viewer.js 가 { title, value, note, multiline, canRevert, apply(v), revert() } 로 부른다
  let editReq = null;
  function openEdit(req) {
    editReq = req; $('#esT').textContent = req.title; $('#esNote').textContent = req.note || ''; $('#esNote').hidden = !req.note;
    const ta = $('#esTa'); ta.value = req.value; ta.rows = req.multiline ? 5 : 1; $('#esRevert').disabled = !req.canRevert;
    $('#editSheet').hidden = false; setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 60);
  }
  const closeEdit = () => { $('#editSheet').hidden = true; editReq = null; };
  $('#esX').onclick = closeEdit; $('#esCancel').onclick = closeEdit;
  $('#editSheet').addEventListener('click', (e) => { if (e.target.id === 'editSheet') closeEdit(); });
  $('#esTa').addEventListener('keydown', (e) => { if (e.key === 'Enter' && editReq && !editReq.multiline) { e.preventDefault(); $('#esApply').click(); } });
  $('#esApply').onclick = () => { if (!editReq) return; try { editReq.apply($('#esTa').value); closeEdit(); toast('고쳤어요 — 다 고친 뒤 「저장」을 누르세요'); } catch (err) { toast(err.message || '고치지 못했어요', true); } };
  $('#esRevert').onclick = () => { if (!editReq) return; editReq.revert(); closeEdit(); toast('원래대로 돌렸어요'); };
  $('#btnSave').onclick = async () => {
    if (!S.doc && !viewEd()) return;
    if (viewEd() && !viewEd().count()) { toast('아직 고친 곳이 없어요'); return; }
    try {
      $('#btnSave').disabled = true;
      if (!S.blob) S.blob = viewEd() ? await viewEd().save() : await window.HWPX.save(S.doc);
      $('#saveMsg').textContent = `${outName()} · 고친 곳 ${nChanged()}개 · ${(S.blob.size / 1024).toFixed(0)}KB`;
      const f = new File([S.blob], outName(), { type: outMime() });
      $('#btnShare').hidden = !(NATIVE || (navigator.canShare && navigator.canShare({ files: [f] })));
      $('#btnDownload').textContent = NATIVE ? '휴대폰 「다운로드」 폴더에 저장' : IOS && !$('#btnShare').hidden ? '「파일」 앱에 저장 · 공유' : `내려받기(.${viewEd() ? viewEd().ext : 'hwpx'})`;
      if (IOS) $('#btnShare').hidden = true;   // 아이폰은 공유 창 하나에서 「파일에 저장」·메일·메신저를 모두 고른다
      $('#saveSheet').hidden = false;
    } catch (err) { console.error(err); toast(`저장하지 못했어요: ${err.message}`, true); }
    finally { updateBar(); }
  };
  $('#saveX').onclick = () => { $('#saveSheet').hidden = true; };
  // 안드로이드 앱(AndroidBridge): 다운로드 폴더 저장·공유는 앱이 맡는다(웹뷰는 blob 내려받기를 못 함)
  const NATIVE = !!(window.AndroidBridge && window.AndroidBridge.saveFile);
  const b64of = async (blob) => { const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  $('#btnDownload').onclick = async () => {
    if (NATIVE) {
      const r = window.AndroidBridge.saveFile2 ? window.AndroidBridge.saveFile2(outName(), await b64of(S.blob), outMime()) : window.AndroidBridge.saveFile(outName(), await b64of(S.blob));
      if (r === 'ok') { store.del(S.draftKey); $('#saveSheet').hidden = true; toast('다운로드 폴더에 저장했어요'); } else toast(`저장하지 못했어요: ${r}`, true);
      return;
    }
    if (IOS && navigator.canShare && navigator.canShare({ files: [new File([S.blob], outName())] })) { $('#btnShare').onclick(); return; }   // 홈 화면 앱은 내려받기가 막혀 공유 창으로
    const a = document.createElement('a'); a.href = URL.createObjectURL(S.blob); a.download = outName(); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    store.del(S.draftKey); $('#saveSheet').hidden = true; toast('내려받았어요');
  };
  $('#btnShare').onclick = async () => {
    if (NATIVE) { const r = window.AndroidBridge.shareFile2 ? window.AndroidBridge.shareFile2(outName(), await b64of(S.blob), outMime()) : window.AndroidBridge.shareFile(outName(), await b64of(S.blob)); if (r === 'ok') { store.del(S.draftKey); $('#saveSheet').hidden = true; } else toast(`공유하지 못했어요: ${r}`, true); return; }
    try { await navigator.share({ files: [new File([S.blob], outName(), { type: outMime() })], title: outName() }); store.del(S.draftKey); $('#saveSheet').hidden = true; }
    catch (err) { if (err && err.name !== 'AbortError') toast('공유하지 못했어요 — 내려받기를 써 주세요', true); }
  };
  window.addEventListener('beforeunload', (e) => { if (nChanged()) { e.preventDefault(); e.returnValue = ''; } });
  // 안드로이드 뒤로 가기: 열린 창이 있으면 닫고 true(앱 종료 안 함)
  window.hwpxBack = () => { for (const id of ['#pickMiss', '#sheet', '#saveSheet', '#pageSheet', '#editSheet']) if (!$(id).hidden) { $(id).hidden = true; S.cur = -1; return true; } if ($('#start').hidden && (S.doc || S.view)) { showStart(true); return true; } return false; };
  window.hwpxHasChanges = () => nChanged() > 0;
  window.HWPXM = S;   // 시험용(콘솔에서 상태 보기)
})();
