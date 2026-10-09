import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOJI_CONFIG, planEmojis, mulberry32, makeSlots } from '../public/assets/emoji-layer.js';
import qrcode from '../public/assets/vendor/qrcode.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.wrangler', '.dev.vars', '.mock-db'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.md', '.sql', '.toml', '.svg', '.example', '.ts']);
const allFiles = walk(ROOT).filter((f) => TEXT_EXT.has(extname(f)) || f.endsWith('_headers') || f.endsWith('.gitignore'));
const ownFiles = allFiles.filter((f) => !f.includes(join('public', 'assets', 'vendor')) && !f.endsWith('package-lock.json'));
const publicCode = ownFiles.filter((f) => /[\\/]public[\\/]/.test(f));
const uiSources = publicCode.filter((f) => ['.css', '.js', '.html', '.svg'].includes(extname(f)));
const themeCss = read('public/assets/arisa-theme.css');
const letterboxCss = read('public/assets/letterbox.css');
const lettersCss = read('public/assets/letters.css');

/* ---------- 색 계산 ---------- */
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const blend = (fg, alpha, bg) => `#${hex(fg).map((c, i) => Math.round(c * alpha + hex(bg)[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;

test('색 토큰: 기획서의 아리사 핑크 테마와 정확히 같음', () => {
  const block = /\.arisa-theme\s*\{([^}]*)\}/.exec(themeCss)[1];
  const expected = {
    '--arisa-bg-1': '#FFF4F7', '--arisa-bg-2': '#F5C9D9', '--arisa-bg-3': '#E9A9C4',
    '--arisa-pink-light': '#FBE0EA', '--arisa-pink': '#D979A0', '--arisa-rose': '#AD3E6C', '--arisa-rose-dark': '#873253',
    '--arisa-text': '#4E303D', '--arisa-text-sub': '#775763',
    '--arisa-paper': '#FFFDF9', '--arisa-paper-line': '#F4DCE4',
    '--arisa-card-bg': 'rgba(255, 252, 253, 0.82)', '--arisa-card-border': 'rgba(255, 255, 255, 0.85)',
    '--arisa-glow': 'rgba(255, 119, 173, 0.30)', '--arisa-shadow': 'rgba(145, 55, 94, 0.14)',
  };
  for (const [name, value] of Object.entries(expected)) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
    assert.ok(m, `${name} 없음`);
    assert.equal(m[1].trim(), value, name);
  }
  assert.match(themeCss, /linear-gradient\(165deg, #FFF4F7 0%, #F5C9D9 52%, #E9A9C4 100%\)/);
  assert.match(themeCss, /--arisa-btn: linear-gradient\(135deg, #AD3E6C 0%, #AD3E6C 40%, #C9638C 100%\)/);
});

test('색 대비: 글자와 버튼이 WCAG AA(4.5:1) 이상', () => {
  const cardOnPink = blend('#FFFCFD', 0.82, '#F5C9D9');
  const pairs = [
    ['본문 글자 / 카드', '#4E303D', cardOnPink],
    ['보조 글자 / 카드', '#775763', cardOnPink],
    ['보조 글자 / 편지지', '#775763', '#FFFDF9'],
    ['편지 글자 / 편지지', '#4E303D', '#FFFDF9'],
    ['로즈 강조 글자 / 카드', '#AD3E6C', cardOnPink],
    ['오류 글자 / 흰 배경', '#A32653', '#FFFFFF'],
    ['버튼 흰 글자 / 버튼 시작색', '#FFFFFF', '#AD3E6C'],
    ['버튼 흰 글자 / 버튼 가운데', '#FFFFFF', blend('#C9638C', 0.45, '#AD3E6C')],
    ['안내줄 흰 글자 / 진한 로즈', '#FFFFFF', '#873253'],
    ['자리표시 글자 / 편지지', '#8C6B78', '#FFFDF9'],
  ];
  for (const [label, fg, bg] of pairs) {
    assert.ok(contrast(fg, bg) >= 4.5, `${label}: ${contrast(fg, bg).toFixed(2)}`);
  }
});

test('독립성: 모카 라벤더 색·변수·이름이 코드에 남아 있지 않음', () => {
  const lavender = [
    '#EEF1F8', '#DDD9ED', '#F3E3EB', '#34354A', '#77649C', '#C58EA5', '#E8D5AD', '#686A80', '#8E7AB4',
    '#E6DFF1', '#D8CFE8', '#CDBFF0', '#B7A5E3', '#D9CDF5', '#B09DDF', '#9A9BB0', '#B9A4E6',
  ];
  for (const file of uiSources) {
    const text = readFileSync(file, 'utf8');
    for (const color of lavender) assert.ok(!text.toUpperCase().includes(color.toUpperCase()), `${relative(ROOT, file)} 에 ${color}`);
    assert.ok(!/--letter-|rgba\(119,\s*100,\s*156|rgba\(84,\s*72,\s*120|rgba\(52,\s*53,\s*74/.test(text), `${relative(ROOT, file)} 에 모카 변수/색`);
  }
});

test('독립성: 코드·서버·DB 어디에도 모카 이름(moka)을 쓰지 않음 (문서·테스트 제외, 주소 mokano.live 안내만 허용)', () => {
  const codeFiles = ownFiles.filter((f) => /[\\/](public|server|functions|scripts|supabase)[\\/]/.test(f) && !f.endsWith('.md'));
  assert.ok(codeFiles.length > 20);
  for (const file of codeFiles) {
    const text = readFileSync(file, 'utf8').replace(/mokano\.live/gi, '');
    assert.ok(!/moka/i.test(text), `${relative(ROOT, file)} 에 moka`);
  }
  // 화면·서버 코드에는 mokano.live 도 없음
  for (const file of codeFiles.filter((f) => /[\\/](public|server|functions)[\\/]/.test(f))) {
    assert.ok(!/mokano/i.test(readFileSync(file, 'utf8')), `${relative(ROOT, file)} 에 mokano`);
  }
});

test('보안: 비밀값(Supabase 키·접근 코드)이 저장소 파일에 들어 있지 않음', () => {
  const jwt = /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}/;
  for (const file of ownFiles) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!jwt.test(text), `${relative(ROOT, file)} 에 JWT 형태의 값`);
    assert.ok(!/sb_secret_[A-Za-z0-9_-]{10,}/.test(text), `${relative(ROOT, file)} 에 sb_secret 키`);
  }
  const ignore = read('.gitignore');
  assert.match(ignore, /^\.dev\.vars$/m);
  assert.match(ignore, /^\.env$/m);
  const example = read('.dev.vars.example');
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'LETTER_COOKIE_SECRET', 'ARISA_ACCESS_CODE', 'ARISA_ADMIN_UIDS']) {
    assert.match(example, new RegExp(`^${name}=$`, 'm'), `${name} 예시는 값이 비어 있어야 함`);
  }
  // 서비스 키 이름이 브라우저 공개 변수로 쓰이지 않음
  for (const file of uiSources) assert.ok(!/SERVICE_ROLE|LETTER_COOKIE_SECRET|ARISA_ACCESS_CODE/.test(readFileSync(file, 'utf8')), relative(ROOT, file));
});

test('격리: 쿠키·저장소 이름이 아리사 전용 이름표를 씀', () => {
  assert.match(read('server/letters-api.js'), /COOKIE_NAME = 'arisa_letter_bid'/);
  assert.match(read('server/reader-api.js'), /READER_COOKIE = 'arisa_reader_session'/);
  assert.match(read('server/admin-api.js'), /ADMIN_COOKIE = 'arisa_admin_session'/);
  assert.match(read('public/assets/ui-common.js'), /NS = 'arisa:'/);
  const keys = [...uiSources.filter((f) => f.endsWith('.js')).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?:key|sort|motion|lang|nextAllowedAt):\s*'([a-z]+:[A-Za-z]+)'|storage\.(?:get|set|remove)\('([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1] || m[2]))];
  assert.ok(keys.length > 0);
  assert.ok(keys.every((k) => /^(letters|letterbox|display):/.test(k)), keys.join(','));
});

test('봉투 열기 연출: 길이·순서·움직임이 기존 편지함과 같음', () => {
  assert.match(letterboxCss, /\.lb-stage-flap\s*\{[^}]*transform-origin:\s*top;\s*animation:\s*lb-flap 0\.5s ease 0\.35s forwards/);
  assert.match(letterboxCss, /\.lb-stage-seal\s*\{[^}]*animation:\s*lb-seal 0\.3s ease forwards/);
  assert.match(letterboxCss, /\.lb-stage-paper\s*\{[^}]*animation:\s*lb-paper 0\.55s ease 0\.85s forwards/);
  assert.match(letterboxCss, /@keyframes lb-seal \{ to \{ opacity: 0; transform: translateX\(-50%\) scale\(0\.4\); \} \}/);
  assert.match(letterboxCss, /@keyframes lb-flap \{ to \{ transform: rotateX\(180deg\); z-index: 1; \} \}/);
  assert.match(letterboxCss, /@keyframes lb-paper \{ to \{ transform: translateY\(-46px\); \} \}/);
  assert.match(letterboxCss, /\.lb-stage \{[^}]*width: min\(260px, 70vw\); height: 190px;[^}]*perspective: 700px/);
  assert.match(read('public/assets/letterbox.js'), /const OPEN_MS = 1400;/);
  // 봉투 열기 키프레임은 이모지 쪽 CSS 에서 쓰지 않음 (서로 영향 없음)
  assert.ok(!/lb-flap|lb-paper|lb-seal/.test(themeCss));
});

test('이모지 키프레임: Enchant → Shimmer → Disenchant → Dissolve 단계와 transform 분리', () => {
  const body = /@keyframes arisaDisenchant \{([\s\S]*?)\n\}/.exec(themeCss)[1];
  assert.match(body, /0% \{ opacity: 0; filter: saturate\(1\.2\) brightness\(1\.08\); transform: scale\(0\.85\);/);
  assert.match(body, /16% \{ opacity: 0\.88; filter: saturate\(1\.2\) brightness\(1\.12\); transform: scale\(1\.05\);/);
  assert.match(body, /42% \{ opacity: 0\.9; filter: saturate\(1\.05\); transform: scale\(1\);/);
  assert.match(body, /72% \{ opacity: 0\.48; filter: saturate\(0\.55\) brightness\(1\); transform: scale\(0\.94\);/);
  assert.match(body, /100% \{ opacity: 0; filter: saturate\(0\); transform: scale\(0\.8\);/);
  // 바깥(이동) 키프레임은 transform 만, 안쪽 생명주기는 opacity/filter/scale
  for (const name of ['arisaFall', 'arisaSway', 'arisaRise', 'arisaFloat']) {
    const k = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(themeCss)[1];
    assert.ok(!/opacity|filter/.test(k), `${name} 은 위치만 바꿈`);
  }
  assert.match(themeCss, /\.ae\.is-fall \{ animation-name: arisaFall; \}/);
  assert.match(themeCss, /\.ae__life \{[^}]*animation-name: arisaDisenchant/);
  // 같은 duration 변수를 써서 이동·후광·입자가 한 생명주기 안에서 움직임
  assert.match(themeCss, /\.ae__life,\s*\n\.ae__glyph,\s*\n\.ae__halo,\s*\n\.ae__p \{[^}]*animation-duration: var\(--dur\)/);
});

test('이모지 CSS: 클릭·선택 불가, 모션 줄이기·비활성 탭 정지, 정적 대체 모습', () => {
  assert.match(themeCss, /\.emoji-layer \{[^}]*pointer-events: none;[^}]*user-select: none;/);
  assert.match(themeCss, /\.is-page-hidden \.ae,[\s\S]*animation-play-state: paused/);
  assert.match(themeCss, /\.motion-off \*,[\s\S]*animation: none !important/);
  assert.match(themeCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*html:not\(\.motion-on\)/);
  assert.match(themeCss, /\.ae__life \{[^}]*opacity: 0\.55;/); // 애니메이션 없이도 보이는 정지 모습
  assert.match(themeCss, /\.emoji-layer\.is-dim \{\s*opacity: 0\.3;/); // 긴 편지를 읽을 때 흐리게
  // 무거운 효과 없음
  assert.ok(!/backdrop-filter|blur\(/.test(themeCss + lettersCss + letterboxCss));
  assert.ok(!/<canvas|getContext\(/.test(uiSources.map((f) => readFileSync(f, 'utf8')).join('\n')));
});

test('이모지 배치: 개수·비율·가장자리·시차·같은 입력이면 같은 결과', () => {
  for (const [width, max, label] of [[360, 14, 'mobile'], [390, 14, 'mobile'], [820, 24, 'desktop'], [1440, 24, 'desktop']]) {
    const { items } = planEmojis({ width, columnWidth: 600 });
    assert.ok(items.length >= (max === 14 ? 10 : 18) && items.length <= max, `${label} ${items.length}`);
    const sad = items.filter((i) => i.group === 'disenchant').length;
    assert.ok(sad / items.length <= 0.3 && sad / items.length >= 0.2, `이별 계열 비율 ${sad}/${items.length}`);
    const inner = Math.max(12, Math.min(30, ((width - 600) / 2 / width) * 100 - 2));
    for (const it of items) {
      assert.ok(it.x <= inner + 0.001 || it.x >= 100 - inner - 0.001, `가장자리 밖 x=${it.x}`);
      assert.ok(it.dur >= 12 && it.dur <= 22, `주기 ${it.dur}`);
      assert.ok(it.delay <= 0 && it.delay > -it.dur, '서로 다른 시점에서 시작');
      assert.ok(it.y > 0 && it.y < 100);
    }
    assert.ok(new Set(items.map((i) => i.delay.toFixed(2))).size === items.length, '모두 다른 지연');
    assert.ok(new Set(items.map((i) => i.dur.toFixed(2))).size === items.length, '모두 다른 주기');
  }
  const a = planEmojis({ width: 1024, columnWidth: 600 }).items;
  const b = planEmojis({ width: 1024, columnWidth: 600 }).items;
  assert.deepEqual(a.map(({ slot, ...rest }) => rest), b.map(({ slot, ...rest }) => rest));
  const c = planEmojis({ width: 1024, columnWidth: 600, seed: 7 }).items;
  assert.notDeepEqual(a.map((i) => i.x), c.map((i) => i.x));
  const r1 = mulberry32(5);
  const r2 = mulberry32(5);
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
  assert.equal(makeSlots(22, 1440, 600).length, 22);
});

test('이모지 종류: 기획서의 1차·2차 그룹과 같음', () => {
  assert.deepEqual([...EMOJI_CONFIG.enchant], ['💖', '💗', '💞', '🩷', '💕', '🎀', '🌸', '✨']);
  assert.deepEqual([...EMOJI_CONFIG.disenchant], ['🫧', '🥀', '🥹', '💔']);
  assert.ok(EMOJI_CONFIG.counts.mobile <= 14 && EMOJI_CONFIG.counts.desktop <= 24);
  const { items } = planEmojis({ width: 1440, columnWidth: 600 });
  const glyphs = new Set(items.map((i) => i.glyph));
  for (const g of EMOJI_CONFIG.disenchant.slice(0, 3)) assert.ok(glyphs.has(g), `${g} 사용`);
});

test('화면(HTML): 장식은 접근성 트리에서 제외, 인라인 스크립트·스타일 없음(CSP), 검색 제외', () => {
  const pages = ['index.html', 'arisa.html', 'admin.html', 'admin/preview.html', 'display.html'];
  for (const page of pages) {
    const html = read(`public/${page}`);
    assert.match(html, /<meta name="robots" content="noindex/, `${page} noindex`);
    assert.match(html, /href="\/assets\/arisa-theme\.css"/, `${page} 테마`);
    assert.match(html, /<body class="arisa-theme"/, `${page} body`);
    assert.match(html, /class="arisa-stage" aria-hidden="true"/, `${page} 배경`);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), `${page} 인라인 스크립트`);
    assert.ok(!/\sstyle="/.test(html), `${page} 인라인 스타일`);
    assert.ok(!/\son[a-z]+="/.test(html), `${page} 인라인 이벤트`);
    if (page !== 'admin.html') assert.match(html, /class="emoji-layer"[^>]*aria-hidden="true"/, `${page} 이모지 층`);
    assert.match(html, /<noscript>/, `${page} noscript`);
  }
  const headers = read('public/_headers');
  assert.match(headers, /Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(headers));
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(publicCode.filter((f) => f.endsWith('.js')).filter((f) => !f.includes('vendor')).map((f) => readFileSync(f, 'utf8')).join('\n')), '편지 내용을 HTML 로 해석하는 코드 없음');
});

test('편지 작성 화면 구조: 기존과 같은 요소·문구 위치 (이름만 아리사)', () => {
  const html = read('public/index.html');
  for (const needle of [
    'ARISA · LAST LIVE', 'TO. ARISA', '아리사에게 보내는 편지', 'id="sender-name"', 'id="letter-content"',
    'class="paper-input"', 'rows="10"', '0 / 2,000줄 · 0.0KB / 256KB', 'id="submit-btn"', 'id="success-panel"', 'id="limited-panel"',
    'class="mini-envelope"', 'id="motion-btn"',
  ]) assert.ok(html.includes(needle), needle);
  assert.match(lettersCss, /--paper-line|var\(--paper-line\)/);
  assert.match(themeCss, /--paper-line: 30px;/);
  assert.match(lettersCss, /background-attachment: local;/);
  assert.match(lettersCss, /min-height: calc\(var\(--paper-line\) \* 8 \+ var\(--paper-pad-y\) \* 2\);/);
  assert.match(lettersCss, /max-width: 600px/);
  const i18n = read('public/assets/letters-i18n.js');
  assert.match(i18n, /2,000줄/);
  assert.match(i18n, /256KB/);
  assert.match(i18n, /48시간/);
});

test('현장 안내 QR: 실제 서비스 주소가 들어가고 읽을 수 있는 크기', () => {
  const url = 'https://arisa-letters.pages.dev/';
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  assert.ok(n >= 21 && n <= 41, `모듈 수 ${n}`);
  // 세 모서리의 위치 찾기 패턴(7x7 테두리)이 있어야 함
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let i = 0; i < 7; i++) {
      assert.ok(qr.isDark(r, c + i) && qr.isDark(r + 6, c + i) && qr.isDark(r + i, c) && qr.isDark(r + i, c + 6), '위치 패턴');
    }
  }
  const display = read('public/assets/display.js');
  assert.match(display, /new URL\('\/', window\.location\.origin\)/);
  assert.match(read('public/display.html'), /<meta name="arisa-write-url" content="" \/>/);
  assert.ok(existsSync(join(ROOT, 'public/assets/vendor/qrcode.mjs')));
  assert.match(read('public/assets/vendor/qrcode.mjs'), /Licensed under the MIT license/);
});
