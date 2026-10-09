// 아리사 편지함(/arisa)과 관리자 미리보기(/admin/preview)가 함께 쓰는 화면 코드
// - 아리사 모드: 접근 코드 → 승인된 편지 목록 → 봉투 열기 → 원문 → 최초 열람 때만 읽음 기록
// - 관리자 미리보기 모드: 편지 한 통을 같은 연출로 보여 주기만 하고, 읽음은 절대 기록하지 않음
import { h, api, jsonInit, formatKst, nameOf, passwordField, UUID_RE } from './dom-utils.js';
import { storage, createMotionControl, startEmojiLayer } from './ui-common.js';

const MODE = document.body.dataset.mode === 'admin-preview' ? 'admin' : 'arisa';
const IS_ARISA = MODE === 'arisa';
const BASE = IS_ARISA ? '/api/arisa' : '/api/admin';
const OPEN_MS = 1400; // 봉투 열기 연출 길이 (기존 편지함과 같음)
const FILTERS = [['all', '전체'], ['unread', '아직 안 읽음'], ['read', '읽음']];

const state = {
  auth: 'checking', // checking | in | out
  filter: 'all',
  sort: storage.get('letterbox:sort') === 'asc' ? 'asc' : 'desc',
  page: 1,
  list: null,
  listState: 'loading', // loading | ready | error
  reader: null, // { id, phase: 'opening' | 'open' | 'error', detail?, record }
  notice: '',
};

const els = {};
let motion = null;
let emojiLayer = null;
let token = 0;
let detailAbort = null;
let listAbort = null;
let skipOpening = null;
let triggerId = null;
let pendingRecord = null;
let lastFocusKey = '';
const counted = new Set();

const root = document.getElementById('app');

/* ---------- 접근 코드 / 로그인 안내 화면 ---------- */
function showAuth(notice = '') {
  state.auth = 'out';
  state.notice = notice;
  state.reader = null;
  state.list = null;
  counted.clear();
  emojiLayer.setDim(false);

  const { input, wrap } = passwordField({ id: 'lb-code', label: '접근 코드', describedBy: 'lb-code-error' });
  const error = h('p', { id: 'lb-code-error', class: 'field-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block', text: '편지함 열기', disabled: true });
  const form = h('form', { class: 'lb-card lb-auth-card', novalidate: true }, [
    h('div', { class: 'lb-auth-icon', 'aria-hidden': 'true', text: '💌' }),
    h('h1', { text: '아리사만의 편지함' }),
    h('p', { class: 'lb-muted', text: '아리사에게 도착한 마음들을 열어볼까요?' }),
    notice ? h('p', { class: 'lb-auth-notice', role: 'status', text: notice }) : null,
    h('div', { class: 'lb-auth-fields' }, [
      h('label', { class: 'field-label', for: 'lb-code', text: '접근 코드' }),
      wrap,
      error,
    ]),
    submit,
  ]);

  input.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled || !input.value.trim()) return;
    submit.disabled = true;
    submit.textContent = '확인하는 중…';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    const res = await api(`${BASE}/session`, jsonInit('POST', { code: input.value }));
    if (res.ok) {
      input.value = '';
      showBox();
      return;
    }
    let message = '잠시 후 다시 시도해 주세요.';
    if (res.status === 429) {
      const minutes = Math.max(1, Math.ceil(((res.data && res.data.retryAfterSeconds) || 60) / 60));
      message = `시도가 너무 많았어요. 약 ${minutes}분 뒤에 다시 시도해 주세요.`;
    } else if (res.status === 401) message = '코드를 다시 확인해 주세요.';
    else if (res.status === 0) message = '네트워크 연결을 확인해 주세요.';
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    submit.textContent = '편지함 열기';
    submit.disabled = !input.value.trim();
    input.focus();
  });

  root.replaceChildren(h('div', { class: 'lb-auth' }, [form]));
  input.focus();
}

