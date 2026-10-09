// 현장 안내 화면: 편지 작성 페이지로 가는 QR 코드를 보여 줍니다.
import qrcode from './vendor/qrcode.mjs';
import { createMotionControl, startEmojiLayer } from './ui-common.js';

const WRITE_URL_META = 'arisa-write-url';

/** meta 에 주소를 적어 두었으면 그 주소, 없으면 이 서비스의 첫 화면(편지 쓰기) 주소 */
function resolveWriteUrl() {
  const meta = document.querySelector(`meta[name="${WRITE_URL_META}"]`);
  const custom = meta ? meta.content.trim() : '';
  if (custom) {
    try {
      const url = new URL(custom);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch { /* 아래에서 기본 주소 사용 */ }
  }
  return new URL('/', window.location.origin).href;
}

/** QR 모듈을 하나의 SVG path 로 그림 (이미지 파일·캔버스 없음) */
function renderQr(container, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `아리사에게 편지를 쓰는 페이지로 연결되는 QR 코드. 주소: ${text}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#3B2230');
  svg.append(bg, path);
  container.replaceChildren(svg);
}

function setupFullscreen(button) {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!request || !exit) {
    button.hidden = true;
    return;
  }
  const isFull = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const label = () => { button.textContent = isFull() ? '전체화면 닫기' : '전체화면'; };
  button.addEventListener('click', () => {
    const result = isFull() ? exit.call(document) : request.call(el);
    if (result && result.catch) result.catch(() => {});
  });
  document.addEventListener('fullscreenchange', label);
  document.addEventListener('webkitfullscreenchange', label);
  label();
}

// 전시 중에 태블릿 화면이 꺼지지 않게 함 (지원하는 기기에서만, 실패해도 무시)
function keepAwake() {
  let lock = null;
  async function acquire() {
    if (!('wakeLock' in navigator) || document.hidden || lock) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch { lock = null; }
  }
  document.addEventListener('visibilitychange', acquire);
  acquire();
}

function init() {
  const url = resolveWriteUrl();
  renderQr(document.getElementById('qr'), url);
  document.getElementById('qr-url').textContent = url;

  createMotionControl({
    key: 'display:motion',
    button: document.getElementById('motion-btn'),
    labels: () => ({ on: '움직임 켜기', off: '움직임 끄기' }),
  });
  startEmojiLayer(document.getElementById('emoji-layer'), { columnWidth: 520 });
  setupFullscreen(document.getElementById('fullscreen-btn'));
  keepAwake();
}

init();
