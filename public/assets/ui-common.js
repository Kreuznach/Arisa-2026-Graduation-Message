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
 * '움직임 끄기' 버튼과 기기의 '동작 줄이기' 설정을 하나로 묶습니다.
 * 우선순위: 사용자가 고른 값(켜기/끄기) → 기기 설정
 * @param {{ key: string, button?: HTMLElement | null, labels?: () => { on: string, off: string } }} options
 */
export function createMotionControl({ key, button = null, labels = null }) {
  const root = document.documentElement;
  const query = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const readPref = () => {
    const saved = storage.get(key);
    return saved === 'on' || saved === 'off' ? saved : null;
  };
  let pref = readPref();
  let current = { button: null, labels: null };

  const isReduced = () => (pref === 'on' ? false : pref === 'off' ? true : Boolean(query && query.matches));

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

  if (query) {
    if (query.addEventListener) query.addEventListener('change', apply);
    else if (query.addListener) query.addListener(apply);
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
