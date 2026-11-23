// Edge Function: הקראה בעברית.
// action "nikud": Gemini מוסיף ניקוד מלא (כדי שההגייה תהיה נכונה).
// action "tts": Gemini TTS מקריא את הטקסט המנוקד ומחזיר PCM (24kHz, 16bit, mono) ב-base64.
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const NIKUD_PROMPT =
  "אתה מנקד מומחה לעברית מודרנית, ברמה של עורך לשון. קרא קודם את כל הטקסט והבן את המשמעות, מי הדובר ולמי הוא פונה " +
  "(זכר/נקבה, יחיד/רבים), ורק אז נקד כל מילה לפי ההקשר: למשל סֵפֶר/סַפָּר/סִפֵּר, אָהַב/אוֹהֵב, אַתְּ/אַתָּה, " +
  "שמות פרטיים ושמות מקומות כפי שהם נהגים בישראל, ומילים לועזיות כפי שאומרים אותן בעברית מדוברת. " +
  "נקד ניקוד מלא: דגש, שווא נע ונח, חטפים, שִׁין/שִׂין, ומפיק. " +
  "מספרים כתוב במילים מנוקדות, כפי שאומרים אותם בהקשר (כולל זכר/נקבה). " +
  "מלבד זה אל תשנה, אל תוסיף ואל תמחק אף מילה, ושמור על פיסוק ושורות. החזר רק את הטקסט המנוקד.";

let listCache;
const good = {};
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
      ...listCache.filter((n) => /tts/i.test(n)).sort((a, b) => (/pro/.test(b) - /pro/.test(a)) || num(a, b)),
      "gemini-2.5-pro-preview-tts", "gemini-2.5-flash-preview-tts"];
  } else if (kind === "smart") {
    // ניקוד חכם: מודלים חזקים (לא lite), עם חשיבה
    const bad = (n) => /omni|exp/i.test(n);
    list = [env("GEMINI_SMART_MODEL"),
      ...listCache.filter((n) => /flash|pro/i.test(n) && !/lite|image|tts|audio|live|embed/i.test(n))
        .sort((a, b) => (bad(a) - bad(b)) || (/flash/.test(b) - /flash/.test(a)) || (/preview/.test(a) - /preview/.test(b)) || num(a, b)),
      "gemini-2.5-flash", "gemini-2.5-pro"];
  } else {
    // מודלים "רגילים" קודם, omni/preview בסוף (לרוב בלי מכסה חינמית)
    const bad = (n) => /omni|preview|exp/i.test(n);
    list = [env("GEMINI_NIKUD_MODEL"), env("GEMINI_MODEL"),
      ...listCache.filter((n) => /flash/i.test(n) && !/image|tts|audio|live|embed/i.test(n))
        .sort((a, b) => (bad(a) - bad(b)) || (/lite/.test(b) - /lite/.test(a)) || num(a, b)),
      "gemini-2.5-flash"];
  }
  // המודל שהצליח בפעם הקודמת - ראשון בתור (חוסך ניסיונות כושלים)
  return [...new Set([good[kind], ...list].filter(Boolean))].slice(0, 6);
}

// ניקוד לא צריך "לחשוב" - כיבוי החשיבה מקצר מאוד את זמן התגובה
function thinkFor(model, body) {
  const { thinking, opt, ...gc } = body.generationConfig || {};
  if (opt && model) Object.assign(gc, opt);
  if (thinking && model) {
    gc.thinkingConfig = /2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : 0 } : { thinkingLevel: "minimal" };
  }
  return { ...body, generationConfig: gc };
}

// מנסה מודל אחרי מודל עד שאחד מצליח (למשל כשנגמרה המכסה החינמית של אחד מהם)
async function tryModels(key, kind, body) {
  let last = "אין מודל זמין";
  for (const model of await candidates(key, kind)) {
    let r = await gemini(key, model, thinkFor(model, body)).catch(() => null);
    // אם המודל לא מכיר את הגדרת החשיבה - מנסים שוב בלעדיה
    if (r?.status === 400 && (body.generationConfig?.thinking || body.generationConfig?.opt)) r = await gemini(key, model, thinkFor(null, body)).catch(() => null);
    if (r?.ok) { good[kind] = model; return { r, model }; }
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

// הסיסמה לא נשמרת בשום מקום כטקסט: ב-Netlify נשמר רק TTS_PASSWORD_HASH (PBKDF2-SHA256, 210,000 סבבים).
// את ה-hash מייצרים בדף עצמו: tts.html#hash
const SALT = "koli-tts-v1";
async function hash(pw) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(SALT), iterations: 210000 }, k, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function passOk(pw) {
  const want = (Netlify.env.get("TTS_PASSWORD_HASH") || "").trim().toLowerCase();
  if (!want || typeof pw !== "string" || !pw) return false;
  const got = await hash(pw);
  let d = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return d === 0;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { password, action, text, voice, smart } = await req.json().catch(() => ({}));
  if (!(await passOk(password))) return json({ error: "סיסמה שגויה" }, 401);
  if (action === "check") return json({ ok: true });
  const key = (Netlify.env.get("GEMINI_API_KEY") || "").trim();
  if (!key) return json({ error: "חסר GEMINI_API_KEY ב-Netlify" }, 500);
  const clean = String(text || "").trim().slice(0, 6000);
  if (!clean) return json({ error: "אין טקסט" }, 400);

  if (action === "nikud") {
    const { r, model, error } = await tryModels(key, smart ? "smart" : "text", {
      systemInstruction: { parts: [{ text: NIKUD_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: clean }] }],
      generationConfig: smart ? { temperature: 0, opt: { seed: 7 } } : { temperature: 0, thinking: true, opt: { seed: 7 } },
    });
    if (error) return json({ error: `ניקוד נכשל (${error})` }, 502);
    const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return json({ text: out || clean, model });
  }

  if (action === "tts") {
    const { r, model, error } = await tryModels(key, "tts", {
      contents: [{ parts: [{ text: clean }] }], // רק הטקסט עצמו, בלי הוראות שיוקראו בקול
      generationConfig: {
        responseModalities: ["AUDIO"],
        opt: { temperature: 0.3, seed: 7 }, // יציבות: אותו טקסט -> אותה הגייה
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
