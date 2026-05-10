const fs = require("fs/promises");
const path = require("path");
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
  DRAFTS_STORE_PATH,
  NAVER_DRAFT_ACCOUNT = "2",
  PORT = 3000,
} = process.env;

const NAVER_AUTH_URL = "https://nid.naver.com/oauth2.0/authorize";
const NAVER_TOKEN_URL = "https://nid.naver.com/oauth2.0/token";
const NAVER_CAFE_API_BASE_URL = "https://openapi.naver.com/v1/cafe";
const DRAFTS_FILE_PATH = DRAFTS_STORE_PATH
  ? path.resolve(DRAFTS_STORE_PATH)
  : path.join(__dirname, "data", "drafts.json");

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function normalizeAccountKey(value) {
  const key = String(value || "default").trim();

  if (key === "default" || key === "1") {
    return "default";
  }

  return /^\d+$/.test(key) ? key : "default";
}

function getNaverConfig(accountKey = "default") {
  const normalizedAccountKey = normalizeAccountKey(accountKey);

  if (normalizedAccountKey !== "default") {
    const envPrefix = `NAVER${normalizedAccountKey}`;

    return {
      accountKey: normalizedAccountKey,
      clientId: process.env[`${envPrefix}_CLIENT_ID`],
      clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`],
      redirectUri: process.env[`${envPrefix}_REDIRECT_URI`] || NAVER_REDIRECT_URI,
      refreshToken: process.env[`${envPrefix}_REFRESH_TOKEN`],
      cafeClubId: process.env[`${envPrefix}_CAFE_CLUB_ID`],
      cafeMenuId: process.env[`${envPrefix}_CAFE_MENU_ID`],
      envPrefix,
    };
  }

  return {
    accountKey: "default",
    clientId: NAVER_CLIENT_ID,
    clientSecret: NAVER_CLIENT_SECRET,
    redirectUri: NAVER_REDIRECT_URI,
    refreshToken: NAVER_REFRESH_TOKEN,
    cafeClubId: NAVER_CAFE_CLUB_ID,
    cafeMenuId: NAVER_CAFE_MENU_ID,
    envPrefix: "NAVER",
  };
}

function createState(accountKey = "default") {
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${normalizeAccountKey(accountKey)}.${state}`;
}

function getAccountKeyFromState(state) {
  if (typeof state !== "string") {
    return "default";
  }

  return normalizeAccountKey(state.split(".")[0]);
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

function encodeNaverCafeArticleForm(data) {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(data)) {
    form.set(key, encodeURIComponent(String(value)));
  }

  return form.toString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPlainTextForCafeContent(value) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

async function readDrafts() {
  try {
    const file = await fs.readFile(DRAFTS_FILE_PATH, "utf8");
    const parsed = JSON.parse(file);

    if (!Array.isArray(parsed)) {
      throw new Error("초안 저장 파일은 배열 JSON이어야 합니다.");
    }

    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeDrafts(drafts) {
  const dir = path.dirname(DRAFTS_FILE_PATH);
  const tempPath = `${DRAFTS_FILE_PATH}.tmp`;

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, DRAFTS_FILE_PATH);
}

async function createDraft({ type, input, target, draft }) {
  const now = new Date().toISOString();
  const drafts = await readDrafts();
  const item = {
    id: createId("draft"),
    type,
    status: "pending",
    input,
    target: target || {},
    draft,
    review: null,
    publish: null,
    createdAt: now,
    updatedAt: now,
  };

  drafts.unshift(item);
  await writeDrafts(drafts);

  return item;
}

async function updateDraft(id, updater) {
  const drafts = await readDrafts();
  const index = drafts.findIndex((draft) => draft.id === id);

  if (index === -1) {
    return null;
  }

  const now = new Date().toISOString();
  drafts[index] = {
    ...drafts[index],
    ...updater(drafts[index], now),
    updatedAt: now,
  };

  await writeDrafts(drafts);

  return drafts[index];
}

async function getDraft(id) {
  const drafts = await readDrafts();
  return drafts.find((draft) => draft.id === id) || null;
}

async function refreshNaverAccessToken(accountKey = "default") {
  const config = getNaverConfig(accountKey);

  requiredEnv(`${config.envPrefix}_CLIENT_ID`, config.clientId);
  requiredEnv(`${config.envPrefix}_CLIENT_SECRET`, config.clientSecret);
  requiredEnv(`${config.envPrefix}_REFRESH_TOKEN`, config.refreshToken);

  const tokenUrl = new URL(NAVER_TOKEN_URL);
  tokenUrl.searchParams.set("grant_type", "refresh_token");
  tokenUrl.searchParams.set("client_id", config.clientId);
  tokenUrl.searchParams.set("client_secret", config.clientSecret);
  tokenUrl.searchParams.set("refresh_token", config.refreshToken);

  const tokenResponse = await fetch(tokenUrl);
  const tokenBody = await tokenResponse.json();

  if (!tokenResponse.ok || tokenBody.error) {
    const message = tokenBody.error_description || tokenBody.error || "알 수 없는 오류";
    throw new Error(`네이버 access token 재발급 실패: ${message}`);
  }

  return tokenBody;
}

async function postCafeComment({ content, clubId, menuId, articleId, accountKey = NAVER_DRAFT_ACCOUNT }) {
  const config = getNaverConfig(accountKey);
  const targetClubId = clubId || config.cafeClubId;
  const targetMenuId = menuId || config.cafeMenuId;

  requiredEnv(`${config.envPrefix}_CAFE_CLUB_ID`, targetClubId);
  requiredEnv(`${config.envPrefix}_CAFE_MENU_ID`, targetMenuId);
  requiredEnv("articleId", articleId);

  const tokenBody = await refreshNaverAccessToken(config.accountKey);
  const commentUrl = `${NAVER_CAFE_API_BASE_URL}/${targetClubId}/menu/${targetMenuId}/articles/${articleId}/comments`;
  const commentFormBody = encodeNaverCafeArticleForm({
    content: formatPlainTextForCafeContent(content),
  });

  const commentResponse = await fetch(commentUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: commentFormBody,
  });
  const commentBody = await commentResponse.json();

  if (!commentResponse.ok) {
    const error = new Error("네이버 카페 댓글쓰기에 실패했습니다.");
    error.status = commentResponse.status;
    error.naverResponse = commentBody;
    throw error;
  }

  return commentBody;
}

app.get("/", (req, res) => {
  res.type("text/plain").send("OK - Naver OAuth mini server is running.");
});

app.get("/login", (req, res, next) => {
  try {
    const config = getNaverConfig(req.query.account);

    requiredEnv(`${config.envPrefix}_CLIENT_ID`, config.clientId);
    requiredEnv(`${config.envPrefix}_REDIRECT_URI`, config.redirectUri);

    const url = new URL(NAVER_AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("state", createState(config.accountKey));

    res.redirect(url.toString());
  } catch (error) {
    next(error);
  }
});

app.get("/callback", async (req, res, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;
    const config = getNaverConfig(getAccountKeyFromState(state));

    requiredEnv(`${config.envPrefix}_CLIENT_ID`, config.clientId);
    requiredEnv(`${config.envPrefix}_CLIENT_SECRET`, config.clientSecret);
    requiredEnv(`${config.envPrefix}_REDIRECT_URI`, config.redirectUri);

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
    tokenUrl.searchParams.set("client_id", config.clientId);
    tokenUrl.searchParams.set("client_secret", config.clientSecret);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("state", state);

    const tokenResponse = await fetch(tokenUrl);
    const tokenBody = await tokenResponse.json();

    if (!tokenResponse.ok || tokenBody.error) {
      return res.status(tokenResponse.status).json({
        ok: false,
        message: "네이버 access token 발급에 실패했습니다.",
        naverResponse: tokenBody,
      });
    }

    return res.json({
      ok: true,
      message: "네이버 access token 발급 성공",
      account: config.accountKey,
      token: tokenBody,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/refresh", requireServerApiKey, async (req, res, next) => {
  try {
    const config = getNaverConfig(req.query.account);
    const tokenBody = await refreshNaverAccessToken(config.accountKey);

    return res.json({
      ok: true,
      message: "네이버 access token 재발급 성공",
      account: config.accountKey,
      token: tokenBody,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/drafts", requireServerApiKey, async (req, res, next) => {
  try {
    const { status, type } = req.query;
    const drafts = await readDrafts();
    const filtered = drafts.filter((draft) => {
      if (status && draft.status !== status) {
        return false;
      }

      if (type && draft.type !== type) {
        return false;
      }

      return true;
    });

    return res.json({
      ok: true,
      drafts: filtered,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/drafts/:id", requireServerApiKey, async (req, res, next) => {
  try {
    const draft = await getDraft(req.params.id);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        message: "초안을 찾지 못했습니다.",
      });
    }

    return res.json({
      ok: true,
      draft,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/drafts/comment", requireServerApiKey, async (req, res, next) => {
  try {
    const {
      articleTitle,
      articleContent,
      articleUrl,
      articleId,
      clubId,
      menuId,
      accountKey,
      authorNickname,
      context,
      content,
    } = req.body || {};

    if (!content) {
      return res.status(400).json({
        ok: false,
        message: "content가 필요합니다.",
      });
    }

    const input = {
      articleTitle,
      articleContent,
      authorNickname,
      context,
    };
    const draft = await createDraft({
      type: "comment",
      input,
      target: {
        articleUrl,
        articleId,
        clubId,
        menuId,
        accountKey: normalizeAccountKey(accountKey || NAVER_DRAFT_ACCOUNT),
      },
      draft: {
        content: String(content).trim(),
      },
    });

    return res.status(201).json({
      ok: true,
      message: "댓글 초안이 저장되었습니다. 승인 후 게시할 수 있습니다.",
      draft,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/drafts/:id/approve", requireServerApiKey, async (req, res, next) => {
  try {
    const { reviewer = "operator", note, subject, content } = req.body || {};
    const draft = await updateDraft(req.params.id, (current, now) => {
      if (current.status === "published") {
        const error = new Error("이미 게시된 초안은 승인 상태로 되돌릴 수 없습니다.");
        error.status = 409;
        throw error;
      }

      return {
        status: "approved",
        draft: {
          ...current.draft,
          subject: subject || current.draft.subject || null,
          content: content || current.draft.content,
        },
        review: {
          reviewer,
          note: note || null,
          approvedAt: now,
        },
      };
    });

    if (!draft) {
      return res.status(404).json({
        ok: false,
        message: "초안을 찾지 못했습니다.",
      });
    }

    return res.json({
      ok: true,
      message: "초안이 승인되었습니다.",
      draft,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/drafts/:id/reject", requireServerApiKey, async (req, res, next) => {
  try {
    const { reviewer = "operator", reason } = req.body || {};
    const draft = await updateDraft(req.params.id, (current, now) => {
      if (current.status === "published") {
        const error = new Error("이미 게시된 초안은 반려할 수 없습니다.");
        error.status = 409;
        throw error;
      }

      return {
        status: "rejected",
        review: {
          reviewer,
          reason: reason || null,
          rejectedAt: now,
        },
      };
    });

    if (!draft) {
      return res.status(404).json({
        ok: false,
        message: "초안을 찾지 못했습니다.",
      });
    }

    return res.json({
      ok: true,
      message: "초안이 반려되었습니다.",
      draft,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/drafts/:id/publish", requireServerApiKey, async (req, res, next) => {
  try {
    const draft = await getDraft(req.params.id);

    if (!draft) {
      return res.status(404).json({
        ok: false,
        message: "초안을 찾지 못했습니다.",
      });
    }

    if (draft.status !== "approved") {
      return res.status(409).json({
        ok: false,
        message: "승인된 초안만 게시할 수 있습니다.",
      });
    }

    if (draft.type !== "comment") {
      return res.status(400).json({
        ok: false,
        message: "댓글 초안만 게시할 수 있습니다.",
      });
    }

    const target = {
      ...draft.target,
      ...(req.body || {}),
    };
    const naverResponse = await postCafeComment({
      content: draft.draft.content,
      clubId: target.clubId,
      menuId: target.menuId,
      articleId: target.articleId,
      accountKey: target.accountKey || NAVER_DRAFT_ACCOUNT,
    });
    const publishedDraft = await updateDraft(req.params.id, (current, now) => ({
      status: "published",
      target,
      publish: {
        publishedAt: now,
        naverResponse,
      },
    }));

    return res.json({
      ok: true,
      message: "승인된 초안이 네이버 카페에 게시되었습니다.",
      draft: publishedDraft,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({
    ok: false,
    message: error.message || "서버 오류가 발생했습니다.",
    ...(error.naverResponse ? { naverResponse: error.naverResponse } : {}),
  });
});

app.listen(PORT, () => {
  console.log(`Naver OAuth mini server listening on port ${PORT}`);
});
