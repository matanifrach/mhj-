// Edge Function: מזרים תשובות לדפדפן (Streaming).
// סדר עדיפויות: Gemini (ראשי, כולל חיפוש Google מובנה) ← מודל Gemini קל יותר ← Groq (גיבוי אחרון).
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const sse = (body, provider) =>
  new Response(body, { headers: { "content-type": "text/event-stream", "x-provider": encodeURIComponent(provider) } });

const RULES =
  " כתוב אך ורק בעברית תקנית, בלי מילים בשפות אחרות חוץ ממספרים וסימנים מתמטיים." +
  " כתוב טקסט פשוט: בלי LaTeX, בלי סימני דולר ובלי Markdown. לחישובים השתמש ב- × ÷ + − =.";
const SYSTEM = {
  answer:
    "פתור את השאלה בקפידה, שלב אחרי שלב ובקצרה, ובדוק את עצמך (מי התחיל קודם, יחידות מידה, מלכודות היגיון). " +
    "בסוף כתוב שורה נפרדת שמתחילה ב'תשובה:' ובה רק התשובה הסופית." + RULES,
  explain:
    "אתה מורה פרטי סבלני. הסבר את הפתרון שלב אחרי שלב בעברית פשוטה וברורה, ובדוק את החישוב. " +
    "בסוף כתוב שורה נפרדת שמתחילה ב'תשובה:'." + RULES,
  search:
    "אתה עוזר מחקר זהיר. השתמש בחיפוש Google וענה רק לפי מה שהמקורות אומרים במפורש. " +
    "ענה בקצרה. אם המקורות סותרים, ישנים או לא עונים במפורש על השאלה, כתוב זאת ואל תנחש. " +
    "אם אין מידע אמין, כתוב: לא מצאתי מידע אמין. אל תמסור כתובת מגורים מדויקת של אנשים פרטיים." + RULES,
};

// מודל Gemini קל לגיבוי, נבחר מתוך רשימת המודלים שזמינים בפועל לחשבון
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
  const { password, question, image, explain, check, search } = await req.json().catch(() => ({}));
  const pass = Netlify.env.get("APP_PASSWORD");
  if (!pass || password !== pass) return json({ error: "סיסמה שגויה" }, 401);
  if (check) return json({ ok: true });
  if (!question && !image) return json({ error: "אין שאלה" }, 400);

  const mode = search ? "search" : explain ? "explain" : "answer";
  const gKey = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  const qKey = (Netlify.env.get("GROQ_API_KEY") || "").trim();
  const notes = [];

  // ---------- Gemini ----------
  if (gKey) {
    const parts = [];
    if (question) parts.push({ text: question });
    const m = image?.match(/^data:(.+?);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });

    const gemini = (model, fast) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM[mode] }] },
          contents: [{ role: "user", parts }],
          ...(search ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            temperature: 0.2,
            ...(fast ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
          },
        }),
        signal: AbortSignal.timeout(15000),
      }).catch((e) => ({ ok: false, status: e.name === "TimeoutError" ? 504 : 0, json: async () => ({}) }));

    const main = Netlify.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
    const fast = mode === "answer";
    let r = await gemini(main, fast);
    if (fast && r.status === 400) r = await gemini(main, false); // המודל לא תומך בהגדרת החשיבה
    if (r.ok) return sse(r.body, `Gemini (${main})`);
    notes.push(`Gemini ${main}: ${r.status || "אין חיבור"}`);

    // עומס או איטיות: מנסים מודל Gemini קל יותר
    if ([429, 500, 503, 504].includes(r.status)) {
      const lite = await pickLite(gKey, main);
      if (lite) {
        const r2 = await gemini(lite, false);
        if (r2.ok) return sse(r2.body, `Gemini (${lite})`);
        notes.push(`Gemini ${lite}: ${r2.status || "אין חיבור"}`);
      }
    } else {
      const g = await r.json().catch(() => ({}));
      if (g.error?.message) notes.push(g.error.message);
    }
  } else notes.push("חסר GEMINI_API_KEY");

  // ---------- Groq: גיבוי אחרון, רק לטקסט ולא לחיפוש ----------
  if (qKey && !image && !search) {
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
      if (gr?.ok) return sse(gr.body, `Groq (${model}) - גיבוי`);
      notes.push(`Groq: ${gr?.status || "אין חיבור"}`);
    }
  }

  return json({ error: "כל המנועים עמוסים כרגע, נסה שוב בעוד רגע.\n" + notes.join(" | ") }, 503);
};

export const config = { path: "/api/ask" };
