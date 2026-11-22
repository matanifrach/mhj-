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
    "אתה עוזר מחקר זהיר. קיבלת קטעים מוויקיפדיה. ענה רק לפי מה שכתוב בהם במפורש, וציין מאיזה ערך לקחת כל עובדה. " +
    "ענה בקצרה. אם המקורות סותרים, ישנים או לא עונים במפורש על השאלה, כתוב זאת ואל תנחש. " +
    "אם התשובה המדויקת לא מופיעה במקורות, כתוב זאת במשפט אחד, ואז סכם בקצרה מה כן כתוב בהם על הנושא (למשל איפה גדל או איפה גר בעבר, אם כתוב), עם ציון הערך. אל תמסור כתובת מגורים מדויקת של אנשים פרטיים." + RULES,
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

// חיפוש בוויקיפדיה (עברית, ואם אין תוצאות גם אנגלית). חינמי ובלי מפתח.
async function wikiContext(q) {
  const H = { "User-Agent": "MatanLomed/1.0 (study helper)" };
  // מילות שאלה נפוצות מפריעות לחיפוש בוויקיפדיה, אז מנסים גם גרסה מקוצרת
  const STOP = /^(מה|מי|מתי|איפה|היכן|למה|מדוע|איך|כיצד|כמה|האם|של|את|על|זה|זו|הוא|היא|הם|גר|גרה|גרים|כיום|היום|עכשיו|נמצא|נמצאת|עושה|קרה|ב|ל|ה|ו)$/;
  const short = q.replace(/[?!.,"']/g, " ").split(/\s+/).filter((w) => w && !STOP.test(w)).join(" ");
  const queries = [...new Set([q, short].filter(Boolean))];
  for (const lang of ["he", "en"]) {
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const get = (url) => fetch(url, { headers: H, signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null);
    const search = async (qq) => ((await get(`${api}?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(qq)}`))?.query?.search || []).map((x) => x.title);
    let titles = [];
    // 1) ערך ששמו מתחיל בדיוק בנושא (למשל "דה כהן (יוטיובר)")
    if (short) {
      const os = await get(`${api}?action=opensearch&format=json&limit=3&search=${encodeURIComponent(short)}`);
      titles = (os?.[1] || []).filter((t) => t.startsWith(short));
    }
    // 2) חיפוש של הצירוף המדויק, 3) חיפוש חופשי
    if (!titles.length && short) titles = await search(`"${short}"`);
    if (!titles.length) for (const qq of queries) { titles = await search(qq); if (titles.length) break; }
    if (!titles.length) continue;
    const pages = await Promise.all(titles.map((t) =>
      fetch(`${api}?action=query&prop=extracts|info&inprop=url&explaintext=1&format=json&redirects=1&titles=${encodeURIComponent(t)}`,
        { headers: H, signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => null)));
    const docs = pages.flatMap((p) => Object.values(p?.query?.pages || {}))
      .filter((p) => p.extract)
      .map((p) => ({ title: p.title, url: p.fullurl, text: p.extract.slice(0, 7000) }));
    if (docs.length) return docs;
  }
  return [];
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
  let docs = [];
  if (search) {
    docs = await wikiContext(question || "");
    if (!docs.length) return json({ error: "לא מצאתי ערכים מתאימים בוויקיפדיה. נסה לנסח את החיפוש אחרת." }, 404);
  }
  const userText = search
    ? docs.map((d, i) => `מקור ${i + 1}: ${d.title}\n${d.text}`).join("\n\n---\n\n") + `\n\nשאלה: ${question}`
    : question;

  if (gKey) {
    const parts = [];
    if (userText) parts.push({ text: userText });
    const m = image?.match(/^data:(.+?);base64,(.+)$/);
    if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });

    const gemini = (model, fast) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": gKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM[mode] }] },
          contents: [{ role: "user", parts }],
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
    const withSrc = (res) => { if (docs.length) res.headers.set("x-sources", encodeURIComponent(JSON.stringify(docs.map((d) => ({ title: d.title, uri: d.url }))))); return res; };
    if (r.ok) return withSrc(sse(r.body, `Gemini (${main})` + (search ? " + ויקיפדיה" : "")));
    const why = async (res) => ((await res.json().catch(() => ({}))).error?.message || "").slice(0, 160);
    notes.push(`Gemini ${main}: ${r.status || "אין חיבור"} ${await why(r)}`);

    // עומס או איטיות: מנסים מודל Gemini קל יותר
    if ([429, 500, 503, 504].includes(r.status)) {
      const lite = await pickLite(gKey, main);
      if (lite) {
        const r2 = await gemini(lite, false);
        if (r2.ok) return withSrc(sse(r2.body, `Gemini (${lite})` + (search ? " + ויקיפדיה" : "")));
        notes.push(`Gemini ${lite}: ${r2.status || "אין חיבור"} ${await why(r2)}`);
      }
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
