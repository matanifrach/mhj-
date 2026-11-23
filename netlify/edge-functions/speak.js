// Edge Function: הקראה בעברית.
// action "nikud": Gemini מוסיף ניקוד מלא (כדי שההגייה תהיה נכונה).
// action "tts": Gemini TTS מקריא את הטקסט המנוקד ומחזיר PCM (24kHz, 16bit, mono) ב-base64.
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const NIKUD_PROMPT =
  "אתה מנקד מומחה לעברית. הוסף ניקוד מלא ומדויק לטקסט הבא, לפי ההקשר של המשפט " +
  "(למשל להבחין בין סֵפֶר לסַפָּר, בין אָהַב לאֹהֵב), כולל דגש, שווא ושין/שׂין. " +
  "אל תשנה אף מילה, אל תוסיף ואל תמחק דבר, שמור על פיסוק, מספרים ושורות. " +
  "החזר רק את הטקסט המנוקד, בלי הסברים.";

let ttsCache, textCache;
async function pick(key, kind) {
  if (kind === "tts" && ttsCache) return ttsCache;
  if (kind === "text" && textCache) return textCache;
  const r = await fetch(`${API}?pageSize=200`, {
    headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(4000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));
  const num = (a, b) => b.localeCompare(a, "en", { numeric: true });
  if (kind === "tts") {
    const t = names.filter((n) => /tts/i.test(n)).sort((a, b) => (/pro/.test(a) - /pro/.test(b)) || num(a, b));
    return (ttsCache = t[0] || null);
  }
  const t = names.filter((n) => /flash/i.test(n) && !/image|tts|audio|live|embed|lite|exp/i.test(n)).sort(num);
  return (textCache = t[0] || null);
}

const gemini = (key, model, body) =>
  fetch(`${API}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

const errText = async (r) => {
  const j = await r.json().catch(() => ({}));
  return j.error?.message || `שגיאה ${r.status}`;
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { password, action, text, voice, style } = await req.json().catch(() => ({}));
  const pass = Netlify.env.get("APP_PASSWORD");
  if (!pass || password !== pass) return json({ error: "סיסמה שגויה" }, 401);
  if (action === "check") return json({ ok: true });
  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  if (!key) return json({ error: "חסר GEMINI_API_KEY ב-Netlify" }, 500);
  const clean = String(text || "").trim().slice(0, 4000);
  if (!clean) return json({ error: "אין טקסט" }, 400);

  if (action === "nikud") {
    const model = Netlify.env.get("GEMINI_NIKUD_MODEL") || (await pick(key, "text")) || "gemini-2.5-flash";
    const r = await gemini(key, model, {
      systemInstruction: { parts: [{ text: NIKUD_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: clean }] }],
      generationConfig: { temperature: 0 },
    });
    if (!r.ok) return json({ error: `ניקוד נכשל: ${await errText(r)}` }, 502);
    const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return json({ text: out || clean, model });
  }

  if (action === "tts") {
    const model = Netlify.env.get("GEMINI_TTS_MODEL") || (await pick(key, "tts")) || "gemini-2.5-flash-preview-tts";
    const styles = {
      calm: "בקול רגוע, חם וברור",
      happy: "בקול שמח ומלא אנרגיה",
      story: "כמו מספר סיפורים, עם הבעה והפסקות טבעיות",
      news: "כמו קריין חדשות, ברור ומקצועי",
    };
    const prompt = `הקרא בעברית ${styles[style] || styles.calm}, בדיוק לפי הניקוד ובהטעמה נכונה:\n${clean}`;
    const r = await gemini(key, model, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
      },
    });
    if (!r.ok) return json({ error: `הקראה נכשלה: ${await errText(r)}` }, 502);
    const part = ((await r.json()).candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
    if (!part) return json({ error: "לא התקבל אודיו" }, 502);
    return json({ audio: part.inlineData.data, mime: part.inlineData.mimeType, model });
  }

  return json({ error: "פעולה לא מוכרת" }, 400);
};

export const config = { path: "/api/speak" };