/* ---------- 편지함 뼈대 ---------- */
function showBox() {
  state.auth = 'in';
  state.notice = '';
  state.listState = 'loading';
  state.page = 1;

  els.counts = [];
  const countCard = (label) => {
    const num = h('div', { class: 'lb-count__num', text: '–' });
    els.counts.push(num);
    return h('div', { class: 'lb-card lb-count' }, [h('div', { class: 'lb-count__label', text: label }), num]);
  };

  els.motionBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--small', 'aria-pressed': 'false' });
  const lockBtn = h('button', { type: 'button', class: 'btn btn--primary btn--small', text: '🔒 잠그기', onclick: lock });
  els.filters = h('div', { class: 'lb-filters', role: 'group', 'aria-label': '필터' });
  els.sortSelect = h('select', { class: 'lb-select', 'aria-label': '정렬' }, [
    h('option', { value: 'desc', text: '최신순' }),
    h('option', { value: 'asc', text: '오래된순' }),
  ]);
  els.sortSelect.value = state.sort;
  els.sortSelect.addEventListener('change', () => {
    state.sort = els.sortSelect.value === 'asc' ? 'asc' : 'desc';
    state.page = 1;
    storage.set('letterbox:sort', state.sort);
    loadList();
  });
  els.listArea = h('div');
  els.placeholder = h('div', { class: 'lb-card lb-placeholder', text: '마음이 닿는 봉투를 하나 열어 주세요.' });
  els.reader = h('section', { class: 'lb-reader', tabindex: '-1', role: 'dialog', 'aria-label': '편지 읽기', hidden: true });

  root.replaceChildren(h('main', { class: 'lb-main' }, [
    h('header', { class: 'lb-head' }, [
      h('div', {}, [
        h('p', { class: 'lb-eyebrow', text: 'ARISA · LAST LIVE' }),
        h('h1', { class: 'lb-title', text: '아리사에게 도착한 편지' }),
        h('p', { class: 'lb-sub', text: '함께한 마음을 하나씩 열어 봐요.' }),
      ]),
      h('div', { class: 'lb-actions' }, [els.motionBtn, lockBtn]),
    ]),
    h('div', { class: 'lb-counts' }, [countCard('도착한 편지'), countCard('아직 안 읽음'), countCard('읽은 편지')]),
    h('div', { class: 'lb-grid' }, [
      h('section', { 'aria-label': '편지 목록' }, [
        h('div', { class: 'lb-toolbar' }, [els.filters, els.sortSelect]),
        els.listArea,
      ]),
      els.placeholder,
      els.reader,
    ]),
  ]));

  motion.bindButton(els.motionBtn, () => ({ on: '움직임 켜기', off: '움직임 끄기' }));
  renderFilters();
  renderCounts();
  renderList();
  renderReader();
  loadList();
}

function renderFilters() {
  els.filters.replaceChildren(...FILTERS.map(([key, label]) => h('button', {
    type: 'button',
    class: `btn btn--small ${state.filter === key ? 'btn--primary' : 'btn--ghost'}`,
    text: label,
    'aria-pressed': String(state.filter === key),
    onclick: () => {
      state.filter = key;
      state.page = 1;
      renderFilters();
      loadList();
    },
  })));
}

function renderCounts() {
  const c = state.list && state.list.counts;
  [c && c.total, c && c.unread, c && c.read].forEach((n, i) => {
    els.counts[i].textContent = n === undefined || n === null ? '–' : String(n);
  });
}

/* ---------- 목록 ---------- */
async function loadList() {
  if (state.auth !== 'in') return;
  if (listAbort) listAbort.abort();
  const ac = new AbortController();
  listAbort = ac;
  if (state.listState !== 'ready') state.listState = 'loading';
  renderList();
  const res = await api(`${BASE}/letters?filter=${state.filter}&sort=${state.sort}&page=${state.page}`, { signal: ac.signal });
  if (res.aborted) return;
  if (res.status === 401) return expire();
  if (!res.ok || !res.data) {
    state.listState = 'error';
    renderList();
    return;
  }
  state.list = res.data;
  if (res.data.page !== state.page) state.page = res.data.page;
  state.listState = 'ready';
  renderCounts();
  renderList();
}

