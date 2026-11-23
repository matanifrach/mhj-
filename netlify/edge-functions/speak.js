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

let listCache;
async function candidates(key, kind) {
  if (!listCache) {
    const r = await fetch(`${API}?pageSize=200`, {
      headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(4000),
    }).catch(() => null);
    listCache = r?.ok
      ? ((await r.json()).models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace("models/", ""))
      : [];
  }
  const num = (a, b) => b.localeCompare(a, "en", { numeric: true });
  const env = (n) => (Netlify.env.get(n) || "").trim();
  let list;
  if (kind === "tts") {
    list = [env("GEMINI_TTS_MODEL"),
      ...listCache.filter((n) => /tts/i.test(n)).sort((a, b) => (/pro/.test(a) - /pro/.test(b)) || num(a, b)),
      "gemini-2.5-flash-preview-tts"];
  } else {
    // מודלים "רגילים" קודם, omni/preview בסוף (לרוב בלי מכסה חינמית)
    const bad = (n) => /omni|preview|exp/i.test(n);
    list = [env("GEMINI_NIKUD_MODEL"), env("GEMINI_MODEL"),
      ...listCache.filter((n) => /flash/i.test(n) && !/image|tts|audio|live|embed/i.test(n))
        .sort((a, b) => (bad(a) - bad(b)) || (/lite/.test(a) - /lite/.test(b)) || num(a, b)),
      "gemini-2.5-flash"];
  }
  return [...new Set(list.filter(Boolean))].slice(0, 6);
}

// מנסה מודל אחרי מודל עד שאחד מצליח (למשל כשנגמרה המכסה החינמית של אחד מהם)
async function tryModels(key, kind, body) {
  let last = "אין מודל זמין";
  for (const model of await candidates(key, kind)) {
    const r = await gemini(key, model, body).catch(() => null);
    if (r?.ok) return { r, model };
    last = r ? `${model}: ${r.status === 429 ? "נגמרה המכסה החינמית" : await errText(r)}` : `${model}: אין חיבור`;
  }
  return { error: last };
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
  return (j.error?.message || `שגיאה ${r.status}`).split("\n")[0].slice(0, 160);
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
    const { r, model, error } = await tryModels(key, "text", {
      systemInstruction: { parts: [{ text: NIKUD_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: clean }] }],
      generationConfig: { temperature: 0 },
    });
    if (error) return json({ error: `ניקוד נכשל (${error})` }, 502);
    const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return json({ text: out || clean, model });
  }

  if (action === "tts") {
    const styles = {
      calm: "בקול רגוע, חם וברור",
      happy: "בקול שמח ומלא אנרגיה",
      story: "כמו מספר סיפורים, עם הבעה והפסקות טבעיות",
      news: "כמו קריין חדשות, ברור ומקצועי",
    };
    const prompt = `הקרא בעברית ${styles[style] || styles.calm}, בדיוק לפי הניקוד ובהטעמה נכונה:\n${clean}`;
    const { r, model, error } = await tryModels(key, "tts", {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Kore" } } },
      },
    });
    if (error) return json({ error: `הקראה נכשלה (${error})` }, 502);
    const part = ((await r.json()).candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
    if (!part) return json({ error: "לא התקבל אודיו" }, 502);
    return json({ audio: part.inlineData.data, mime: part.inlineData.mimeType, model });
  }

  return json({ error: "פעולה לא מוכרת" }, 400);
};

export const config = { path: "/api/speak" };
