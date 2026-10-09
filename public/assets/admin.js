// 관리자 화면: 로그인 → 편지 목록 → 승인 / 숨김 / 승인 취소 → 미리보기 링크
// 관리자 권한은 서버가 매번 확인합니다. 이 화면은 보여 주기만 합니다.
import { h, api, jsonInit, formatKst, nameOf, passwordField } from './dom-utils.js';

const root = document.getElementById('app');
const toastArea = document.getElementById('toast-area');

const STATUS_LABEL = { pending: '대기중', approved: '승인됨', hidden: '숨김' };
const FILTERS = [['all', '전체'], ['pending', '대기중'], ['approved', '승인됨'], ['hidden', '숨김']];

const state = { status: 'all', q: '', page: 1, data: null, busyId: null, loadState: 'loading' };
let listAbort = null;
let searchTimer = 0;
let toastTimer = 0;
const els = {};

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  toastArea.replaceChildren(h('div', { class: `ad-toast${isError ? ' ad-toast--error' : ''}`, role: 'status', text: message }));
  toastTimer = setTimeout(() => toastArea.replaceChildren(), 3200);
}

/* ---------- 로그인 ---------- */
function showLogin(notice = '') {
  const email = h('input', {
    id: 'ad-email', type: 'email', class: 'text-input', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 254,
  });
  const { input: password, wrap } = passwordField({ id: 'ad-password', label: '비밀번호', autocomplete: 'current-password', describedBy: 'ad-error' });
  const error = h('p', { id: 'ad-error', class: 'field-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block', text: '로그인' });

  const form = h('form', { class: 'lb-card lb-auth-card', novalidate: true }, [
    h('div', { class: 'lb-auth-icon', 'aria-hidden': 'true', text: '🎀' }),
    h('h1', { text: '아리사 관리자' }),
    h('p', { class: 'lb-muted', text: '허용된 관리자 계정으로만 들어올 수 있어요.' }),
    notice ? h('p', { class: 'lb-auth-notice', role: 'status', text: notice }) : null,
    h('div', { class: 'lb-auth-fields' }, [
      h('label', { class: 'field-label', for: 'ad-email', text: '이메일' }),
      email,
      h('label', { class: 'field-label', for: 'ad-password', text: '비밀번호' }),
      wrap,
      error,
    ]),
    submit,
  ]);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim() || !password.value) {
      error.textContent = '이메일과 비밀번호를 입력해 주세요.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    submit.textContent = '확인하는 중…';
    error.hidden = true;
    const res = await api('/api/admin/session', jsonInit('POST', { email: email.value, password: password.value }));
    if (res.ok) {
      password.value = '';
      showDashboard();
      return;
    }
    let message = '잠시 후 다시 시도해 주세요.';
    if (res.status === 401) message = '이메일이나 비밀번호를 다시 확인해 주세요. 관리자로 허용된 계정인지도 확인해 주세요.';
    else if (res.status === 429) {
      const minutes = Math.max(1, Math.ceil(((res.data && res.data.retryAfterSeconds) || 60) / 60));
      message = `시도가 너무 많았어요. 약 ${minutes}분 뒤에 다시 시도해 주세요.`;
    } else if (res.status === 503) message = '로그인 서버가 잠시 응답하지 않아요. 잠시 후 다시 시도해 주세요.';
    else if (res.status === 500) message = '서버 설정이 끝나지 않았어요. 운영 문서를 확인해 주세요.';
    else if (res.status === 0) message = '네트워크 연결을 확인해 주세요.';
    error.textContent = message;
    error.hidden = false;
    password.value = '';
    submit.disabled = false;
    submit.textContent = '로그인';
    password.focus();
  });

  root.replaceChildren(h('div', { class: 'lb-auth' }, [form]));
  email.focus();
}

function showMisconfigured() {
  root.replaceChildren(h('div', { class: 'lb-auth' }, [h('div', { class: 'lb-card lb-auth-card' }, [
    h('div', { class: 'lb-auth-icon', 'aria-hidden': 'true', text: '🛠️' }),
    h('h1', { text: '관리자 설정이 필요해요' }),
    h('p', { class: 'lb-muted', text: '서버에 허용된 관리자 UID(ARISA_ADMIN_UIDS)가 아직 설정되지 않았어요. docs/DEPLOYMENT.md 의 안내를 따라 주세요.' }),
  ])]));
}

/* ---------- 대시보드 ---------- */
function showDashboard() {
  state.status = 'all';
  state.q = '';
  state.page = 1;
  state.data = null;
  state.loadState = 'loading';

  els.stats = ['전체 편지', '대기중', '승인됨', '숨김', '아리사가 읽음'].map((label) => ({
    label,
    num: h('div', { class: 'ad-stat__num', text: '–' }),
  }));
  els.filters = h('div', { class: 'lb-filters', role: 'group', 'aria-label': '상태 필터' });
  els.search = h('input', {
    type: 'search', class: 'text-input', placeholder: '이름 또는 내용 검색', 'aria-label': '이름 또는 내용 검색', maxlength: 100, autocomplete: 'off',
  });
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = els.search.value.trim();
      state.page = 1;
      load();
    }, 300);
  });
  els.listArea = h('div');

  root.replaceChildren(h('main', { class: 'lb-main' }, [
    h('header', { class: 'lb-head' }, [
      h('div', {}, [
        h('p', { class: 'lb-eyebrow', text: 'ARISA · LAST LIVE' }),
        h('h1', { class: 'lb-title', text: '편지 관리' }),
        h('p', { class: 'lb-sub', text: '도착한 편지를 확인하고, 승인한 편지만 아리사에게 전해져요.' }),
      ]),
      h('div', { class: 'lb-actions' }, [
        h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '로그아웃', onclick: logout }),
      ]),
    ]),
    h('div', { class: 'ad-stats' }, els.stats.map((s) => h('div', { class: 'lb-card ad-stat' }, [h('div', { class: 'ad-stat__label', text: s.label }), s.num]))),
    h('div', { class: 'ad-tools' }, [els.filters, h('div', { class: 'ad-search' }, [els.search])]),
    els.listArea,
  ]));
  renderFilters();
  load();
}

