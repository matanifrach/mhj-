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
    });

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
    return json({ error: `${msg} (קוד ${r.status})` }, r.status === 503 ? 503 : 502);
  }
  return new Response(r.body, { headers: { "content-type": "text/event-stream" } });
};

export const config = { path: "/api/ask" };
