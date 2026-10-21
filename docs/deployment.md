# Vercel 프론트엔드 + 별도 서버 백엔드 배포

## 1. 프론트엔드: Vercel

1. 이 프로젝트를 Git 저장소에 올린 뒤 Vercel에서 가져옵니다.
2. Root Directory를 `frontend`, Framework를 `Vite`로 지정합니다.
3. 환경변수 `VITE_API_URL`에 백엔드 HTTPS 주소와 `/api`를 입력합니다. 예: `https://api.example.com/api`.
4. 빌드는 `npm run build`, 결과 폴더는 `dist`입니다. `frontend/vercel.json`에 설정되어 있습니다.
5. 배포한 프론트 도메인을 아래 `FRONTEND_ORIGIN`에 그대로 지정합니다.

`VITE_` 변수는 공개되는 프론트 코드에 들어갑니다. 개인 접속키와 AI 서비스 키는 여기에 넣지 않습니다. 개인 접속키는 실행된 앱의 연결 설정에서 본인 기기에 입력합니다.

## 2. 백엔드: 별도 서버

Docker와 Compose를 사용할 수 있는 서버에 프로젝트를 복사합니다. 백엔드 도메인의 DNS가 서버를 가리키도록 설정한 뒤 프로젝트 루트의 `.env.example`을 `.env`로 복사하고 값을 채웁니다.

백엔드 이미지는 Node.js 24와 Fastify로 실행됩니다. 서버에 Node.js나 Python을 직접 설치할 필요는 없습니다. 컨테이너는 일반 사용자(UID 10001)로 실행되며 종료 신호를 받아 요청과 DB 연결을 정리합니다.

```dotenv
API_HOST=api.example.com
FRONTEND_ORIGIN=https://your-frontend.vercel.app
APP_ACCESS_TOKEN=long-random-personal-access-key
```

```sh
docker compose up -d --build
docker compose logs --tail=50 backend
docker compose ps
```

Caddy가 80/443 포트에서 HTTPS를 처리하고 내부 백엔드로 연결합니다. 기존에 Nginx나 다른 HTTPS 프록시를 쓰는 서버라면 Caddy 대신 그 프록시에서 백엔드로 연결하면 됩니다. 백엔드만 실행할 때는 `docker compose up -d --build backend`이며 내부 주소는 `127.0.0.1:8000`입니다.

외부 접속은 허용하되 사용자 계정을 만들지 않고 본인 기기의 개인 접속키로 API를 사용합니다. 운영 환경은 접속키가 비어 있으면 시작하지 않습니다. 허용할 프론트 주소는 `CORS_ORIGINS`로 지정하며 Compose에서는 `FRONTEND_ORIGIN` 값이 연결됩니다.

SQLite 파일은 `ledger_data` 볼륨에 남습니다. 컨테이너를 새로 만들어도 같은 볼륨을 쓰면 거래가 유지됩니다. 앱에서 받는 JSON 백업으로 거래·태그·예산·저장된 분석 작업 공간을 복원할 수 있습니다. 비밀키는 서버 환경에서 별도로 유지합니다.

기존 Python 백엔드와 같은 SQLite 스키마와 `/app/data/moa.db` 경로, UID를 사용합니다. 기존 배포를 교체할 때는 먼저 앱에서 JSON 백업을 받고, 같은 프로젝트 이름·같은 볼륨으로 위 명령을 실행합니다. `docker compose down -v`는 데이터 볼륨을 지우므로 업데이트에 사용하지 않습니다. 로컬 SQLite 파일을 옮기는 경우 기존 서버를 먼저 종료하고 DB 파일과 남아 있는 `-wal`·`-shm` 파일을 함께 보존하거나 JSON 백업으로 복원합니다.

이미 다른 HTTPS 프록시를 사용하는 서버에서 백엔드 컨테이너만 실행하려면 다음과 같이 실행합니다.

```sh
docker compose up -d --build backend
curl http://127.0.0.1:8000/api/health
```

이 경우 외부 HTTPS 도메인에서 `127.0.0.1:8000`으로 연결하도록 프록시를 설정합니다.

## 3. 연결 확인

1. 백엔드 `https://api.example.com/api/health`가 정상인지 확인합니다.
2. Vercel 앱의 설정에서 백엔드 주소와 개인 접속키를 입력합니다.
3. 거래를 하나 입력하고 새로고침 후에도 남아 있는지 확인합니다.
4. 다른 기기에서도 같은 서버와 키로 접속하여 내역을 확인합니다.
5. 백업을 내려받아 파일이 생성되는지 확인합니다. 복원은 현재 데이터를 백업 내용으로 바꾸는 동작입니다.

배포를 실제로 완료하려면 Git 저장소 또는 Vercel 프로젝트, 백엔드 서버 접속 정보와 도메인이 필요합니다. 현재 소스에는 특정 계정이나 서버에 대한 접근 권한이 포함되어 있지 않습니다.

공식 참고: [Vite의 Vercel 배포](https://vite.dev/guide/static-deploy.html#vercel), [Vercel의 Vite 지원](https://vercel.com/docs/frameworks/frontend/vite), [Node.js SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [Fastify 서버 설정](https://fastify.dev/docs/latest/Reference/Server/).
