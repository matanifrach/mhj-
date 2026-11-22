// Edge Function: מזרים את התשובה מ-Gemini ישירות לדפדפן (Streaming).
// ככה המילים מתחילות להופיע מהר, ואין מגבלת 10 השניות של Functions רגילות.
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { password, question, image, explain, check } = await req.json().catch(() => ({}));
  const pass = Netlify.env.get("APP_PASSWORD");
  if (!pass || password !== pass) return json({ error: "סיסמה שגויה" }, 401);
  if (check) return json({ ok: true });

  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  if (!key) return json({ error: "חסר GEMINI_API_KEY ב-Netlify" }, 500);
  if (!question && !image) return json({ error: "אין שאלה" }, 400);

  const system = explain
    ? "אתה מורה פרטי סבלני. הסבר את הפתרון שלב אחרי שלב בעברית פשוטה וברורה, ובסוף כתוב את התשובה הסופית בשורה נפרדת שמתחילה ב'תשובה:'."
    : "ענה בעברית בקצרה ובדיוק. תן רק את התשובה הסופית, בלי הסברים, אלא אם השאלה דורשת כמה פרטים.";

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
  if (groqKey && !image) {
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: Netlify.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile",
        stream: true,
        messages: [{ role: "system", content: system }, { role: "user", content: question }],
      }),
      signal: AbortSignal.timeout(12000),
    }).catch((e) => { groqNote = "Groq: " + e.name; return null; });
    if (gr?.ok) return stream(gr.body, "Groq");
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
