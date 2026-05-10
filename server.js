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
  AI_API_KEY,
  AI_API_BASE_URL = "https://api.openai.com/v1",
  AI_MODEL = "gpt-4o-mini",
  DRAFTS_STORE_PATH,
  MAX_DAILY_PUBLISHES = "3",
  PORT = 3000,
} = process.env;

const NAVER_AUTH_URL = "https://nid.naver.com/oauth2.0/authorize";
const NAVER_TOKEN_URL = "https://nid.naver.com/oauth2.0/token";
const NAVER_CAFE_API_BASE_URL = "https://openapi.naver.com/v1/cafe";
const DRAFTS_FILE_PATH = DRAFTS_STORE_PATH
  ? path.resolve(DRAFTS_STORE_PATH)
  : path.join(__dirname, "data", "drafts.json");
const DEFAULT_PERSONA =
  "바이브코딩을 꾸준히 해 온 중급자 수준의 친절한 20대 여성 말투. 과장하지 않고, 실제 경험처럼 단정하지 않으며, 도움 되는 관찰과 질문을 자연스럽게 섞는다.";

function requiredEnv(name, value) {
  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }
}

function parsePositiveInt(name, value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name}은 1 이상의 정수여야 합니다.`);
  }

  return parsed;
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
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

function isPublishedToday(draft, now = new Date()) {
  if (!draft.publish?.publishedAt) {
    return false;
  }

  const published = new Date(draft.publish.publishedAt);

  return (
    published.getFullYear() === now.getFullYear() &&
    published.getMonth() === now.getMonth() &&
    published.getDate() === now.getDate()
  );
}

async function assertDailyPublishLimit() {
  const limit = parsePositiveInt("MAX_DAILY_PUBLISHES", MAX_DAILY_PUBLISHES);
  const drafts = await readDrafts();
  const todayCount = drafts.filter(isPublishedToday).length;

  if (todayCount >= limit) {
    const error = new Error(`오늘 게시 한도 ${limit}개에 도달했습니다.`);
    error.status = 429;
    throw error;
  }
}

function normalizeAiBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function buildDraftPrompt(type, input) {
  if (type === "comment") {
    return [
      "아래 네이버 카페 게시글을 읽고 댓글 초안을 작성해 주세요.",
      "",
      `페르소나: ${input.persona || DEFAULT_PERSONA}`,
      "원칙:",
      "- 사람을 속이는 자동 활동처럼 보이게 만들지 말고, 사람이 검토할 초안으로 작성합니다.",
      "- 글쓴이를 존중하고, 홍보/반복/과장 표현을 피합니다.",
      "- 본인이 직접 겪지 않은 경험은 실제 경험처럼 단정하지 않습니다.",
      "- 2~5문장 정도의 자연스러운 한국어 댓글로 작성합니다.",
      "- 필요한 경우 가벼운 질문을 하나만 덧붙입니다.",
      "",
      `게시글 제목: ${input.articleTitle || "(제목 없음)"}`,
      `게시글 본문:\n${input.articleContent}`,
      input.context ? `추가 맥락:\n${input.context}` : "",
    ].join("\n");
  }

  return [
    "네이버 카페에 올릴 게시글 초안을 작성해 주세요.",
    "",
    `페르소나: ${input.persona || DEFAULT_PERSONA}`,
    "원칙:",
    "- 사람이 검토한 뒤 게시할 초안으로 작성합니다.",
    "- 바이브코딩 중급자 관점에서 친절하고 실용적으로 씁니다.",
    "- 홍보성 문구, 과장, 반복 표현을 피합니다.",
    "- 제목은 40자 이내, 본문은 700자 이내로 작성합니다.",
    "",
    `주제: ${input.topic}`,
    input.notes ? `포함할 메모:\n${input.notes}` : "",
  ].join("\n");
}

function extractJsonObject(text) {
  const trimmed = text.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI 응답에서 JSON 객체를 찾지 못했습니다.");
  }

  return trimmed.slice(start, end + 1);
}

async function generateAiDraft(type, input) {
  requiredEnv("AI_API_KEY", AI_API_KEY);

  const response = await fetch(`${normalizeAiBaseUrl(AI_API_BASE_URL)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "너는 네이버 카페 운영자가 검토할 댓글/게시글 초안을 만드는 한국어 작성 보조 도구다. 반드시 JSON만 반환한다. 형식은 {\"subject\": string|null, \"content\": string, \"safetyNotes\": string[]} 이다.",
        },
        {
          role: "user",
          content: buildDraftPrompt(type, input),
        },
      ],
    }),
  });
  const body = await response.json();

  if (!response.ok) {
    const message = body.error?.message || "AI 초안 생성에 실패했습니다.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const message = body.choices?.[0]?.message?.content;

  if (!message) {
    throw new Error("AI 응답에 초안 내용이 없습니다.");
  }

  const parsed = JSON.parse(extractJsonObject(message));

  if (!parsed.content || typeof parsed.content !== "string") {
    throw new Error("AI 응답에는 문자열 content가 필요합니다.");
  }

  return {
    subject: parsed.subject || null,
    content: parsed.content.trim(),
    safetyNotes: Array.isArray(parsed.safetyNotes) ? parsed.safetyNotes : [],
    model: AI_MODEL,
  };
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

async function postCafeArticle({ subject, content, clubId, menuId }) {
  const targetClubId = clubId || NAVER_CAFE_CLUB_ID;
  const targetMenuId = menuId || NAVER_CAFE_MENU_ID;

  requiredEnv("NAVER_CAFE_CLUB_ID", targetClubId);
  requiredEnv("NAVER_CAFE_MENU_ID", targetMenuId);

  const tokenBody = await refreshNaverAccessToken();
  const articleUrl = `${NAVER_CAFE_API_BASE_URL}/${targetClubId}/menu/${targetMenuId}/articles`;
  const articleFormBody = encodeNaverCafeArticleForm({
    subject,
    content: formatPlainTextForCafeContent(content),
  });

  const articleResponse = await fetch(articleUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: articleFormBody,
  });
  const articleBody = await articleResponse.json();

  if (!articleResponse.ok) {
    const error = new Error("네이버 카페 글쓰기에 실패했습니다.");
    error.status = articleResponse.status;
    error.naverResponse = articleBody;
    throw error;
  }

  return articleBody;
}

