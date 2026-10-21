# Vercel 프록시 + 공인 IP 백엔드 배포

현재 구성은 기존 서버 `115.68.223.74`의 `8000` 포트에 가계부 백엔드를 실행하고, Vercel이 API 요청을 전달합니다. API 도메인은 필요하지 않습니다.

```text
브라우저 → https://your-frontend.vercel.app/api/…
         → Vercel 프록시 → http://115.68.223.74:8000/api/…
```

브라우저는 같은 Vercel 주소로 HTTPS 요청을 보냅니다. Vercel과 백엔드 사이의 HTTP 구간에는 접속키와 거래 데이터가 암호화되지 않은 채 전송됩니다. 이 구간까지 암호화하려면 아래의 선택적인 HTTPS 구성을 사용합니다.

## 1. 프론트엔드: Vercel

Vercel에서 이 저장소를 가져온 뒤 다음과 같이 설정합니다.

| 항목 | 값 |
| --- | --- |
| Root Directory | `frontend` |
| Framework / Application Preset | `Vite` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | 기본값 |
| 환경변수 `VITE_API_URL` | `/api` 또는 생략 |

`frontend/vercel.json`은 `/api/:path*`를 `http://115.68.223.74:8000/api/:path*`로 전달합니다. API 외의 페이지 요청은 SPA 화면으로 연결합니다. 백엔드 IP나 공개 포트를 바꿀 때는 이 파일의 `destination`도 바꾸고 다시 배포합니다.

기존 Vercel 환경변수 `VITE_API_URL`에 `http://서버IP:8000/api` 또는 이전 HTTPS 주소가 있으면 `/api`로 변경하고 **재배포**합니다. Vite 환경변수는 빌드할 때 반영됩니다. 앱의 설정에 저장해 둔 서버 주소는 환경변수보다 우선하므로, 앱에서도 `서버 API 주소`를 `/api`로 바꾸고 `저장하고 연결`을 누릅니다.

`VITE_` 변수는 공개되는 프론트 코드에 들어갑니다. `APP_ACCESS_TOKEN`과 `LLM_API_KEY`는 Vercel에 넣지 않습니다. 접속키는 실행된 앱의 서버 연결 설정에 본인 기기별로 입력합니다.

## 2. 백엔드: 기존 서버의 Docker

Docker와 Compose를 사용할 수 있는 서버에 프로젝트를 복사합니다. **프로젝트 최상위** `.env.example`을 `.env`로 복사하고 값을 채웁니다. Docker Compose는 `backend/.env`를 읽지 않습니다.

```sh
cp .env.example .env
openssl rand -hex 32
```

생성한 랜덤 문자열을 아래의 `APP_ACCESS_TOKEN`에 넣고, `FRONTEND_ORIGIN`은 실제 Vercel 배포 주소로 바꿉니다.

```dotenv
BACKEND_BIND_ADDRESS=0.0.0.0
BACKEND_PORT=8000
FRONTEND_ORIGIN=https://your-frontend.vercel.app
APP_ACCESS_TOKEN=replace-with-the-generated-random-key
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
```

| 변수 | 의미 |
| --- | --- |
| `BACKEND_BIND_ADDRESS` | `0.0.0.0`으로 서버 외부에서 접근하도록 공개 |
| `BACKEND_PORT` | 호스트에 공개할 포트. 현재 Vercel 대상과 같은 `8000` 사용 |
| `FRONTEND_ORIGIN` | `https://`를 포함한 실제 Vercel 주소. 경로나 끝의 `/` 없이 입력 |
| `APP_ACCESS_TOKEN` | 앱에 입력할 것과 동일한 긴 랜덤 접속키. 운영 환경에서 필수 |
| `LLM_*` | 외부 AI 연결 전에는 모두 비워 두기 |

`API_HOST`는 기본 Vercel 프록시 배포에서 사용하지 않습니다. `.env.example`의 해당 예시는 선택적인 Caddy HTTPS 구성에만 적용됩니다. Compose가 백엔드에 `APP_ENV=production`, `DB_PATH=/app/data/moa.db`, `CORS_ORIGINS=FRONTEND_ORIGIN`을 전달합니다.

서버에서 `8000` 포트가 다른 서비스에 사용되지 않는지 확인하고 백엔드를 실행합니다.

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker compose up -d --build backend
docker compose logs --tail=50 backend
docker compose ps
curl http://127.0.0.1:8000/api/health
```

서버 방화벽이나 호스팅 방화벽에서도 TCP `8000`에 대한 외부 접근을 허용해야 Vercel이 연결할 수 있습니다. `127.0.0.1`에만 바인딩하면 Vercel에서 접근할 수 없습니다. 다른 네트워크에서 `http://115.68.223.74:8000/api/health`가 응답하는지 확인합니다. 로컬 서버에서 성공하는 것만으로 외부 연결까지 확인된 것은 아닙니다.

기본 Compose 실행은 백엔드만 시작합니다. Caddy는 선택적인 `https` 프로필에 있으며, 위 명령은 기존 서비스가 쓰는 80·443 포트나 Poopoint의 3000 포트를 사용하지 않습니다. 기존 컨테이너가 8000을 사용 중이면 빈 포트로 `BACKEND_PORT`와 Vercel의 `destination`을 함께 바꿉니다.