function renderList() {
  const { list, listState } = state;
  const parts = [];
  if (listState === 'error') {
    parts.push(h('div', { class: 'lb-card lb-message lb-message--error', role: 'alert' }, [
      '편지를 불러오지 못했어요. ',
      h('button', { type: 'button', text: '다시 시도', onclick: loadList }),
    ]));
  }
  if (listState === 'loading' && !list) parts.push(h('p', { class: 'lb-muted', text: '불러오는 중…' }));
  if (listState === 'ready' && list && list.counts.total === 0) {
    parts.push(h('p', { class: 'lb-card lb-message', text: '아직 도착한 편지가 없어요. 마음들이 모이면 이곳에 전해질 거예요.' }));
  } else if (listState === 'ready' && list && list.items.length === 0) {
    parts.push(h('p', { class: 'lb-card lb-message', text: '이 조건에 맞는 편지가 없어요.' }));
  }
  if (list && list.items.length > 0) {
    parts.push(h('ul', { class: 'lb-list' }, list.items.map((it) => {
      const stateLabel = it.is_read ? '✓ 읽음' : '새 편지';
      return h('li', {}, [h('button', {
        type: 'button',
        class: 'lb-card lb-item',
        'data-lb-id': it.id,
        'aria-label': `${nameOf(it.sender_name)}의 편지, ${stateLabel}`,
        'aria-current': String(Boolean(state.reader && state.reader.id === it.id)),
        onclick: () => openLetter(it.id, true),
      }, [
        miniEnvelope(it.is_read),
        h('div', { class: 'lb-item__name', text: nameOf(it.sender_name) }),
        h('div', { class: 'lb-item__date', text: formatKst(it.created_at) }),
        h('span', { class: `lb-badge${it.is_read ? ' lb-badge--read' : ''}`, text: stateLabel }),
      ])]);
    })));
  }
  if (list && list.totalPages > 1) {
    parts.push(h('nav', { class: 'lb-pager', 'aria-label': '페이지' }, [
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '이전', disabled: state.page <= 1, onclick: () => { state.page -= 1; loadList(); } }),
      h('span', { 'aria-live': 'polite', text: `${list.page} / ${list.totalPages}` }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '다음', disabled: state.page >= list.totalPages, onclick: () => { state.page += 1; loadList(); } }),
    ]));
  }
  // 목록을 다시 그려도 키보드 포커스가 사라지지 않게 함
  const focusedId = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.lbId : '';
  els.listArea.replaceChildren(...parts);
  if (focusedId) els.listArea.querySelector(`[data-lb-id="${focusedId}"]`)?.focus();
}

function miniEnvelope(read) {
  return h('span', { class: 'lb-mini', 'data-read': String(read), 'aria-hidden': 'true' }, [
    h('span', { class: 'lb-mini-body' }),
    h('span', { class: 'lb-mini-flap' }),
    read ? null : h('span', { class: 'lb-mini-seal', text: '♥' }),
  ]);
}

/* ---------- 세션 ---------- */
function expire() {
  token += 1;
  if (detailAbort) detailAbort.abort();
  if (IS_ARISA) showAuth('세션이 만료되었어요. 코드를 다시 입력해 주세요.');
  else showAdminNeeded();
}

async function lock() {
  token += 1;
  if (detailAbort) detailAbort.abort();
  await api(`${BASE}/session`, { method: 'DELETE' });
  showAuth('');
}

