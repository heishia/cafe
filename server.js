const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  NAVER_CLIENT_ID,
  NAVER_CLIENT_SECRET,
  NAVER_REDIRECT_URI,
  NAVER_REFRESH_TOKEN,
  NAVER_CAFE_CLUB_ID,
  NAVER_CAFE_MENU_ID,
  NAVER_SERVER_API_KEY,
  PORT = 3000,
} = process.env;

const NAVER_AUTH_URL = "https://nid.naver.com/oauth2.0/authorize";
const NAVER_TOKEN_URL = "https://nid.naver.com/oauth2.0/token";
const NAVER_CAFE_API_BASE_URL = "https://openapi.naver.com/v1/cafe";

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
}

function createState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function requireServerApiKey(req, res, next) {
  if (!NAVER_SERVER_API_KEY) {
    return next();
  }

  const apiKey = req.get("x-api-key");

  if (apiKey !== NAVER_SERVER_API_KEY) {
    return res.status(401).json({
      ok: false,
      message: "유효한 x-api-key 헤더가 필요합니다.",
    });
  }

  return next();
}

function encodeFormUtf8(data) {
  return new URLSearchParams(data).toString();
}

async function refreshNaverAccessToken() {
  requiredEnv("NAVER_CLIENT_ID", NAVER_CLIENT_ID);
  requiredEnv("NAVER_CLIENT_SECRET", NAVER_CLIENT_SECRET);
  requiredEnv("NAVER_REFRESH_TOKEN", NAVER_REFRESH_TOKEN);

  const tokenUrl = new URL(NAVER_TOKEN_URL);
  tokenUrl.searchParams.set("grant_type", "refresh_token");
  tokenUrl.searchParams.set("client_id", NAVER_CLIENT_ID);
  tokenUrl.searchParams.set("client_secret", NAVER_CLIENT_SECRET);
  tokenUrl.searchParams.set("refresh_token", NAVER_REFRESH_TOKEN);

  const tokenResponse = await fetch(tokenUrl);
  const tokenBody = await tokenResponse.json();

  if (!tokenResponse.ok || tokenBody.error) {
    const message = tokenBody.error_description || tokenBody.error || "알 수 없는 오류";
    throw new Error(`네이버 access token 재발급 실패: ${message}`);
  }

  return tokenBody;
}

app.get("/", (req, res) => {
  res.type("text/plain").send("OK - Naver OAuth mini server is running.");
});

app.get("/login", (req, res, next) => {
  try {
    requiredEnv("NAVER_CLIENT_ID", NAVER_CLIENT_ID);
    requiredEnv("NAVER_REDIRECT_URI", NAVER_REDIRECT_URI);

    const url = new URL(NAVER_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", NAVER_CLIENT_ID);
    url.searchParams.set("redirect_uri", NAVER_REDIRECT_URI);
    url.searchParams.set("state", createState());

    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

app.get("/callback", async (req, res, next) => {
  try {
    requiredEnv("NAVER_CLIENT_ID", NAVER_CLIENT_ID);
    requiredEnv("NAVER_CLIENT_SECRET", NAVER_CLIENT_SECRET);
    requiredEnv("NAVER_REDIRECT_URI", NAVER_REDIRECT_URI);

    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      return res.status(400).json({
        ok: false,
        message: "네이버 로그인이 취소되었거나 실패했습니다.",
        error,
        errorDescription,
      });
    }

    if (!code || !state) {
      return res.status(400).json({
        ok: false,
        message: "callback에는 code와 state 쿼리값이 필요합니다.",
      });
    }

    const tokenUrl = new URL(NAVER_TOKEN_URL);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    tokenUrl.searchParams.set("client_id", NAVER_CLIENT_ID);
    tokenUrl.searchParams.set("client_secret", NAVER_CLIENT_SECRET);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("state", state);

    const tokenResponse = await fetch(tokenUrl);
    const tokenBody = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        ok: false,
        message: "네이버 access token 발급에 실패했습니다.",
        naverResponse: tokenBody,
      });
    }

    return res.json({
      ok: true,
      message: "네이버 access token 발급 성공",
      token: tokenBody,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/refresh", requireServerApiKey, async (req, res, next) => {
  try {
    const tokenBody = await refreshNaverAccessToken();

    return res.json({
      ok: true,
      message: "네이버 access token 재발급 성공",
      token: tokenBody,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/post-to-cafe", requireServerApiKey, async (req, res, next) => {
  try {
    requiredEnv("NAVER_CAFE_CLUB_ID", NAVER_CAFE_CLUB_ID);
    requiredEnv("NAVER_CAFE_MENU_ID", NAVER_CAFE_MENU_ID);

    const { subject, content } = req.body || {};

    if (!subject || !content) {
      return res.status(400).json({
        ok: false,
        message: "subject와 content가 필요합니다.",
      });
    }

    const tokenBody = await refreshNaverAccessToken();
    const articleUrl = `${NAVER_CAFE_API_BASE_URL}/${NAVER_CAFE_CLUB_ID}/menu/${NAVER_CAFE_MENU_ID}/articles`;
    const articleFormBody = encodeFormUtf8({ subject, content });

    const articleResponse = await fetch(articleUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: articleFormBody,
    });
    const articleBody = await articleResponse.json();

    if (!articleResponse.ok) {
      return res.status(articleResponse.status).json({
        ok: false,
        message: "네이버 카페 글쓰기에 실패했습니다.",
        naverResponse: articleBody,
      });
    }

    return res.json({
      ok: true,
      message: "네이버 카페 글쓰기 성공",
      naverResponse: articleBody,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    ok: false,
    message: error.message || "서버 오류가 발생했습니다.",
  });
});

app.listen(PORT, () => {
  console.log(`Naver OAuth mini server listening on port ${PORT}`);
});
