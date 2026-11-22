// שולח שאלה ל-Gemini. המפתח נשמר רק בשרת (משתנה סביבה).
export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { password, question, image, explain, check } = await req.json().catch(() => ({}));
  if (!process.env.APP_PASSWORD || password !== process.env.APP_PASSWORD)
    return Response.json({ error: "סיסמה שגויה" }, { status: 401 });
  if (check) return Response.json({ ok: true });
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) return Response.json({ error: "חסר GEMINI_API_KEY ב-Netlify" }, { status: 500 });
  if (!question && !image) return Response.json({ error: "אין שאלה" }, { status: 400 });

  const system = explain
    ? "אתה מורה פרטי סבלני. הסבר את הפתרון שלב אחרי שלב בעברית פשוטה וברורה, ובסוף כתוב את התשובה הסופית בשורה נפרדת שמתחילה ב'תשובה:'."
    : "ענה בעברית בקצרה ובדיוק. תן רק את התשובה הסופית, בלי הסברים, אלא אם השאלה דורשת כמה פרטים.";

  const parts = [];
  if (question) parts.push({ text: question });
  if (image) {
    const [, mime, data] = image.match(/^data:(.+?);base64,(.+)$/) || [];
    if (data) parts.push({ inline_data: { mime_type: mime, data } });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts }],
      }),
    }
  );
  const j = await r.json();
  if (!r.ok) return Response.json({ error: j.error?.message || "שגיאה מה-AI" }, { status: 502 });
  const answer = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "לא התקבלה תשובה";
  return Response.json({ answer });
};
