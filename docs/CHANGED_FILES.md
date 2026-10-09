# 변경 파일 목록

기준일: 2026-10-09

## 새로 만든 파일

### 화면 (`public/`)

| 파일 | 하는 일 |
|---|---|
| `public/index.html` | 팬 편지 쓰기 (`/`) |
| `public/arisa.html` | 아리사 편지함 (`/arisa`) |
| `public/admin.html` | 관리자 (`/admin`) |
| `public/admin/preview.html` | 관리자 미리보기 (`/admin/preview`) |
| `public/display.html` | 현장 QR 안내 (`/display`) |
| `public/_headers` | 보안 헤더(CSP 등), 검색 제외, 캐시 |
| `public/assets/arisa-theme.css` | 핑크 색 토큰, 배경, **배경 이모지**, 공통 부품, 움직임 줄이기 |
| `public/assets/letters.css` | 편지 쓰기 화면 스타일 |
| `public/assets/letterbox.css` | 아리사 편지함 · 관리자 · QR 화면 스타일, 봉투 열기 연출 |
| `public/assets/emoji-layer.js` | 배경 이모지 배치와 다시 나타나기 |
| `public/assets/ui-common.js` | 저장소(`arisa:`), 움직임 설정, 이모지 시작 |
| `public/assets/dom-utils.js` | DOM 만들기, 서버 호출, 날짜 형식 |
| `public/assets/letter-rules.js` | 편지 입력 규칙 (브라우저와 서버가 같이 씀) |
| `public/assets/letters-i18n.js` | 한국어/일본어 문구 |
| `public/assets/letters.js` | 편지 쓰기 동작 |
| `public/assets/letterbox.js` | 아리사 편지함 + 관리자 미리보기 동작 |
| `public/assets/admin.js` | 관리자 동작 |
| `public/assets/display.js` | QR 그리기, 전체화면 |
| `public/assets/favicon.svg` | 아이콘 |
| `public/assets/vendor/qrcode.mjs` | QR 라이브러리(`qrcode-generator` 2.0.4, MIT, 파일 맨 위에 라이선스 있음) |

### 서버 (`server/`, `functions/`)

| 파일 | 하는 일 |
|---|---|
| `server/config.js` | 설정 읽기와 검사 (비밀값은 출력 안 함) |
| `server/crypto.js` | 서명, 해시, 세션 토큰 |
| `server/http.js` | 응답, 쿠키, 같은 사이트 확인, 본문 크기 제한 |
| `server/supabase.js` | Supabase 호출(RPC), 관리자 비밀번호 확인 |
| `server/auth-limit.js` | 로그인 실패 제한 |
| `server/letters-api.js` | 팬 API (상태, 저장) |
| `server/reader-api.js` | 아리사 API (코드 입장, 목록, 상세, 읽음) |
| `server/admin-api.js` | 관리자 API (로그인, 목록, 미리보기, 상태 변경) |
| `functions/api/**` (9개) | Cloudflare 가 주소마다 실행하는 연결 파일 |

### 데이터 · 스크립트 · 설정

| 파일 | 하는 일 |
|---|---|
| `supabase/migrations/20261009000000_create_arisa_last_live_letters.sql` | 새 테이블 3개, 함수 11개, 권한 |
| `scripts/check-config.mjs` | 설정 점검 |
| `scripts/mock-supabase.mjs` | 가짜 Supabase (로컬 연습용) |
| `scripts/dev-mock.mjs` | 가짜 DB + 로컬 서버 한 번에 |
| `package.json`, `package-lock.json`, `wrangler.toml` | 프로젝트 설정 (이름 `arisa-letters`) |
| `.gitignore` | `.dev.vars`, `.env*`, `node_modules` 등을 깃에서 제외 |
| `.dev.vars.example` | 환경변수 이름 예시 (값은 비어 있음) |
| `.dev.vars` | **내 컴퓨터에만 있는 진짜 값** (깃에 올라가지 않음, 이 목록의 다른 파일과 달리 공유 금지) |

### 테스트 (`tests/`)

`db.test.mjs`, `api.test.mjs`, `reader.test.mjs`, `admin.test.mjs`, `config.test.mjs`, `letter-rules.test.mjs`, `design.test.mjs`, `helpers/db.mjs`, `helpers/env.mjs`

### 문서

`README.md`(다시 씀), `docs/DEPLOYMENT.md`, `docs/HOW_IT_WORKS.md`, `docs/DESIGN.md`, `docs/phases.md`, `docs/TEST_RESULTS.md`, `docs/CHANGED_FILES.md`

## 고친 파일

| 파일 | 바뀐 점 |
|---|---|
| `README.md` | 제목 한 줄뿐이던 것을 프로젝트 소개 · 실행 방법 · 문서 안내로 |
| `docs/BUILD.md` | 지시서에 적혀 있던 **실제 비밀키 · 쿠키 비밀값을 지움**, 구현 상태 안내 추가 |

## 건드리지 않은 것

- `D:\Projects\CodingLan\Mokano-2026-Graduation-Message` (모카 편지 작성) — 읽기만 함, `git status` 깨끗
- `D:\Projects\CodingLan\Pink-Queen-Reigns` (mokano.live) — 읽기만 함, `git status` 깨끗
- 진짜 Supabase 의 모카 테이블 · 정책 · 사용자 · 데이터 — 읽거나 바꾸지 않음