function renderFilters() {
  els.filters.replaceChildren(...FILTERS.map(([key, label]) => h('button', {
    type: 'button',
    class: `btn btn--small ${state.status === key ? 'btn--primary' : 'btn--ghost'}`,
    text: label,
    'aria-pressed': String(state.status === key),
    onclick: () => {
      state.status = key;
      state.page = 1;
      renderFilters();
      load();
    },
  })));
}

async function load() {
  if (listAbort) listAbort.abort();
  const ac = new AbortController();
  listAbort = ac;
  if (!state.data) state.loadState = 'loading';
  renderList();
  const params = new URLSearchParams({ status: state.status, q: state.q, page: String(state.page) });
  const res = await api(`/api/admin/letters?${params}`, { signal: ac.signal });
  if (res.aborted) return;
  if (res.status === 401) return showLogin('로그인이 만료되었어요. 다시 로그인해 주세요.');
  if (!res.ok || !res.data) {
    state.loadState = 'error';
    renderList();
    return;
  }
  state.data = res.data;
  state.page = res.data.page;
  state.loadState = 'ready';
  renderStats();
  renderList();
}

function renderStats() {
  const c = state.data.counts;
  [c.total, c.pending, c.approved, c.hidden, c.read].forEach((n, i) => { els.stats[i].num.textContent = String(n); });
}

function renderList() {
  const d = state.data;
  const parts = [];
  if (state.loadState === 'error') {
    parts.push(h('div', { class: 'lb-card lb-message lb-message--error', role: 'alert' }, [
      '편지를 불러오지 못했어요. ', h('button', { type: 'button', text: '다시 시도', onclick: load }),
    ]));
  }
  if (state.loadState === 'loading' && !d) parts.push(h('p', { class: 'lb-muted', text: '불러오는 중…' }));
  if (d && d.items.length === 0) parts.push(h('p', { class: 'lb-card lb-message', text: '표시할 편지가 없어요.' }));
  if (d && d.items.length > 0) parts.push(h('ul', { class: 'ad-list' }, d.items.map(renderRow)));
  if (d && d.totalPages > 1) {
    parts.push(h('nav', { class: 'lb-pager', 'aria-label': '페이지' }, [
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '이전', disabled: state.page <= 1, onclick: () => { state.page -= 1; load(); } }),
      h('span', { 'aria-live': 'polite', text: `${d.page} / ${d.totalPages}` }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', text: '다음', disabled: state.page >= d.totalPages, onclick: () => { state.page += 1; load(); } }),
    ]));
  }
  els.listArea.replaceChildren(...parts);
}

function renderRow(item) {
  const busy = state.busyId === item.id;
  const action = (label, status, primary = false) => h('button', {
    type: 'button',
    class: `btn btn--small ${primary ? 'btn--primary' : 'btn--ghost'}`,
    text: label,
    disabled: busy,
    onclick: () => changeStatus(item, status),
  });
  const truncated = item.preview.length >= 200;
  return h('li', { class: 'lb-card ad-row' }, [
    h('div', { class: 'ad-row__top' }, [
      h('div', {}, [
        h('span', { class: 'ad-row__name', text: nameOf(item.sender_name) }),
        ' ',
        h('span', { class: `ad-status ad-status--${item.moderation_status}`, text: STATUS_LABEL[item.moderation_status] }),
        item.is_read ? h('span', { class: 'lb-badge lb-badge--read', text: '아리사 읽음' }) : null,
      ]),
      h('span', { class: 'ad-row__date', text: formatKst(item.created_at) }),
    ]),
    h('p', { class: 'ad-row__preview', text: truncated ? `${item.preview}…` : item.preview }),
    h('div', { class: 'ad-row__actions' }, [
      h('a', { class: 'btn btn--ghost btn--small', href: `/admin/preview?letter=${encodeURIComponent(item.id)}`, target: '_blank', rel: 'noopener', text: '아리사 화면으로 미리보기' }),
      item.moderation_status !== 'approved' ? action('승인하기', 'approved', true) : null,
      item.moderation_status === 'approved' ? action('승인 취소', 'pending') : null,
      item.moderation_status === 'hidden' ? action('대기로 되돌리기', 'pending') : null,
      item.moderation_status !== 'hidden' ? action('숨기기', 'hidden') : null,
    ]),
  ]);
}

async function changeStatus(item, status) {
  if (state.busyId) return;
  state.busyId = item.id;
  renderList();
  const res = await api(`/api/admin/letters/${encodeURIComponent(item.id)}`, jsonInit('PATCH', { status }));
  state.busyId = null;
  if (res.status === 401) return showLogin('로그인이 만료되었어요. 다시 로그인해 주세요.');
  if (res.ok) {
    toast(status === 'approved' ? '편지를 승인했어요.' : status === 'hidden' ? '편지를 숨겼어요.' : '편지를 대기 상태로 되돌렸어요.');
  } else {
    toast('상태를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.', true);
  }
  load();
}

async function logout() {
  await api('/api/admin/session', { method: 'DELETE' });
  showLogin('');
}

/* ---------- 시작 ---------- */
async function init() {
  const session = await api('/api/admin/session');
  if (session.status === 500) return showMisconfigured();
  if (session.ok && session.data && session.data.authenticated) return showDashboard();
  return showLogin('');
}

init();
