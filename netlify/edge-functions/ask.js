// Edge Function: מזרים את התשובה מ-Gemini ישירות לדפדפן (Streaming).
// ככה המילים מתחילות להופיע מהר, ואין מגבלת 10 השניות של Functions רגילות.
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// בחירה אוטומטית של מודל Groq מתוך הרשימה שזמינה בפועל לחשבון (נשמר בזיכרון בין בקשות)
let groqModelCache = null;
async function pickGroqModel(key) {
  if (groqModelCache) return groqModelCache;
  const r = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return null;
  const ids = ((await r.json()).data || [])
    .filter((m) => m.active !== false)
    .map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|audio|speech|embed|compound|vision|ocr/i.test(id));
  // העדפה: מודלים גדולים (טובים יותר בעברית), אחר כך כל השאר
  const score = (id) =>
    (/120b|235b|405b|70b|maverick|kimi|qwen3/i.test(id) ? 0 : 1) + (/instant|8b|mini|small/i.test(id) ? 1 : 0);
  ids.sort((a, b) => score(a) - score(b));
  groqModelCache = ids[0] || null;
  return groqModelCache;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { password, question, image, explain, check, noGroq } = await req.json().catch(() => ({}));
  const pass = Netlify.env.get("APP_PASSWORD");
  if (!pass || password !== pass) return json({ error: "סיסמה שגויה" }, 401);
  if (check) return json({ ok: true });

  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  if (!key) return json({ error: "חסר GEMINI_API_KEY ב-Netlify" }, 500);
  if (!question && !image) return json({ error: "אין שאלה" }, 400);

  const system = explain
    ? "אתה מורה פרטי סבלני. הסבר את הפתרון שלב אחרי שלב בעברית פשוטה וברורה, ובסוף כתוב את התשובה הסופית בשורה נפרדת שמתחילה ב'תשובה:'. כתוב אך ורק בעברית תקנית. אסור לשלב מילים בשפות אחרות (רוסית, גרמנית, אנגלית, סינית וכדומה), חוץ ממספרים וסימנים מתמטיים. בדוק את החישוב לפני שאתה עונה. כתוב טקסט פשוט בלבד: בלי LaTeX, בלי סימני דולר ובלי סימני Markdown כמו כוכביות או סולמיות. לחישובים השתמש בסימנים × ÷ + − =."
    : "פתור את השאלה בקפידה, שלב אחרי שלב ובקצרה, ובדוק את עצמך (למשל: מי יצא קודם, יחידות מידה, מלכודות היגיון). בסוף כתוב שורה נפרדת שמתחילה ב'תשובה:' ובה רק התשובה הסופית, קצרה וברורה. כתוב אך ורק בעברית תקנית. אסור לשלב מילים בשפות אחרות (רוסית, גרמנית, אנגלית, סינית וכדומה), חוץ ממספרים וסימנים מתמטיים. בדוק את החישוב לפני שאתה עונה. כתוב טקסט פשוט בלבד: בלי LaTeX, בלי סימני דולר ובלי סימני Markdown כמו כוכביות או סולמיות. לחישובים השתמש בסימנים × ÷ + − =.";

  const parts = [];
  if (question) parts.push({ text: question });
  if (image) {
    const m = image.match(/^data:(.+?);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }

  const stream = (body, provider) =>
    new Response(body, { headers: { "content-type": "text/event-stream", "x-provider": provider } });

  // 1) Groq: מהיר, לשאלות טקסט. אם נכשל מכל סיבה, ממשיכים ל-Gemini.
  const groqKey = (Netlify.env.get("GROQ_API_KEY") || "").trim();
  let groqNote = groqKey ? "" : "Groq: המפתח GROQ_API_KEY לא נמצא";
  const groqModel = groqKey && !image && !noGroq
    ? Netlify.env.get("GROQ_MODEL") || (await pickGroqModel(groqKey).catch(() => null))
    : null;
  if (groqKey && !image && !groqModel) groqNote = "Groq: לא נמצא מודל זמין";
  if (groqModel) {
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: groqModel,
        stream: true,
        temperature: 0.2,
        messages: [{ role: "system", content: system }, { role: "user", content: question }],
      }),
      signal: AbortSignal.timeout(12000),
    }).catch((e) => { groqNote = "Groq: " + e.name; return null; });
    if (gr?.ok) return stream(gr.body, `Groq (${groqModel})`);
    if (gr?.status === 404) groqModelCache = null; // המודל ירד: בפעם הבאה בוחרים מחדש
    if (gr) {
      const t = await gr.text().catch(() => "");
      groqNote = `Groq: ${gr.status} ${t.slice(0, 200)}`;
    }
    console.log(groqNote);
  }

  // 2) Gemini: גיבוי, ושאלות עם תמונה
  const model = Netlify.env.get("GEMINI_MODEL") || "gemini-3.8-flash";
  const fallback = Netlify.env.get("GEMINI_FALLBACK_MODEL");
  const post = (fast, m = model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
        ...(fast ? { generationConfig: { thinkingConfig: { thinkingLevel: "low" } } } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => new Response(JSON.stringify({ error: { message: "Gemini לא ענה בזמן" } }), { status: 504 }));

  let r = await post(!explain);
  if (!explain && r.status === 400) r = await post(false); // המודל לא תומך בהגדרת החשיבה
  // המודל הראשי עמוס: עוברים מיד למודל הגיבוי (שגיאת עומס חוזרת מהר, אז זה לא מאט)
  if ((r.status === 503 || r.status === 429) && fallback) r = await post(false, fallback);

  if (!r.ok) {
    const g = await r.json().catch(() => ({}));
    const msg =
      r.status === 429 ? "הגעת למכסת השימוש (5 שאלות בדקה). חכה רגע ונסה שוב" :
      r.status === 503 ? "השרת של Gemini עמוס כרגע, נסה שוב בעוד כמה שניות" :
      g.error?.message || "שגיאה מה-AI";
    return json({ error: `${msg} (קוד ${r.status})${groqNote ? "\n" + groqNote : ""}` }, r.status === 503 ? 503 : 502);
  }
  return stream(r.body, "Gemini");
};

export const config = { path: "/api/ask" };
