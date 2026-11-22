// Edge Function: Gemini עונה, ומחליט לבד מתי צריך לחפש באינטרנט (Function Calling + Tavily).
// גיבוי: מודל Gemini קל יותר, ואחריו Groq (בלי חיפוש).
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const enc = (s) => encodeURIComponent(s);
const sse = (body, provider, sources) => {
  const headers = { "content-type": "text/event-stream", "x-provider": enc(provider) };
  if (sources?.length) headers["x-sources"] = enc(JSON.stringify(sources));
  return new Response(body, { headers });
};
// תשובה שכבר מוכנה במלואה, בפורמט הזרם ש-Gemini משתמש בו
const sseText = (text, provider, sources) =>
  sse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`, provider, sources);

const RULES =
  " כתוב אך ורק בעברית תקנית, בלי מילים בשפות אחרות חוץ ממספרים וסימנים מתמטיים ושמות." +
  " כתוב טקסט פשוט: בלי LaTeX, בלי סימני דולר ובלי Markdown. לחישובים השתמש ב- × ÷ + − =.";
const SEARCH_RULE =
  " יש לך כלי web_search. השתמש בו רק כשהשאלה דורשת מידע עדכני או עובדות שאתה לא בטוח בהן" +
  " (אנשים, אירועים, חדשות, תאריכים, מחירים, ספורט, מקומות). לשאלות חשבון, היגיון, דקדוק או חומר לימודי קבוע אל תחפש." +
  " אחרי חיפוש, ענה רק לפי מה שכתוב בתוצאות, ואם הן לא עונות במפורש כתוב זאת ואל תנחש." +
  " אל תמסור כתובת מגורים מדויקת של אנשים פרטיים.";
const SYSTEM = {
  answer:
    "פתור את השאלה בקפידה, שלב אחרי שלב ובקצרה, ובדוק את עצמך (מי התחיל קודם, יחידות מידה, מלכודות היגיון). " +
    "בסוף כתוב שורה נפרדת שמתחילה ב'תשובה:' ובה רק התשובה הסופית." + RULES,
  explain:
    "אתה מורה פרטי סבלני. הסבר את הפתרון שלב אחרי שלב בעברית פשוטה וברורה, ובדוק את החישוב. " +
    "בסוף כתוב שורה נפרדת שמתחילה ב'תשובה:'." + RULES,
};

const SEARCH_TOOL = {
  function_declarations: [{
    name: "web_search",
    description: "חיפוש באינטרנט למידע עדכני או לעובדות שלא ידועות בוודאות",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "שאילתת חיפוש קצרה וממוקדת" } },
      required: ["query"],
    },
  }],
};

async function tavily(key, query) {
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 5, search_depth: "basic" }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!r?.ok) return { error: `החיפוש נכשל (${r?.status || "אין חיבור"})`, results: [] };
  const j = await r.json();
  return {
    results: (j.results || []).map((x) => ({ title: x.title, url: x.url, content: (x.content || "").slice(0, 1500) })),
  };
}

let liteCache;
async function pickLite(key, main) {
  if (liteCache !== undefined) return liteCache;
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace("models/", ""))
    .filter((n) => /flash/i.test(n) && n !== main && !/image|tts|audio|live|embed|preview|exp/i.test(n))
    .sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || b.localeCompare(a, "en", { numeric: true }));
  return (liteCache = names[0] || null);
}

let groqCache;
async function pickGroq(key) {
  if (groqCache) return groqCache;
  const r = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const ids = ((await r.json()).data || []).filter((m) => m.active !== false).map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|audio|speech|embed|compound|vision|ocr/i.test(id));
  const score = (id) => (/120b|235b|70b|maverick|kimi|qwen3/i.test(id) ? 0 : 1) + (/instant|8b|mini|small/i.test(id) ? 1 : 0);
  return (groqCache = ids.sort((a, b) => score(a) - score(b))[0] || null);
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { password, question, image, explain, check } = await req.json().catch(() => ({}));
  const pass = Netlify.env.get("APP_PASSWORD");
  if (!pass || password !== pass) return json({ error: "סיסמה שגויה" }, 401);
  if (check) return json({ ok: true });
  if (!question && !image) return json({ error: "אין שאלה" }, 400);

  const mode = explain ? "explain" : "answer";
  const gKey = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  const qKey = (Netlify.env.get("GROQ_API_KEY") || "").trim();
  const tKey = (Netlify.env.get("TAVILY_API_KEY") || "").trim();
  const notes = [];

  if (gKey) {
    const userParts = [];
    if (question) userParts.push({ text: question });
    const m = image?.match(/^data:(.+?);base64,(.+)$/);
    if (m) userParts.push({ inline_data: { mime_type: m[1], data: m[2] } });

    const gemini = (model, contents, { stream = true, tools = false } = {}) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM[mode] + (tools ? SEARCH_RULE : "") }] },
          contents,
          ...(tools ? { tools: [SEARCH_TOOL] } : {}),
          generationConfig: { temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(15000),
      }).catch((e) => ({ ok: false, status: e.name === "TimeoutError" ? 504 : 0, json: async () => ({}) }));
    const why = async (res) => ((await res.json().catch(() => ({}))).error?.message || "").slice(0, 160);

    const run = async (model) => {
      const contents = [{ role: "user", parts: userParts }];
      if (!tKey) {
        const r = await gemini(model, contents);
        return r.ok ? sse(r.body, `Gemini (${model})`) : r;
      }
      // שלב 1: Gemini מחליט אם צריך לחפש
      const r1 = await gemini(model, contents, { stream: false, tools: true });
      if (!r1.ok) return r1;
      const j1 = await r1.json();
      const parts = j1.candidates?.[0]?.content?.parts || [];
      const call = parts.find((p) => p.functionCall)?.functionCall;
      if (!call) {
        const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
        return sseText(text || "לא התקבלה תשובה", `Gemini (${model})`);
      }
      // שלב 2: מחפשים, ומחזירים את התוצאות ל-Gemini שיכתוב תשובה
      const q = call.args?.query || question;
      const found = await tavily(tKey, q);
      const sources = found.results.map((x) => ({ title: x.title, uri: x.url }));
      contents.push({ role: "model", parts });
      contents.push({ role: "user", parts: [{ functionResponse: { name: "web_search", response: { query: q, ...found } } }] });
      const r2 = await gemini(model, contents, { tools: true });
      return r2.ok ? sse(r2.body, `Gemini (${model}) + חיפוש באינטרנט`, sources) : r2;
    };

    const isOk = (res) => res instanceof Response && res.headers.get("content-type") === "text/event-stream";
    const main = Netlify.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
    let res = await run(main);
    if (isOk(res)) return res;
    notes.push(`Gemini ${main}: ${res.status || "אין חיבור"} ${await why(res)}`);
    if ([429, 500, 503, 504].includes(res.status)) {
      const lite = await pickLite(gKey, main);
      if (lite) {
        res = await run(lite);
        if (isOk(res)) return res;
        notes.push(`Gemini ${lite}: ${res.status || "אין חיבור"} ${await why(res)}`);
      }
    }
  } else notes.push("חסר GEMINI_API_KEY");

  // Groq: גיבוי אחרון, רק לטקסט ובלי חיפוש
  if (qKey && !image) {
    const model = Netlify.env.get("GROQ_MODEL") || (await pickGroq(qKey));
    if (model) {
      const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${qKey}` },
        body: JSON.stringify({
          model, stream: true, temperature: 0.2,
          messages: [{ role: "system", content: SYSTEM[mode] }, { role: "user", content: question }],
        }),
        signal: AbortSignal.timeout(12000),
      }).catch(() => null);
      if (gr?.ok) return sse(gr.body, `Groq (${model}) - גיבוי, בלי חיפוש`);
      notes.push(`Groq: ${gr?.status || "אין חיבור"}`);
    }
  }

  return json({ error: "כל המנועים עמוסים כרגע, נסה שוב בעוד רגע.\n" + notes.join(" | ") }, 503);
};

export const config = { path: "/api/ask" };