async function postCafeComment({ content, clubId, menuId, articleId }) {
  const targetClubId = clubId || NAVER_CAFE_CLUB_ID;
  const targetMenuId = menuId || NAVER_CAFE_MENU_ID;

  requiredEnv("NAVER_CAFE_CLUB_ID", targetClubId);
  requiredEnv("NAVER_CAFE_MENU_ID", targetMenuId);
  requiredEnv("articleId", articleId);

  const tokenBody = await refreshNaverAccessToken();
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
      authorNickname,
      context,
      persona,
    } = req.body || {};

    if (!articleContent) {
      return res.status(400).json({
        ok: false,
        message: "articleContent가 필요합니다.",
      });
    }

    const input = {
      articleTitle,
      articleContent,
      authorNickname,
      context,
      persona,
    };
    const aiDraft = await generateAiDraft("comment", input);
    const draft = await createDraft({
      type: "comment",
      input,
      target: {
        articleUrl,
        articleId,
        clubId,
        menuId,
      },
      draft: {
        content: aiDraft.content,
        safetyNotes: aiDraft.safetyNotes,
        model: aiDraft.model,
      },
    });

    return res.status(201).json({
      ok: true,
      message: "댓글 초안이 생성되었습니다. 승인 후 게시할 수 있습니다.",
      draft,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/drafts/article", requireServerApiKey, async (req, res, next) => {
  try {
    const { topic, notes, clubId, menuId, persona } = req.body || {};

    if (!topic) {
      return res.status(400).json({
        ok: false,
        message: "topic이 필요합니다.",
      });
    }

    const input = {
      topic,
      notes,
      persona,
    };
    const aiDraft = await generateAiDraft("article", input);
    const draft = await createDraft({
      type: "article",
      input,
      target: {
        clubId,
        menuId,
      },
      draft: {
        subject: aiDraft.subject || topic,
        content: aiDraft.content,
        safetyNotes: aiDraft.safetyNotes,
        model: aiDraft.model,
      },
    });

    return res.status(201).json({
      ok: true,
      message: "게시글 초안이 생성되었습니다. 승인 후 게시할 수 있습니다.",
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

    await assertDailyPublishLimit();

    const target = {
      ...draft.target,
      ...(req.body || {}),
    };
    const naverResponse =
      draft.type === "comment"
        ? await postCafeComment({
            content: draft.draft.content,
            clubId: target.clubId,
            menuId: target.menuId,
            articleId: target.articleId,
          })
        : await postCafeArticle({
            subject: draft.draft.subject,
            content: draft.draft.content,
            clubId: target.clubId,
            menuId: target.menuId,
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

app.post("/post-to-cafe", requireServerApiKey, async (req, res, next) => {
  try {
    const { subject, content, clubId, menuId } = req.body || {};

    if (!subject || !content) {
      return res.status(400).json({
        ok: false,
        message: "subject와 content가 필요합니다.",
      });
    }

    const articleBody = await postCafeArticle({ subject, content, clubId, menuId });

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
  res.status(error.status || 500).json({
    ok: false,
    message: error.message || "서버 오류가 발생했습니다.",
    ...(error.naverResponse ? { naverResponse: error.naverResponse } : {}),
  });
});

app.listen(PORT, () => {
  console.log(`Naver OAuth mini server listening on port ${PORT}`);
});
