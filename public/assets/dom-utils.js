// 아리사 편지함·관리자 화면이 함께 쓰는 DOM·통신 도구
// 편지 내용과 이름은 항상 textContent 로만 넣습니다. (HTML 로 해석하지 않음)

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** h('button', { class: 'btn', text: '확인', onclick: fn, 'aria-label': '...' }, [자식...]) */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) el.append(child);
  return el;
}

/** 서버 호출. 취소되면 { aborted: true }, 네트워크 오류면 status 0 */
export async function api(url, init) {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...init, cache: 'no-store' });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e && e.name === 'AbortError') return { aborted: true };
    return { ok: false, status: 0, data: null };
  }
}

export const jsonInit = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body),
});

const kst = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export const formatKst = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : kst.format(d);
};

export const nameOf = (name) => (name && name.trim() ? name : '익명');

/** 비밀번호 칸과 '보기' 버튼 */
export function passwordField({ id, label, autocomplete = 'off', describedBy = '' }) {
  const input = h('input', {
    id, type: 'password', class: 'text-input', autocomplete, autocapitalize: 'none', spellcheck: 'false', maxlength: 200,
    'aria-describedby': describedBy || null,
  });
  const toggle = h('button', {
    type: 'button', class: 'lb-pw-toggle', text: '보기', 'aria-label': `${label} 보기`,
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.textContent = show ? '숨기기' : '보기';
      toggle.setAttribute('aria-label', `${label} ${show ? '숨기기' : '보기'}`);
    },
  });
  return { input, wrap: h('div', { class: 'lb-pw' }, [input, toggle]) };
}
