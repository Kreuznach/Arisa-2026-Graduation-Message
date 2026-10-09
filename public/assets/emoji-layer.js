// 배경 이모지 "Enchanted Pink → Disenchanted"
// 각 이모지가 나타남 → 반짝임 → 마법이 풀림 → 흩어짐 → (다른 자리에서) 다시 나타남 을 반복합니다.
// 움직임은 모두 CSS 애니메이션이 담당하고, 이 파일은 배치만 정합니다. (프레임마다 상태를 바꾸지 않음)
export const EMOJI_CONFIG = Object.freeze({
  desktopMinWidth: 768,
  counts: Object.freeze({ mobile: 12, desktop: 22 }),
  // 눈물·이별 계열(2차 그룹)은 전체의 약 4분의 1 이하
  disenchantRatio: 0.25,
  enchant: Object.freeze(['💖', '💗', '💞', '🩷', '💕', '🎀', '🌸', '✨']),
  disenchant: Object.freeze(['🫧', '🥀', '🥹', '💔']),
  durationSec: Object.freeze([12, 22]),
  seed: 20261009,
});

const VARIANTS = ['fall', 'sway', 'rise', 'glow'];

/** 같은 seed 면 항상 같은 수열을 만드는 작은 난수기 (렌더링이 바뀌어도 배치가 안정적) */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, min, max) => min + rng() * (max - min);

/**
 * 화면 양쪽 가장자리에 놓을 자리를 만듭니다. 가운데 기둥(columnWidth) 쪽으로는 들어오지 않습니다.
 * @returns {{ side: 0 | 1, inner: number, band: number, bandStart: number }[]}
 */
export function makeSlots(count, width, columnWidth) {
  const freeSide = ((width - columnWidth) / 2 / width) * 100;
  const inner = Math.max(12, Math.min(30, freeSide - 2));
  const perSide = [Math.ceil(count / 2), Math.floor(count / 2)];
  const slots = [];
  perSide.forEach((m, side) => {
    const band = 86 / m;
    for (let j = 0; j < m; j++) slots.push({ side, inner, band, bandStart: 2 + band * j });
  });
  return slots;
}

function placeInSlot(slot, rng) {
  const offset = between(rng, 2, slot.inner);
  return {
    x: slot.side === 0 ? offset : 100 - offset,
    y: slot.bandStart + between(rng, 0.15, 0.85) * slot.band,
  };
}

/** 한 화면에 쓸 이모지 목록을 정합니다. 같은 입력이면 같은 결과가 나옵니다. */
export function planEmojis({ width, columnWidth, seed = EMOJI_CONFIG.seed }) {
  const isDesktop = width >= EMOJI_CONFIG.desktopMinWidth;
  const total = isDesktop ? EMOJI_CONFIG.counts.desktop : EMOJI_CONFIG.counts.mobile;
  const disenchantCount = Math.round(total * EMOJI_CONFIG.disenchantRatio);
  const rng = mulberry32(seed + (isDesktop ? 1 : 2));
  const slots = makeSlots(total, width, columnWidth);
  const [minDur, maxDur] = EMOJI_CONFIG.durationSec;

  // 두 그룹이 섞여 보이도록 자리 번호를 섞어서 나눠 줌
  const order = slots.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const items = order.map((slotIndex, n) => {
    const group = n < disenchantCount ? 'disenchant' : 'enchant';
    const pool = EMOJI_CONFIG[group];
    const dur = between(rng, minDur, maxDur);
    return {
      slot: slots[slotIndex],
      group,
      glyph: pool[n % pool.length],
      variant: VARIANTS[n % VARIANTS.length],
      size: isDesktop ? between(rng, 24, 38) : between(rng, 20, 30),
      dur,
      delay: -between(rng, 0, dur), // 서로 다른 시점에서 시작해 한꺼번에 나타나거나 사라지지 않음
      ...placeInSlot(slots[slotIndex], rng),
    };
  });
  return { items, rng };
}

