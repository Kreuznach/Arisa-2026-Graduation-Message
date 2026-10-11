// 모든 아리사 페이지가 함께 쓰는 작은 도구: 저장소, 움직임 설정, 배경 이모지 시작
import { createEmojiLayer } from './emoji-layer.js';

// 아리사 전용 이름표(arisa:) 로만 저장해서 다른 서비스와 섞이지 않습니다.
export const NS = 'arisa:';

/* 저장소가 막혀 있어도 페이지는 동작 */
export const storage = {
  get(key) {
    try { return window.localStorage.getItem(NS + key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(NS + key, value); } catch { /* 무시 */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(NS + key); } catch { /* 무시 */ }
  },
};

/**
 * '움직임 켜기/끄기' 버튼의 선택을 관리합니다.
 * 기본값은 '움직임 켜기'이며, 사용자가 '끄기'를 고른 경우에만 움직임을 멈춥니다. (기기 설정과 무관)
 * @param {{ key: string, button?: HTMLElement | null, labels?: () => { on: string, off: string } }} options
 */
export function createMotionControl({ key, button = null, labels = null }) {
  const root = document.documentElement;
  const readPref = () => {
    const saved = storage.get(key);
    return saved === 'on' || saved === 'off' ? saved : null;
  };
  let pref = readPref();
  let current = { button: null, labels: null };

  const isReduced = () => pref === 'off';

  function apply() {
    const reduced = isReduced();
    root.classList.toggle('motion-off', reduced);
    root.classList.toggle('motion-on', !reduced);
    if (current.button && current.labels) {
      current.button.textContent = reduced ? current.labels().on : current.labels().off;
      current.button.setAttribute('aria-pressed', String(reduced));
    }
  }

  /** 화면을 다시 그려서 버튼이 새로 만들어졌을 때 연결 */
  function bindButton(nextButton, nextLabels) {
    current = { button: nextButton, labels: nextLabels };
    nextButton.addEventListener('click', () => {
      pref = isReduced() ? 'on' : 'off';
      storage.set(key, pref);
      apply();
    });
    apply();
  }

  window.addEventListener('storage', (e) => {
    if (e.key === NS + key) {
      pref = readPref();
      apply();
    }
  });
  if (button && labels) bindButton(button, labels);
  else apply();
  return { apply, isReduced, bindButton };
}

/** 배경 이모지를 시작하고, 페이지를 떠날 때 정리합니다. */
export function startEmojiLayer(layerEl, { columnWidth = 600 } = {}) {
  const layer = createEmojiLayer(layerEl, { columnWidth });
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) layer.destroy();
  });
  return layer;
}
