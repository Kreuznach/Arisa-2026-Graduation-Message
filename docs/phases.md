# 개발 단계 기록 (Phase 0 ~ 10)

기준일: 2026-10-09

| 표시 | 뜻 |
|---|---|
| ✅ | 끝났고 확인함 |
| 🟡 | 코드는 끝났지만 **사람이 직접 해야 하는 일**이 남음 |

| Phase | 할 일 | 상태 | 결과 · 메모 |
|---|---|---|---|
| 0 | 기존 모카의 CSS · 컴포넌트 · 서버 구조 분석 | ✅ | 아래 "분석 결과" 참고 |
| 1 | 독립 아리사 프로젝트 만들기 | ✅ | `arisa-letters`(이 저장소). 모카 폴더 2곳은 읽기만 했고 `git status` 가 깨끗해요 |
| 2 | 아리사 전용 CSS 토큰 · 배경 | ✅ | `arisa-theme.css` — 기획서의 색과 165도 그라데이션, 4겹 조명 |
| 3 | Enchanted Pink / Disenchanted 이모지 | ✅ | `emoji-layer.js` + `arisa-theme.css` — 5단계, 네 겹 구조 |
| 4 | 기존 편지 작성 화면 이식 | ✅ | `index.html`, `letters.css`, `letters.js` (문구만 아리사로 변경) |
| 5 | Supabase 독립 테이블과 API | 🟡 | SQL · API 완성, 가짜 DB(PGlite)로 전부 검증. **진짜 Supabase 에 SQL 을 실행하는 일은 사람이 해야 해요** ([배포 가이드](DEPLOYMENT.md) 2번) |
| 6 | 관리자 검수 · 인증 | 🟡 | 완성. 허용할 관리자 **UID 를 `ARISA_ADMIN_UIDS` 에 넣는 일**이 남았어요 (3-3) |
| 7 | 아리사 전용 봉투 열람 | ✅ | `arisa.html`, `letterbox.js` — 접근 코드, 목록, 봉투 열기, 읽음 기록 |
| 8 | 태블릿 QR 안내 화면 | ✅ | `display.html`, `display.js` — QR, 전체화면 버튼 |
| 9 | 반응형 · 접근성 · 보안 · 기능 테스트 | ✅ | 자동 테스트 85개 통과 + 브라우저 확인. 자세한 내용은 [TEST_RESULTS.md](TEST_RESULTS.md) |
| 10 | 배포 준비와 운영 문서 | 🟡 | 문서 완성. Cloudflare 에 올리는 일은 사람이 해야 해요 |

## 사람이 해야 하는 남은 일

1. Supabase SQL Editor 에서 `supabase/migrations/20261009000000_create_arisa_last_live_letters.sql` 실행
2. Supabase 에서 관리자 계정의 UID 를 찾아 `.dev.vars` 의 `ARISA_ADMIN_UIDS` 에 넣기 (운영은 Cloudflare 에도)
3. `npm run check:config` 로 `✓ Supabase 연결 성공` 확인
4. Cloudflare Pages 에 올리고 비밀값 5개 입력 → [배포 가이드](DEPLOYMENT.md) 6번 확인 순서 따라 하기
5. 현장 태블릿에서 `/display` 의 QR 을 스마트폰으로 직접 찍어 보기

## Phase 0 분석 결과 (기존 모카 프로젝트)

- **`Mokano-2026-Graduation-Message`** — 팬 편지 작성 페이지.
  순수 HTML/JS + Cloudflare Pages Functions + Supabase. 48시간 제한, 중복 방지, 쿠키 서명, 입력 규칙(`letter-rules.js`)이 여기에 있어요.
  → 그대로 가져온 것: 편지지 CSS, 입력 규칙, 제출 흐름(재시도 · 멱등 키), 쿠키 서명 방식, 서버 구조
- **`Pink-Queen-Reigns`** (mokano.live) — Next.js. 편지함(`LetterboxApp`, `letterbox.css`), 접근 코드 세션, 관리자 편지 관리.
  → 가져온 것: 봉투 열기 연출(키프레임 값 · 길이), 목록/열람 UX(2열, 필터, 정렬, 이전/다음, 건너뛰기), 읽음 기록 원칙, 로그인 실패 제한, 관리자 검수 흐름
- 기존 모카의 실제 CSS 색은 기획서의 값(`#EEF1F8`, `#DDD9ED`, `#F3E3EB`, `#34354A`, `#77649C`, `#C58EA5`, `#FFFDF8`)과 같았어요.
  (아리사 코드에는 이 값들이 하나도 남아 있지 않아요.)

### 기술 선택 이유

기획서는 "React · Vite · TypeScript · Tailwind 를 기본으로 하되, 기존 모카 구현을 먼저 확인하라"고 했어요.
편지 작성 페이지(가장 중요한 부분)가 이미 **빌드 없는 정적 페이지 + Pages Functions** 로 검증되어 있었고,
편지함은 Next.js(React) 구조에 Tailwind 클래스가 섞여 있었어요. 아리사는 독립 서비스이고 Cloudflare Pages 로 배포하므로,
- 검증된 작성 화면과 서버를 **리팩터링 없이** 그대로 쓰고,
- 편지함 · 관리자는 같은 화면 규칙을 순수 JavaScript 로 다시 만들었어요. (연출 값은 동일)

그래서 React/Vite 는 쓰지 않았어요. 필요하면 나중에 화면 부분만 옮길 수 있게 서버와 화면이 완전히 분리되어 있어요.
