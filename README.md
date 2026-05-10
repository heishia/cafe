# Naver Cafe AI Draft Helper

네이버 OAuth와 카페 API를 사용해 게시글/댓글 초안을 만들고, 운영자가 승인한 초안만 게시하는 보조 서버입니다.

## Routes

- `GET /`: 서버 상태 확인
- `GET /login`: 네이버 로그인 페이지로 이동
- `GET /callback`: 네이버가 넘겨준 `code`를 access token으로 교환
- `GET /refresh`: refresh token으로 access token 재발급
- `POST /drafts/comment`: 카페 게시글 본문을 읽고 댓글 초안 생성
- `POST /drafts/article`: 주제와 메모를 바탕으로 게시글 초안 생성
- `GET /drafts`: 초안 목록 조회
- `GET /drafts/:id`: 초안 상세 조회
- `POST /drafts/:id/approve`: 사람이 검토한 초안 승인
- `POST /drafts/:id/reject`: 초안 반려
- `POST /drafts/:id/publish`: 승인된 초안만 네이버 카페에 게시
- `POST /post-to-cafe`: 기존 직접 게시 API

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
NAVER_REFRESH_TOKEN=...
NAVER_CAFE_CLUB_ID=...
NAVER_CAFE_MENU_ID=...
NAVER2_CLIENT_ID=...
NAVER2_CLIENT_SECRET=...
NAVER2_REDIRECT_URI=http://localhost:3000/callback
NAVER2_REFRESH_TOKEN=...
NAVER2_CAFE_CLUB_ID=31635484
NAVER2_CAFE_MENU_ID=22
NAVER_SERVER_API_KEY=...
AI_API_KEY=...
AI_MODEL=gpt-4o-mini
AI_API_BASE_URL=https://api.openai.com/v1
NAVER_DRAFT_ACCOUNT=2
PORT=3000
```

`NAVER_SERVER_API_KEY`가 있으면 보호된 API는 `x-api-key` 헤더가 필요합니다.
AI 초안 승인 게시 흐름은 기본적으로 `NAVER_DRAFT_ACCOUNT=2`에 해당하는 `NAVER2_*` 계정을 사용합니다.

로컬 테스트용 네이버 개발자센터 설정:

- 서비스 URL: `http://localhost:3000`
- Callback URL: `http://localhost:3000/callback`

## Railway Deploy

Railway에 배포한 뒤 Variables에 아래 값을 등록합니다.

```env
NAVER_CLIENT_ID=...
NAVER_CLIENT_SECRET=...
NAVER_REDIRECT_URI=https://your-railway-domain.up.railway.app/callback
NAVER2_CLIENT_ID=...
NAVER2_CLIENT_SECRET=...
NAVER2_REDIRECT_URI=https://your-railway-domain.up.railway.app/callback
NAVER2_REFRESH_TOKEN=...
NAVER2_CAFE_CLUB_ID=31635484
NAVER2_CAFE_MENU_ID=22
NAVER_DRAFT_ACCOUNT=2
```

Railway 배포 후 네이버 개발자센터에는 아래처럼 등록합니다.

- 서비스 URL: `https://your-railway-domain.up.railway.app`
- Callback URL: `https://your-railway-domain.up.railway.app/callback`

등록 후 브라우저에서 아래 주소로 테스트합니다.

```text
https://your-railway-domain.up.railway.app/login
```

두 번째 계정의 refresh token을 발급하려면 아래 주소로 접속합니다.

```text
https://your-railway-domain.up.railway.app/login?account=2
```

로그인 후 `/callback` 응답의 `token.refresh_token` 값을 `NAVER2_REFRESH_TOKEN`에 저장합니다.

## AI Draft Flow

이 서버는 자동으로 댓글이나 게시글을 올리지 않습니다. 항상 아래 순서를 거칩니다.

1. AI가 초안을 생성합니다.
2. 초안은 `data/drafts.json`에 `pending` 상태로 저장됩니다.
3. 운영자가 내용을 검토하고 필요하면 수정하면서 승인합니다.
4. 승인된 초안만 `publish` API로 네이버 카페에 게시됩니다.

댓글 초안 생성 예시:

```bash
curl -X POST http://localhost:3000/drafts/comment \
  -H "Content-Type: application/json" \
  -H "x-api-key: $NAVER_SERVER_API_KEY" \
  -d "{\"articleTitle\":\"바이브코딩 질문\",\"articleContent\":\"요즘 Cursor로 리팩토링할 때 어떤 식으로 프롬프트를 잡나요?\",\"articleId\":\"123\",\"context\":\"초보자에게 부담 없는 톤\"}"
```

게시글 초안 생성 예시:

```bash
curl -X POST http://localhost:3000/drafts/article \
  -H "Content-Type: application/json" \
  -H "x-api-key: $NAVER_SERVER_API_KEY" \
  -d "{\"topic\":\"Cursor로 작은 리팩토링을 시작하는 방법\",\"notes\":\"체크리스트와 실패를 줄이는 팁 포함\"}"
```

초안 승인 예시:

```bash
curl -X POST http://localhost:3000/drafts/{draftId}/approve \
  -H "Content-Type: application/json" \
  -H "x-api-key: $NAVER_SERVER_API_KEY" \
  -d "{\"reviewer\":\"admin\",\"content\":\"검토 후 수정한 최종 댓글 또는 본문\"}"
```

승인된 초안 게시 예시:

```bash
curl -X POST http://localhost:3000/drafts/{draftId}/publish \
  -H "Content-Type: application/json" \
  -H "x-api-key: $NAVER_SERVER_API_KEY" \
  -d "{}"
```

댓글 초안은 생성 시 `articleId`를 넣지 않았다면 게시할 때 본문에 넣어야 합니다.

```bash
curl -X POST http://localhost:3000/drafts/{draftId}/publish \
  -H "Content-Type: application/json" \
  -H "x-api-key: $NAVER_SERVER_API_KEY" \
  -d "{\"articleId\":\"123\"}"
```