/* ---------- 편지 열기 ---------- */
async function openLetter(id, fromList = false) {
  if (fromList) triggerId = id;
  const mine = ++token;
  if (detailAbort) detailAbort.abort();
  const ac = new AbortController();
  detailAbort = ac;
  const known = state.list && state.list.items.find((i) => i.id === id);
  const ms = motion.isReduced() ? 0 : known && known.is_read ? 300 : OPEN_MS;
  setReader({ id, phase: 'opening', record: 'idle' });

  const wait = new Promise((resolve) => {
    skipOpening = resolve;
    setTimeout(resolve, ms);
  });
  const url = IS_ARISA
    ? `${BASE}/letters/${id}?filter=${state.filter}&sort=${state.sort}`
    : `${BASE}/letters/${id}`;
  const [res] = await Promise.all([api(url, { signal: ac.signal }), wait]);
  if (res.aborted || mine !== token) return;
  if (res.status === 401) return expire();
  if (!res.ok || !res.data) {
    setReader({ id, phase: 'error', record: 'idle' });
    return;
  }
  const detail = res.data;
  setReader({ id, phase: 'open', detail, record: detail.read_at ? 'saved' : 'idle' });
  // 읽음 기록은 아리사 본인 모드에서 원문이 실제로 화면에 나온 뒤에만 한다
  if (IS_ARISA && !detail.read_at) record(id);
}

async function record(id) {
  if (!IS_ARISA) return;
  if (document.visibilityState !== 'visible') {
    pendingRecord = id;
    return;
  }
  pendingRecord = null;
  patchReader(id, { record: 'saving' });
  const res = await api(`${BASE}/letters/${id}/read`, { method: 'POST' });
  if (res.aborted) return;
  if (res.status === 401) return expire();
  if (res.ok && res.data) {
    patchReader(id, { record: 'saved', readAt: res.data.read_at });
    markLocalRead(id);
  } else {
    patchReader(id, { record: 'failed' });
  }
}

function markLocalRead(id) {
  if (!state.list) return;
  const first = !counted.has(id);
  counted.add(id);
  state.list.items = state.list.items.map((i) => (i.id === id ? { ...i, is_read: true } : i));
  if (first) {
    const c = state.list.counts;
    state.list.counts = { ...c, unread: Math.max(0, c.unread - 1), read: c.read + 1 };
  }
  renderCounts();
  renderList();
}

function patchReader(id, patch) {
  const r = state.reader;
  if (!r || r.id !== id) return;
  const { readAt, ...rest } = patch;
  const next = { ...r, ...rest };
  if (readAt && r.detail) next.detail = { ...r.detail, read_at: readAt };
  setReader(next);
}

function closeReader() {
  if (!IS_ARISA) {
    window.location.href = '/admin';
    return;
  }
  const id = triggerId;
  token += 1;
  if (detailAbort) detailAbort.abort();
  pendingRecord = null;
  state.reader = null;
  lastFocusKey = '';
  renderReader();
  loadList();
  if (id) setTimeout(() => document.querySelector(`[data-lb-id="${id}"]`)?.focus(), 50);
}

function setReader(next) {
  state.reader = next;
  renderReader();
  renderListSelection();
}

function renderListSelection() {
  if (!els.listArea) return;
  els.listArea.querySelectorAll('[data-lb-id]').forEach((btn) => {
    btn.setAttribute('aria-current', String(Boolean(state.reader && state.reader.id === btn.dataset.lbId)));
  });
}

/* ---------- 열람 영역 ---------- */
function stateLabelOf(r) {
  const d = r.detail;
  if (IS_ARISA) return r.record === 'saved' ? '✓ 읽음' : r.record === 'saving' ? '기록 중…' : '기록 대기';
  if (d.moderation_status !== 'approved') return '미승인';
  return d.read_at ? '아리사 읽음' : '아리사 미개봉';
}