function buildEmoji(item) {
  const el = document.createElement('span');
  el.className = `ae is-${item.variant}`;
  el.dataset.group = item.group;
  el.style.setProperty('--x', item.x.toFixed(1));
  el.style.setProperty('--y', item.y.toFixed(1));
  el.style.setProperty('--size', `${item.size.toFixed(0)}px`);
  el.style.setProperty('--dur', `${item.dur.toFixed(1)}s`);
  el.style.setProperty('--delay', `${item.delay.toFixed(1)}s`);

  const life = document.createElement('span');
  life.className = 'ae__life';
  const halo = document.createElement('span');
  halo.className = 'ae__halo';
  const glyph = document.createElement('span');
  glyph.className = 'ae__glyph';
  glyph.textContent = item.glyph;
  life.append(halo, glyph);

  const particles = ['star ae__p--a', 'star ae__p--b', 'dust ae__p--up', 'dust ae__p--down'].map((kind) => {
    const p = document.createElement('i');
    p.className = `ae__p ae__p--${kind}`;
    return p;
  });
  el.append(life, ...particles);
  return { el, life, glyph };
}

/**
 * 페이지가 열린 뒤 한 번 만들고, 화면 너비의 구간이 바뀔 때만 다시 배치합니다. 입력으로는 다시 만들지 않습니다.
 * @param {HTMLElement} layer
 * @param {{ columnWidth?: number }} options  가운데 콘텐츠 기둥의 너비(px)
 */
export function createEmojiLayer(layer, { columnWidth = 600 } = {}) {
  let layoutKey = '';
  let layoutWidth = 0;
  let resizeId = 0;
  let stopRespawn = () => {};
  const root = document.documentElement;

  function build() {
    const width = window.innerWidth;
    const key = width >= EMOJI_CONFIG.desktopMinWidth ? 'desktop' : 'mobile';
    if (key === layoutKey && width === layoutWidth) return;
    layoutKey = key;
    layoutWidth = width;
    stopRespawn();

    const { items, rng } = planEmojis({ width, columnWidth });
    const frag = document.createDocumentFragment();
    const bySlot = new Map();
    for (const item of items) {
      const built = buildEmoji(item);
      bySlot.set(built.life, { item, el: built.el, glyph: built.glyph });
      frag.appendChild(built.el);
    }
    layer.replaceChildren(frag);
    layer.dataset.layout = key;

    // 한 바퀴가 끝나 완전히 사라진 순간에, 같은 그룹의 이모지로 바꾸고 자리를 옮겨 다시 나타나게 함
    const onIteration = (event) => {
      if (event.animationName !== 'arisaDisenchant') return;
      const entry = bySlot.get(event.target);
      if (!entry) return;
      const pool = EMOJI_CONFIG[entry.item.group];
      const others = pool.filter((g) => g !== entry.glyph.textContent);
      entry.glyph.textContent = others[Math.floor(rng() * others.length)];
      const spot = placeInSlot(entry.item.slot, rng);
      entry.el.style.setProperty('--x', spot.x.toFixed(1));
      entry.el.style.setProperty('--y', spot.y.toFixed(1));
    };
    layer.addEventListener('animationiteration', onIteration);
    stopRespawn = () => layer.removeEventListener('animationiteration', onIteration);
  }

  function onResize() {
    clearTimeout(resizeId);
    resizeId = setTimeout(build, 150);
  }

  function onVisibility() {
    root.classList.toggle('is-page-hidden', document.hidden);
  }

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  build();
  onVisibility();

  return {
    /** 긴 편지를 읽는 동안에는 본문이 잘 보이도록 흐리게 */
    setDim(on) {
      layer.classList.toggle('is-dim', Boolean(on));
    },
    destroy() {
      clearTimeout(resizeId);
      stopRespawn();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      root.classList.remove('is-page-hidden');
      layer.replaceChildren();
    },
  };
}