백엔드 이미지는 Node.js 24와 Fastify로 실행됩니다. 서버에 Node.js나 Python을 직접 설치할 필요는 없습니다. 컨테이너는 일반 사용자(UID 10001)로 실행되며 종료 신호를 받아 요청과 DB 연결을 정리합니다. `/api/health`는 접속키 없이 확인할 수 있고, 나머지 API는 운영 접속키로 보호됩니다.

## 3. 연결 확인

1. 다른 네트워크에서 `http://115.68.223.74:8000/api/health`가 JSON을 반환하는지 확인합니다.
2. `https://your-frontend.vercel.app/api/health`도 같은 JSON을 반환하는지 확인합니다. HTML 화면이 나오면 API rewrite와 재배포 여부를 확인합니다.
3. Vercel 앱의 설정에서 `서버 API 주소`를 `/api`, `개인 접속키`를 서버의 `APP_ACCESS_TOKEN` 값으로 저장합니다.
4. 브라우저 개발자 도구의 Network에서 API 요청 주소가 `https://your-frontend.vercel.app/api/…`인지 확인합니다. HTTP 공인 IP를 브라우저가 직접 호출한다면 Vercel 환경변수와 앱에 저장된 주소를 다시 확인합니다.
5. 거래를 하나 입력하고 새로고침 후에도 남아 있는지 확인합니다. 다른 기기에서도 `/api`와 같은 접속키로 접속할 수 있습니다.
6. 백업을 내려받아 파일이 생성되는지 확인합니다. 복원은 현재 데이터를 백업 내용으로 바꾸는 동작입니다.

이 저장소의 설정만으로 서버 방화벽, 기존 컨테이너 상태, Vercel 배포 완료 여부를 확인할 수는 없습니다. 위 검증은 실제 서버와 Vercel 배포 후에 수행합니다.

## 4. 데이터 보존과 업데이트

SQLite 파일은 `ledger_data` 볼륨에 남습니다. 컨테이너를 새로 만들어도 같은 볼륨을 쓰면 거래가 유지됩니다. 앱에서 받는 JSON 백업으로 거래·태그·예산·저장된 분석 작업 공간을 복원할 수 있습니다. 접속키와 AI 키는 백업에 포함되지 않으므로 서버 환경에서 별도로 유지합니다.

배포를 업데이트할 때는 먼저 앱에서 JSON 백업을 받고 같은 프로젝트 이름·같은 볼륨으로 다음 명령을 실행합니다.

```sh
docker compose up -d --build backend
```

`docker compose down -v`는 데이터 볼륨을 지우므로 업데이트에 사용하지 않습니다. 기존 Python 백엔드와 같은 SQLite 스키마와 `/app/data/moa.db` 경로, UID를 사용합니다. 로컬 SQLite 파일을 옮길 때는 기존 서버를 먼저 종료하고 DB 파일과 남아 있는 `-wal`·`-shm` 파일을 함께 보존하거나 JSON 백업으로 복원합니다.

## 5. 로컬 개발과 직접 실행

로컬 개발에서는 기본 API 주소 `/api`를 유지합니다. Vite 개발·미리보기 서버가 `/api` 요청을 기본 `http://127.0.0.1:8000`으로 전달합니다. 개발용 백엔드가 다른 주소에 있으면 `frontend/.env`의 `API_PROXY_TARGET`을 그 주소로 바꿉니다. 이 값은 Vercel의 rewrite 목적지를 바꾸지 않습니다.

```dotenv
VITE_API_URL=/api
API_PROXY_TARGET=http://127.0.0.1:8000
```

`npm --prefix backend start`처럼 Docker 없이 백엔드를 실행할 때는 **`backend/.env`**를 사용합니다. `backend/.env.example`을 복사해 `APP_ENV`, `HOST`, `PORT`, `DB_PATH`, `CORS_ORIGINS`, `APP_ACCESS_TOKEN`을 직접 설정합니다. 프로젝트 최상위 `.env`의 `FRONTEND_ORIGIN`과 `BACKEND_PORT`는 Compose용 이름이며 직접 실행하는 백엔드는 읽지 않습니다.

## 6. 선택 사항: 백엔드 HTTPS

백엔드에도 HTTPS를 적용하려면 서버를 가리키는 도메인과 HTTPS 프록시를 설정합니다. 기존 프록시가 있다면 해당 프록시를 사용할 수 있습니다.

포트 80·443을 사용할 수 있는 서버에서 포함된 Caddy를 쓰려면 최상위 `.env`에 아래 값을 설정하고 `https` 프로필을 실행합니다.

```dotenv
API_HOST=api.example.com
BACKEND_BIND_ADDRESS=127.0.0.1
```

```sh
docker compose --profile https up -d --build
```

Caddy는 80·443을 사용해 HTTPS를 처리하고 Docker 내부 네트워크의 백엔드로 연결합니다. 기존 서비스가 이 포트를 사용 중이면 먼저 기존 프록시 구성을 확인합니다. Vercel 프록시의 HTTPS 대상도 사용하려면 `frontend/vercel.json`의 `destination`을 `https://api.example.com/api/:path*`로 바꾸고 다시 배포합니다.

공식 참고: [Vercel 외부 rewrite](https://vercel.com/docs/rewrites#external-rewrites), [Vite 환경변수](https://vite.dev/guide/env-and-mode), [Docker Compose 프로필](https://docs.docker.com/compose/how-tos/profiles/).
