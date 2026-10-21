# 모아 · 개인 가계부

프론트엔드와 백엔드를 독립 배포하는 개인용 지출 기록·분석 웹앱입니다.

| 구성 | 구현 | 배포 대상 |
| --- | --- | --- |
| `frontend/` | React · TypeScript · Vite, 반응형 PWA | Vercel |
| `backend/` | Node.js 24 · Fastify · SQLite, JSON API | 별도 Linux 서버 / Docker |

## 실행

Node.js 24를 사용합니다. 백엔드 실행에 Python은 필요하지 않습니다. 최초 한 번 설치합니다.

```powershell
# 프로젝트 폴더에서
npm --prefix backend ci
npm --prefix frontend ci
```

터미널 두 개에서 실행합니다.

```powershell
# 터미널 1
npm run dev:backend
```

```powershell
# 터미널 2: 프로젝트 폴더에서
npm --prefix frontend run dev
```

브라우저: `http://127.0.0.1:5173` · API 확인: `http://127.0.0.1:8000/api/health`

환경을 바꾸려면 `backend/.env.example`을 `backend/.env`로 복사하고 값을 설정합니다. 기본 API 포트는 8000입니다. 개발 서버의 실제 거래 데이터는 처음에는 비어 있습니다. 화면의 둘러보기는 예시임을 표시하며 서버 데이터와 구분합니다.

## 사용 흐름

- PC에서는 거래를 표에 이어 입력합니다. Tab·Shift+Tab으로 셀을, Enter·Shift+Enter로 행을 이동하고 Ctrl/Cmd+Enter로 저장합니다. 엑셀에서 복사한 여러 행은 날짜·유형·금융수단·종목·메모·태그·금액 순서로 붙여넣을 수 있습니다. 빈 행은 저장에서 제외하며 잘못된 값은 셀에 표시합니다. 모바일은 날짜 중심의 거래 입력 폼을 사용합니다.
- 달력에서 날짜를 선택한 뒤 같은 날짜의 여러 거래를 이어 입력합니다. 입력 주기는 고정하지 않습니다.
- 거래당 종목 하나와 복수 태그를 사용합니다. 금융수단은 설정에서 직접 추가하고 이름·설명·색상을 수정할 수 있습니다. 초기 네 항목도 수정·보관할 수 있으며, 거래에 사용하지 않은 항목은 삭제할 수 있습니다. 보관한 항목의 과거 거래와 지출 집계는 유지됩니다.
- 예산 하나에 태그 하나를 연결합니다. 다음 달 예산을 따로 정하지 않았다면 당월 설정 금액을 이어받습니다. 남은 금액·초과액은 이월하지 않고 과거 월을 소급 수정하지 않습니다.
- 조회 조건과 그래프에서 원거래를 확인합니다. 태그별 합계를 더해 총지출로 취급하지 않습니다.
- 분석 작업 공간에는 여러 창과 카드를 둘 수 있습니다. 저장본은 당시 결과를 복사해 열고, 요청 시 재계산하여 새 카드를 만듭니다.
- 설정에서 백업을 내려받고 업로드하여 복구할 수 있습니다. 접속키와 AI 키는 백업 데이터에 포함되지 않습니다.

## AI 분석 연결

외부 AI가 설정되지 않은 기본 상태에서는 실제 거래를 조회·계산하는 **규칙 기반 분석**이 작동합니다. 모델이 연결된 것처럼 표시하지 않습니다. 기간·태그·계좌별 집계와 합계를 요청할 수 있고, 모호한 기간은 확인합니다.

로컬 모델 서버 또는 호환 API를 쓰려면 백엔드 환경에 다음 값을 설정합니다.

```dotenv
LLM_BASE_URL=https://your-compatible-endpoint.example/v1
LLM_MODEL=your-model
LLM_API_KEY=your-server-side-key
```

AI는 분석 계획과 표현을 돕고, 수치는 코드로 조회한 실제 거래에서 계산합니다. 임의 SQL 실행과 AI의 거래 수정 기능은 없습니다. 모델·실행 환경은 아직 사용자가 선택하지 않았으므로 API 키 없이 유료 호출을 시작하지 않습니다.

## 배포

도메인 없이 Vercel 프록시를 통해 기존 공인 서버의 백엔드에 연결합니다.

```text
브라우저 → HTTPS Vercel /api → HTTP 115.68.223.74:8000/api
```

Vercel은 Root Directory `frontend`, Framework `Vite`, Build Command `npm run build`, Output Directory `dist`로 설정합니다. `VITE_API_URL`은 `/api`로 설정하거나 생략합니다. 이미 절대 주소를 설정했다면 `/api`로 바꾼 뒤 다시 배포하고, 앱의 저장된 서버 API 주소도 `/api`로 변경합니다.

서버에서는 프로젝트 최상위 `.env.example`을 `.env`로 복사해 `FRONTEND_ORIGIN`에 실제 Vercel 주소, `APP_ACCESS_TOKEN`에 긴 랜덤 접속키를 넣고 `docker compose up -d --build backend`를 실행합니다. 기본 공개 포트는 `8000`이며 Vercel에서 접근할 수 있어야 합니다. 기본 구성은 백엔드만 실행하므로 기존 서비스의 80·443·3000 포트를 사용하지 않습니다. Vercel과 백엔드 사이의 HTTP 통신은 암호화되지 않습니다.

정확한 환경변수, 연결 확인, 선택적인 HTTPS 구성은 [배포 안내](docs/deployment.md)에 있습니다. 백엔드 데이터는 서버의 영속 볼륨에 보관합니다.

## 검증

```powershell
npm --prefix frontend run build
npm --prefix frontend test
npm run check:backend
npm run test:backend
```

API 계약: [docs/api-contract.md](docs/api-contract.md). 초기 구현의 변경 가능한 선택은 [docs/implementation-decisions.md](docs/implementation-decisions.md)에 정리했습니다.