function renderReader() {
  const r = state.reader;
  emojiLayer.setDim(Boolean(r));
  if (els.placeholder) els.placeholder.hidden = Boolean(r);
  const box = els.reader;
  box.hidden = !r;
  if (!r) {
    box.replaceChildren();
    return;
  }

  const closeBtn = h('button', { type: 'button', class: 'lb-close', 'aria-label': '편지 닫기', text: '✕', onclick: closeReader });
  const body = [closeBtn];

  if (r.phase === 'opening') {
    body.push(h('div', { class: 'lb-opening', 'aria-live': 'polite' }, [
      h('div', { class: 'lb-stage', 'data-fast': String(motion.isReduced()) }, [
        h('div', { class: 'lb-stage-paper' }),
        h('div', { class: 'lb-stage-body' }),
        h('div', { class: 'lb-stage-flap' }),
        h('div', { class: 'lb-stage-seal', text: '♥' }),
      ]),
      h('p', { text: '편지를 열고 있어요…' }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '연출 건너뛰기', onclick: () => skipOpening && skipOpening() }),
    ]));
  } else if (r.phase === 'error') {
    body.push(h('div', { class: 'lb-opening', role: 'alert' }, [
      h('p', { text: '편지를 불러오지 못했어요.' }),
      h('div', { class: 'lb-actions' }, [
        h('button', { type: 'button', class: 'btn btn--primary btn--small', text: '다시 시도', onclick: () => openLetter(r.id) }),
        h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '목록으로', onclick: closeReader }),
      ]),
    ]));
  } else {
    body.push(renderLetter(r));
  }
  box.replaceChildren(...body);

  // 단계가 바뀔 때만 맨 위로 이동하고 포커스를 줌 (읽음 기록 같은 작은 변화에서는 스크롤 유지)
  const key = `${r.id}:${r.phase}`;
  if (key !== lastFocusKey) {
    lastFocusKey = key;
    box.scrollTo(0, 0);
    box.focus();
  }
}

function renderLetter(r) {
  const d = r.detail;
  const unapproved = !IS_ARISA && d.moderation_status !== 'approved';
  const nav = IS_ARISA
    ? [
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '이전 편지', disabled: !d.prevId, onclick: () => d.prevId && openLetter(d.prevId) }),
      h('button', { type: 'button', class: 'btn btn--primary btn--small', text: '목록으로', onclick: closeReader }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '다음 편지', disabled: !d.nextId, onclick: () => d.nextId && openLetter(d.nextId) }),
    ]
    : [h('a', { class: 'btn btn--primary btn--small', href: '/admin', text: '관리자로 돌아가기' })];

  return h('article', { class: 'lb-letter' }, [
    h('div', { class: 'lb-letter-head' }, [
      h('div', {}, [
        h('div', { class: 'lb-letter-name', text: nameOf(d.sender_name) }),
        h('div', { class: 'lb-letter-date', text: formatKst(d.created_at) }),
      ]),
      h('span', { class: 'lb-state-pill', text: stateLabelOf(r) }),
    ]),
    unapproved ? h('p', { class: 'lb-warn', text: '미승인 편지 미리보기 · 아리사에게는 표시되지 않아요.' }) : null,
    h('div', { class: 'lb-paper', text: d.content }),
    IS_ARISA && r.record === 'failed'
      ? h('p', { class: 'lb-record-error', role: 'alert' }, [
        '읽음 표시를 저장하지 못했어요. ',
        h('button', { type: 'button', text: '다시 시도', onclick: () => record(r.id) }),
      ])
      : null,
    h('div', { class: 'lb-letter-nav' }, nav),
  ]);
}

