// 한글 모바일 편집 — 오프라인 캐시(한 번 열면 인터넷 없이도 실행). 문서는 캐시하지 않는다(파일은 휴대폰 안에서만 다룸).
// 앱을 고치면 VER 를 올린다 → 다음 실행 때 새 파일로 바뀐다.
const VER = 'hwpxm-1.10.0';
const SHELL = ['./', 'index.html', 'app.js', 'hwpx.js', 'hwp2hwpx.js', 'style.css', 'viewer.js', 'officeedit.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/xlsx.full.min.js', 'vendor/jszip.min.js', 'vendor/docx-preview.min.js', 'vendor/pptx-preview.umd.js', 'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js', 'vendor/fonts/krri-doc-sans.ttf', 'vendor/cmaps/Adobe-Korea1-0.bcmap', 'vendor/cmaps/Adobe-Korea1-1.bcmap', 'vendor/cmaps/Adobe-Korea1-2.bcmap', 'vendor/cmaps/Adobe-Korea1-UCS2.bcmap', 'vendor/cmaps/KSC-EUC-H.bcmap', 'vendor/cmaps/KSC-EUC-V.bcmap', 'vendor/cmaps/KSC-H.bcmap', 'vendor/cmaps/KSC-Johab-H.bcmap', 'vendor/cmaps/KSC-Johab-V.bcmap', 'vendor/cmaps/KSC-V.bcmap', 'vendor/cmaps/KSCms-UHC-H.bcmap', 'vendor/cmaps/KSCms-UHC-HW-H.bcmap', 'vendor/cmaps/KSCms-UHC-HW-V.bcmap', 'vendor/cmaps/KSCms-UHC-V.bcmap', 'vendor/cmaps/KSCpc-EUC-H.bcmap', 'vendor/cmaps/KSCpc-EUC-V.bcmap', 'vendor/cmaps/UniKS-UCS2-H.bcmap', 'vendor/cmaps/UniKS-UCS2-V.bcmap', 'vendor/cmaps/UniKS-UTF16-H.bcmap', 'vendor/cmaps/UniKS-UTF16-V.bcmap', 'vendor/cmaps/UniKS-UTF32-H.bcmap', 'vendor/cmaps/UniKS-UTF32-V.bcmap', 'vendor/cmaps/UniKS-UTF8-H.bcmap', 'vendor/cmaps/UniKS-UTF8-V.bcmap', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(VER);
    const hit = req.mode === 'navigate' ? await c.match('index.html') : await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);   // 처음 쓰는 파일(그 밖의 PDF 글자 지도 등)은 받아서 캐시에 넣어 다음엔 오프라인으로
    if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
    return res;
  })());
});
