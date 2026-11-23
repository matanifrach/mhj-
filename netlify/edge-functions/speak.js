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
    // ניקוד חכם: רק המודל הראשי שכבר עובד אצלך (כמו ב"מתן לומד"), עם קצת חשיבה
    list = [env("GEMINI_SMART_MODEL"), env("GEMINI_MODEL"), "gemini-3.8-flash",
      ...listCache.filter((n) => /flash|pro/i.test(n) && !/image|tts|audio|live|embed|omni|exp/i.test(n))
        .sort((a, b) => (/lite/.test(a) - /lite/.test(b)) || (/preview/.test(a) - /preview/.test(b)) || num(a, b))];
  } else {
    // מודלים "רגילים" קודם, omni/preview בסוף (לרוב בלי מכסה חינמית)
    const bad = (n) => /omni|preview|exp/i.test(n);
    list = [env("GEMINI_NIKUD_MODEL"), env("GEMINI_MODEL"),
      ...listCache.filter((n) => /flash/i.test(n) && !/image|tts|audio|live|embed/i.test(n))
        .sort((a, b) => (bad(a) - bad(b)) || (/lite/.test(b) - /lite/.test(a)) || num(a, b)),
      "gemini-3.8-flash"];
  }
  // המודל שהצליח בפעם הקודמת - ראשון בתור (חוסך ניסיונות כושלים)
  return [...new Set([good[kind], ...list].filter(Boolean))].slice(0, 6);
}

// ניקוד לא צריך "לחשוב" - כיבוי החשיבה מקצר מאוד את זמן התגובה
function thinkFor(model, body) {
  const { thinking, opt, ...gc } = body.generationConfig || {};
  if (opt && model) Object.assign(gc, opt);
  if (thinking && model) {
    const low = thinking === "low";
    gc.thinkingConfig = /2\.5/.test(model) ? { thinkingBudget: /pro/.test(model) ? 128 : low ? 512 : 0 } : { thinkingLevel: low ? "low" : "minimal" };
  }
  return { ...body, generationConfig: gc };
}

// מנסה מודל אחרי מודל עד שאחד מצליח (למשל כשנגמרה המכסה החינמית של אחד מהם)
async function tryModels(key, kind, body, stream = false) {
  const errs = [], deadline = Date.now() + 38000; // Netlify מנתק אחרי ~40 שנ'
  for (const model of (await candidates(key, kind)).slice(0, 4)) {
    const left = deadline - Date.now();
    if (left < 3000) { errs.push("נגמר הזמן"); break; }
    const call = (b) => gemini(key, model, b, stream ? 120000 : Math.min(left, 30000), stream).catch((e) => ({ ok: false, status: 0, timeout: e?.name === "TimeoutError" }));
    let r = await call(thinkFor(model, body));
    // אם המודל לא מכיר הגדרה (חשיבה/seed) - מנסים שוב בלעדיה
    if (r.status === 400 && (body.generationConfig?.thinking || body.generationConfig?.opt)) r = await call(thinkFor(null, body));
    // עומס זמני אצל גוגל (503/500) - ניסיון חוזר אחד אחרי שנייה
    if (r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1000)); r = await call(thinkFor(model, body)); }
    if (r.ok) { good[kind] = model; return { r, model }; }
    if (r.status >= 500) { errs.push(`${model}: עומס`); continue; }
    errs.push(`${model}: ${r.status === 429 ? "נגמרה המכסה" : r.status === 404 ? "לא זמין" : r.status ? (await errText(r)).slice(0, 70) : r.timeout ? "איטי מדי" : "אין חיבור"}`);
  }
  return { error: errs.join(" | ") || "אין מודל זמין" };
}

const gemini = (key, model, body, ms = 30000, stream = false) =>
  fetch(`${API}/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });

const errText = async (r) => {
  const j = await r.json().catch(() => ({}));
  return (j.error?.message || `שגיאה ${r.status}`).split("\n")[0].slice(0, 160);
};

// ---- ניקוד בלי Gemini ----
const sseOf = (text, model) => new Response(
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`,
  { headers: { "content-type": "text/event-stream", "x-model": model } });
const hasNikud = (t) => /[\u05B0-\u05BC\u05C1\u05C2]/.test(t);

// הנקדן של דיקטה - כלי ייעודי לניקוד עברית (מהיר). אם לא עונה תוך 7 שנ' - ממשיכים הלאה
async function dicta(text) {
  const url = (Netlify.env.get("DICTA_URL") || "https://nakdan-5-3.loadbalancer.dicta.org.il/api").trim();
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "nakdan", data: text, genre: "modern", addmorph: false, keepqq: false, keepmetagim: true }),
    signal: AbortSignal.timeout(7000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const j = await r.json().catch(() => null);
  const arr = Array.isArray(j) ? j : j?.data;
  if (!Array.isArray(arr)) return null;
  const out = arr.map((w) => {
    if (w.sep || !w.options?.length) return w.word ?? "";
    const o = w.options[0];
    return String(Array.isArray(o) ? o[0] : (o?.w ?? o)).replace(/\|/g, "");
  }).join("");
  return hasNikud(out) ? out : null;
}

// Groq (גיבוי אחרון, מהיר מאוד)
async function groq(text) {
  const key = (Netlify.env.get("GROQ_API_KEY") || "").trim();
  if (!key) return null;
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: Netlify.env.get("GROQ_MODEL") || "llama-3.3-70b-versatile", temperature: 0, seed: 7,
      messages: [{ role: "system", content: NIKUD_PROMPT }, { role: "user", content: text }] }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!r?.ok) return null;
  const out = ((await r.json()).choices?.[0]?.message?.content || "").trim();
  return hasNikud(out) ? out : null;
}

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
    if (Netlify.env.get("DICTA_OFF") !== "1") {
      const d = await dicta(clean);
      if (d) return sseOf(d, "dicta");
    }
    const { r, model, error } = await tryModels(key, smart ? "smart" : "text", {
      systemInstruction: { parts: [{ text: NIKUD_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: clean }] }],
      generationConfig: { temperature: 0, thinking: true, opt: { seed: 7 } },
    }, true);
    if (error) {
      const g = await groq(clean);
      if (g) return sseOf(g, "groq");
      return json({ error: `ניקוד נכשל (${error})` }, 502);
    }
    // מזרימים את הניקוד ישר לדפדפן - רואים אותו נכתב מיד, ואין ניתוק אחרי 40 שנ'
    return new Response(r.body, { headers: { "content-type": "text/event-stream", "x-model": model } });
  }

  if (action === "tts") {
    const { r, model, error } = await tryModels(key, "tts", {
      contents: [{ parts: [{ text: /[.!?…]$/.test(clean) ? clean : clean + "." }] }], // רק הטקסט עצמו, בלי הוראות שיוקראו בקול
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