/* ---------- 키보드: Esc 로 닫기, 좁은 화면(전체 화면 열람)에서는 Tab 이 밖으로 나가지 않게 ---------- */
document.addEventListener('keydown', (e) => {
  if (!state.reader) return;
  if (e.key === 'Escape') {
    closeReader();
    return;
  }
  if (e.key !== 'Tab' || !els.reader || window.matchMedia('(min-width: 1024px)').matches || !IS_ARISA) return;
  const f = els.reader.querySelectorAll('button:not([disabled]), a[href]');
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ---------- 탭 복귀·뒤로가기 복원: 실제 상태를 다시 확인 ---------- */
function onVisible() {
  if (document.visibilityState !== 'visible' || !IS_ARISA || state.auth !== 'in') return;
  const r = state.reader;
  if (pendingRecord && r && r.id === pendingRecord && r.phase === 'open') record(r.id);
  loadList();
}
document.addEventListener('visibilitychange', onVisible);
window.addEventListener('pageshow', (e) => { if (e.persisted) onVisible(); });
window.addEventListener('focus', onVisible);

/* ---------- 관리자 미리보기 ---------- */
function previewShell(notice) {
  return h('div', {}, [
    h('div', { class: 'lb-banner', role: 'status' }, [
      h('span', { text: notice }),
      h('a', { class: 'btn btn--ghost btn--small', href: '/admin', text: '관리자로 돌아가기' }),
    ]),
  ]);
}

function showAdminNeeded() {
  state.auth = 'out';
  root.replaceChildren(h('div', { class: 'lb-auth' }, [
    h('div', { class: 'lb-card lb-auth-card' }, [
      h('div', { class: 'lb-auth-icon', 'aria-hidden': 'true', text: '🔐' }),
      h('h1', { text: '관리자 로그인이 필요해요' }),
      h('p', { class: 'lb-muted', text: '로그인 세션이 없거나 만료되었어요.' }),
      h('a', { class: 'btn btn--primary btn--block', href: '/admin', text: '관리자 화면으로 가기' }),
    ]),
  ]));
}

async function startPreview() {
  const id = new URLSearchParams(window.location.search).get('letter') || '';
  const session = await api('/api/admin/session');
  if (!session.ok || !session.data || !session.data.authenticated) return showAdminNeeded();
  if (!UUID_RE.test(id)) {
    root.replaceChildren(h('div', { class: 'lb-auth' }, [h('div', { class: 'lb-card lb-auth-card' }, [
      h('h1', { text: '미리볼 편지를 찾을 수 없어요' }),
      h('a', { class: 'btn btn--primary btn--block', href: '/admin', text: '관리자 화면으로 가기' }),
    ])]));
    return;
  }
  // 같은 브라우저에 아리사 세션이 남아 있어도 미리보기 중에는 끊어 둠 (읽음 기록 경로를 아예 막음)
  api('/api/arisa/session', { method: 'DELETE' });

  state.auth = 'in';
  els.reader = h('section', { class: 'lb-reader lb-reader--alone', tabindex: '-1', role: 'dialog', 'aria-label': '편지 미리보기', hidden: true });
  const shell = previewShell('관리자 미리보기 · 편지를 열어도 읽음으로 기록되지 않아요.');
  root.replaceChildren(shell, h('main', { class: 'lb-main' }, [els.reader]));
  openLetter(id);
}

/* ---------- 시작 ---------- */
async function init() {
  emojiLayer = startEmojiLayer(document.getElementById('emoji-layer'), { columnWidth: 1100 });
  motion = createMotionControl({ key: 'letterbox:motion' });
  if (!IS_ARISA) {
    await startPreview();
    return;
  }
  const session = await api(`${BASE}/session`);
  if (session.ok && session.data && session.data.authenticated) showBox();
  else if (session.status === 500) {
    root.replaceChildren(h('div', { class: 'lb-auth' }, [h('div', { class: 'lb-card lb-auth-card' }, [
      h('div', { class: 'lb-auth-icon', 'aria-hidden': 'true', text: '🛠️' }),
      h('h1', { text: '편지함을 준비하고 있어요' }),
      h('p', { class: 'lb-muted', text: '지금은 편지함을 열 수 없어요. 서버 설정이 끝나면 다시 시도해 주세요.' }),
    ])]));
  } else showAuth('');
}

init();
