# Naver OAuth Mini Server

네이버 로그인 결과를 받을 수 있는 최소 서버입니다.

## Routes

- `GET /`: 서버 상태 확인
- `GET /login`: 네이버 로그인 페이지로 이동
- `GET /callback`: 네이버가 넘겨준 `code`를 access token으로 교환

## Local Run

```bash
npm install
copy .env.example .env
npm run dev
```

`.env`에는 네이버 개발자센터에서 받은 값을 넣습니다.

```env
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
NAVER_REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

로컬 테스트용 네이버 개발자센터 설정:

- 서비스 URL: `http://localhost:3000`
- Callback URL: `http://localhost:3000/callback`

## Railway Deploy

Railway에 배포한 뒤 Variables에 아래 값을 등록합니다.

```env
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
NAVER_REDIRECT_URI=https://your-railway-domain.up.railway.app/callback
```

Railway 배포 후 네이버 개발자센터에는 아래처럼 등록합니다.

- 서비스 URL: `https://your-railway-domain.up.railway.app`
- Callback URL: `https://your-railway-domain.up.railway.app/callback`

등록 후 브라우저에서 아래 주소로 테스트합니다.

```text
https://your-railway-domain.up.railway.app/login
```
