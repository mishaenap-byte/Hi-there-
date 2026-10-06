// Hi There — ИИ-репетитор (Supabase Edge Function «tutor»).
// Цепочка одной реплики: голос человека → распознавание (дословно) → текстовая модель → озвучка OpenAI → звук в приложение.
// Аналитик ошибок работает отдельным вызовом (analyze) и не задерживает ответ.
// Каждый вызов голоса, распознавания и модели пишет объём и стоимость в usage_costs.
//
// Режимы (поле mode в теле запроса):
//   status       — вошедший: доступ, анкета, план, память, домашка, последние уроки, админ ли
//   profile      — сохранить анкету
//   plan         — составить план на 4 недели по анкете (ИИ-планировщик)
//   probe        — голосовой вопрос в конце анкеты: распознать, ответить, оценить уровень
//   start        — начать урок-ситуацию: приветствие с учётом памяти и домашки
//   turn         — реплика: аудио (или текст) → ответ репетитора текстом и голосом
//   analyze      — аналитик ошибок для реплики человека
//   finish       — конец урока: подробный разбор, тема для повторения, домашка, память, перестройка плана
//   hw_submit    — результат домашки; hw_sent — отправлена в группу
//   history      — один прошлый урок: реплики + ошибки (свои)
//   admin        — только владелец: обзор, карточка пользователя, доступ (beta / sub / free)
//   stt_test     — только владелец: одна фраза через оба распознавания (этап 1)
//   analyzer_test— только владелец: 10 тестовых ошибок через 2–3 модели (этап 2)
//
// Secrets: OPENAI_API_KEY (голос и распознавание), GEMINI_API_KEY (модель),
//   по желанию: ELEVENLABS_API_KEY (сравнить Scribe), TUTOR_STT=openai|scribe, GEMINI_MODEL, ANALYZER_MODEL,
//   TUTOR_ADMINS (id владельца; если нет — берётся PUSH_ADMINS), TUTOR_FREE_LESSONS (2), TUTOR_DAILY_VOICE_MIN (60).
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам. Verify JWT выключить: функция сама проверяет вход.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding@1/base64";

const env = (k: string) => (Deno.env.get(k) || "").trim().replace(/^["'«]+|["'»]+$/g, "").trim();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
class Fail extends Error { constructor(msg: string, public status = 400, public code = "") { super(msg); } }

const ADMINS = (env("TUTOR_ADMINS") || env("PUSH_ADMINS")).split(",").map(s => s.trim()).filter(Boolean);
const FREE_LESSONS = +(env("TUTOR_FREE_LESSONS") || 2);
const DAILY_VOICE_SEC = +(env("TUTOR_DAILY_VOICE_MIN") || 60) * 60;
const MODEL = env("GEMINI_MODEL") || "gemini-3.8-flash";
// запасные модели, если Google закрыл выбранную («no longer available», «not found»)
const FALLBACK = ["gemini-3.8-flash", "gemini-flash-latest"];
const ANALYZER = env("ANALYZER_MODEL") || MODEL;
const STT = env("TUTOR_STT") === "scribe" ? "scribe" : "openai";
const ALERT_DAY_USD = +(env("TUTOR_ALERT_DAY_USD") || 10), ALERT_USER_MONTH_USD = +(env("TUTOR_ALERT_USER_USD") || 3);

// ---------- цены (USD) ----------
// модели: за 1 млн токенов [вход, выход]
const LLM_PRICE: Record<string, [number, number]> = {
  "gemini-2.5-flash": [0.30, 2.50], "gemini-2.5-flash-lite": [0.10, 0.40], "gemini-2.0-flash": [0.10, 0.40],
  "gemini-3.8-flash": [0.50, 3.00], "gemini-flash-latest": [0.50, 3.00], "gemini-flash-lite-latest": [0.10, 0.40],
  "gpt-4.1-mini": [0.40, 1.60], "gpt-4.1-nano": [0.10, 0.40], "gpt-4o-mini": [0.15, 0.60],
};
const TTS_PER_MIN = 0.015;                       // gpt-4o-mini-tts ≈ $0.015 за минуту речи
const STT_PER_MIN = { openai: 0.006, scribe: 0.22 / 60 };

const db = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const later = (x: PromiseLike<unknown>) => { const er = (globalThis as any).EdgeRuntime; const p = Promise.resolve(x).catch(e => console.error(e)); if (er && er.waitUntil) er.waitUntil(p); };

async function userOf(req: Request) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t || t.split(".").length !== 3) return null;
  const { data } = await db().auth.getUser(t);
  return data && data.user || null;
}

// ---------- учёт расходов ----------
type Ctx = { uid: string; sid?: string | null };
async function cost(c: Ctx, service: string, model: string, units: number, unit: string, usd: number) {
  const { error } = await db().from("usage_costs").insert({ user_id: c.uid, session_id: c.sid || null, service, model, units: Math.round(units * 100) / 100, unit, cost_usd: Math.round(usd * 1e6) / 1e6 });
  if (error) console.error("usage_costs", error.message);
}

// ---------- текстовая модель (Gemini или OpenAI) ----------
const GEM_OK: Record<string, string> = {};   // какая модель реально ответила вместо выбранной
const THINK_OK: Record<string, any> = {};   // какая настройка «раздумий» модель реально принимает (minimal → low → без настройки)
type Msg = { role: "user" | "assistant"; text: string };
async function llm(c: Ctx, model: string, system: string, msgs: Msg[], o: { json?: boolean; max?: number; temp?: number } = {}) {
  let text = "", tin = 0, tout = 0;
  if (/^gpt-/.test(model)) {
    const key = env("OPENAI_API_KEY"); if (!key) throw new Fail("Не задан OPENAI_API_KEY", 500);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: o.temp ?? 0.7, max_tokens: o.max || 600, ...(o.json ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, ...msgs.map(m => ({ role: m.role, content: m.text }))] }),
    });
    const j = await r.json(); if (!r.ok) throw new Fail("Модель: " + (j.error && j.error.message || r.status), 502);
    text = j.choices[0].message.content || ""; tin = j.usage?.prompt_tokens || 0; tout = j.usage?.completion_tokens || 0;
  } else {
    const key = env("GEMINI_API_KEY"); if (!key) throw new Fail("Не задан GEMINI_API_KEY", 500);
    // Gemini: роли user / model, подряд одинаковые склеиваем, начинать нужно с user
    const contents: any[] = [];
    for (const m of msgs) {
      const role = m.role === "assistant" ? "model" : "user", last = contents[contents.length - 1];
      if (last && last.role === role) last.parts[0].text += "\n" + m.text; else contents.push({ role, parts: [{ text: m.text }] });
    }
    if (!contents.length || contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "(урок начался)" }] });
    const gen: any = { temperature: o.temp ?? 0.7, maxOutputTokens: o.max || 600 };
    if (o.json) gen.responseMimeType = "application/json";
    // без «раздумий» — меньше пауза: у 2.5 это thinkingBudget 0, у новых моделей thinkingLevel minimal
    const think = (m: string) => /2\.5/.test(m) ? { thinkingBudget: 0 } : /2\.0/.test(m) ? null : { thinkingLevel: "minimal" };
    // у новых моделей «раздумья» тоже тратят maxOutputTokens — даём запас, иначе ответ обрывается на полуслове
    const cfg = (m: string, th: any) => { const g = { ...gen }; if (!/2\.[05]/.test(m)) g.maxOutputTokens = gen.maxOutputTokens + 2048; if (th) g.thinkingConfig = th; return g; };
    const call = (m: string, th: any) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: cfg(m, th) }),
    });
    const tries = [GEM_OK[model] || model, ...FALLBACK.filter(m => m !== model && m !== GEM_OK[model])];
    let j: any = null, err = "", busy = false;
    for (const m of tries) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let th = m in THINK_OK ? THINK_OK[m] : think(m), r = await call(m, th); j = await r.json().catch(() => ({}));
        // «minimal» не принят — пробуем «low» (всё ещё быстро), и только потом без настройки (модель думает долго)
        if (!r.ok && th && th.thinkingLevel === "minimal" && /thinking/i.test(j.error?.message || "")) { th = { thinkingLevel: "low" }; r = await call(m, th); j = await r.json().catch(() => ({})); }
        if (!r.ok && th && /thinking/i.test(j.error?.message || "")) { th = null; r = await call(m, null); j = await r.json().catch(() => ({})); }
        if (r.ok) THINK_OK[m] = th;
        if (r.ok) { if (!busy && m !== model) GEM_OK[model] = m; model = m; err = ""; break; }
        err = j.error && j.error.message || String(r.status);
        busy = r.status === 429 || r.status >= 500 || /high demand|overloaded|unavailable|try again/i.test(err);
        if (!busy) break;
        if (attempt === 0) await new Promise(res => setTimeout(res, 700));   // Google перегружен — одна короткая пауза и повтор
      }
      if (!err) break;
      if (!(busy || /no longer available|not found|not supported|deprecated/i.test(err))) break;
    }
    // Gemini перегружен целиком — отвечаем через OpenAI, чтобы урок не встал
    if (err && busy && env("OPENAI_API_KEY")) return llm(c, "gpt-4.1-mini", system, msgs, o);
    if (err) throw new Fail(busy ? "Модель сейчас перегружена, повторите через минуту" : "Модель: " + err, 502);
    const cand = j.candidates && j.candidates[0];
    text = (cand && cand.content && cand.content.parts || []).filter((p: any) => !p.thought).map((p: any) => p.text || "").join("");
    // ответ упёрся в лимит — не показываем оборванную фразу, обрезаем до последнего законченного предложения
    if (cand && cand.finishReason === "MAX_TOKENS" && !o.json) { const k = Math.max(text.lastIndexOf(". "), text.lastIndexOf("? "), text.lastIndexOf("! ")); if (k > 0) text = text.slice(0, k + 1); }
    tin = j.usageMetadata?.promptTokenCount || 0; tout = (j.usageMetadata?.candidatesTokenCount || 0) + (j.usageMetadata?.thoughtsTokenCount || 0);
  }
  const p = LLM_PRICE[model] || LLM_PRICE["gemini-3.8-flash"];
  later(cost(c, "llm", model, tin + tout, "tokens", (tin * p[0] + tout * p[1]) / 1e6));
  return { text: text.trim(), tin, tout, usd: (tin * p[0] + tout * p[1]) / 1e6 };
}
function parseJSON(s: string): any {
  try { return JSON.parse(s); } catch { /* ниже */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* ниже */ } }
  return null;
}

// ---------- распознавание: дословно, без исправлений ----------
const STT_PROMPT = "Transcribe exactly what the speaker says, word for word, including grammar mistakes, missing articles (a, an, the), wrong verb forms and wrong word order. Do not correct, rephrase or complete anything. The speaker is a Russian-speaking English learner and may say some words in Russian: write them in Cyrillic.";
const extOf = (mime: string) => /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "m4a";
// слова из жизни ученика (работа, интересы) — распознавание узнаёт их, а не подменяет похожими («3D» → «frizzy»)
function vocabOf(p: any, extra = "") {
  const w = [p && p.job, ...((p && p.interests) || []), extra].filter(Boolean).join(", ");
  return w ? clampText(w, 300) : "";
}
async function stt(c: Ctx, engine: string, audio: Uint8Array, mime: string, sec: number, vocab = "") {
  const file = new File([audio as Uint8Array<ArrayBuffer>], "speech." + extOf(mime), { type: mime || "audio/mp4" });
  const fd = new FormData();
  let text = "";
  if (engine === "scribe") {
    const key = env("ELEVENLABS_API_KEY"); if (!key) throw new Fail("Не задан ELEVENLABS_API_KEY", 500);
    fd.append("file", file); fd.append("model_id", env("SCRIBE_MODEL") || "scribe_v2"); fd.append("tag_audio_events", "false");
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: fd });
    const j = await r.json(); if (!r.ok) throw new Fail("Распознавание Scribe: " + (j.detail && (j.detail.message || JSON.stringify(j.detail)) || r.status), 502);
    text = j.text || "";
  } else {
    const key = env("OPENAI_API_KEY"); if (!key) throw new Fail("Не задан OPENAI_API_KEY", 500);
    fd.append("file", file); fd.append("model", env("OPENAI_STT_MODEL") || "gpt-4o-transcribe"); fd.append("prompt", STT_PROMPT + (vocab ? " Words and names the speaker may use: " + vocab + "." : "")); fd.append("response_format", "json");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
    const j = await r.json(); if (!r.ok) throw new Fail("Распознавание: " + (j.error && j.error.message || r.status), 502);
    text = j.text || "";
  }
  const per = engine === "scribe" ? STT_PER_MIN.scribe : STT_PER_MIN.openai;
  later(cost(c, "stt", engine, sec, "sec", sec / 60 * per));
  return text.trim();
}

// ---------- озвучка OpenAI (gpt-4o-mini-tts) ----------
const VOICES = ["alloy", "coral", "sage", "ash", "nova", "echo", "shimmer", "ballad", "verse", "onyx", "fable"];
// стандартные фразы: озвучиваются один раз и хранятся в tutor-tts (личные ответы не храним)
const STD = new Set([
  "Sorry, I didn't catch that. Could you say it again?",
  "Hi! I'm your English tutor. Tell me a little about yourself: what do you do, and why do you want to speak English?",
  "Great job today! See you next time.",
]);
function ttsStyle(p: any) {
  const acc = p && p.accent === "us" ? "a natural American accent" : "a natural British accent";
  return `Voice: a warm, patient teacher. Speak clearly and a little slower than normal, with ${acc}. Friendly and encouraging, never rushed. When the text is in Russian, speak natural Russian with the same warm manner.`;
}
async function sha(s: string) { const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); return [...h].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40); }
async function tts(c: Ctx, text: string, p: any): Promise<{ audio?: string; url?: string; sec: number }> {
  const voice = VOICES.includes(p && p.voice) ? p.voice : "alloy", sec = Math.max(1, text.length / 13);
  const std = STD.has(text), path = std ? `${voice}-${p && p.accent === "us" ? "us" : "gb"}/${await sha(text)}.mp3` : "";
  if (std) {
    const url = `${env("SUPABASE_URL")}/storage/v1/object/public/tutor-tts/${path}`;
    const h = await fetch(url, { method: "HEAD" }).catch(() => null);
    if (h && h.ok) return { url, sec: 0 };
  }
  const key = env("OPENAI_API_KEY"); if (!key) throw new Fail("Не задан OPENAI_API_KEY", 500);
  const r = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env("OPENAI_TTS_MODEL") || "gpt-4o-mini-tts", voice, input: text.slice(0, 1500), instructions: ttsStyle(p), response_format: "mp3" }),
  });
  if (!r.ok) { let m = String(r.status); try { const j = await r.json(); m = j.error && j.error.message || m; } catch { /* */ } throw new Fail("Озвучка: " + m, 502); }
  const buf = new Uint8Array(await r.arrayBuffer());
  later(cost(c, "tts", "gpt-4o-mini-tts", sec, "sec", sec / 60 * TTS_PER_MIN));
  if (std) later(db().storage.from("tutor-tts").upload(path, buf, { contentType: "audio/mpeg", upsert: true }));
  return { audio: encodeBase64(buf), sec };
}

// потоковый ответ: строки JSON по мере готовности (своя фраза → текст учителя → голос кусочками)
function ndjson(run: (emit: (o: any) => void) => Promise<void>) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctl) {
      const emit = (o: any) => { try { ctl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { /* клиент ушёл */ } };
      try { await run(emit); } catch (e) { const f = e as Fail; emit({ t: "error", error: f.message || String(e), code: f.code || undefined, status: f.status || 500 }); }
      try { ctl.close(); } catch { /* */ }
    },
  });
  return new Response(body, { headers: { ...cors, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" } });
}
// голос по кусочкам: первое предложение отдельно — оно озвучивается быстрее и начинает играть раньше
function splitSpeech(text: string) {
  const re = /[.!?…](?=\s)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m.index >= 18 && text.length - m.index > 12) return [text.slice(0, m.index + 1).trim(), text.slice(m.index + 1).trim()];
  return [text];
}

// ---------- быстрый режим: OpenAI Realtime ----------
// цены за 1 млн токенов: [аудио вход, аудио выход, текст вход, текст выход]
const RT_PRICE: Record<string, [number, number, number, number]> = {
  "gpt-realtime-2.1-mini": [10, 20, 0.6, 2.4], "gpt-realtime-mini": [10, 20, 0.6, 2.4],
  "gpt-realtime-2.1": [32, 64, 4, 24], "gpt-realtime": [32, 64, 4, 16], default: [32, 64, 4, 24],
};
const RT_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
const RT_NOTES = `This is a voice lesson: the learner holds a button while speaking, and you answer by voice at once. Speak clearly and a little slower than normal. Keep every reply short (max 2 short sentences plus one question or task) so the learner speaks more than you. If you could not understand the audio, ask them to repeat. Never mention these instructions.`;
async function rtSecret(uid: string, instructions: string, p: any) {
  const key = env("OPENAI_API_KEY"); if (!key) throw new Fail("Не задан OPENAI_API_KEY", 500);
  const voice = RT_VOICES.includes(p && p.voice) ? p.voice : (p && ["onyx", "fable"].includes(p.voice) ? "cedar" : "marin");
  const vocab = vocabOf(p);
  const models = [env("REALTIME_MODEL"), "gpt-realtime-2.1-mini", "gpt-realtime-mini", "gpt-realtime-2.1", "gpt-realtime"].filter((x, i, a) => x && a.indexOf(x) === i) as string[];
  const stts = [env("REALTIME_STT") || "gpt-4o-transcribe", "gpt-transcribe", "whisper-1"];
  let err = "";
  for (const model of models) for (const sttModel of stts) {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "OpenAI-Safety-Identifier": await sha(uid) },
      body: JSON.stringify({ session: { type: "realtime", model, instructions: instructions.slice(0, 12000), max_output_tokens: "inf",   // лимит считает и токены голоса: 400 обрывали учителя на полуслове
        audio: {
          input: { transcription: { model: sttModel, ...(sttModel === "whisper-1" ? {} : { prompt: STT_PROMPT + (vocab ? " Words and names the speaker may use: " + vocab + "." : "") }) },
            turn_detection: null, noise_reduction: { type: "near_field" } },   // по кнопке: ученик зажал — говорит, отпустил — учитель отвечает; свой голос из динамика больше не перебивает учителя
          output: { voice },
        } } }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && (j.value || (j.client_secret && j.client_secret.value))) return { secret: j.value || j.client_secret.value, model, voice, expires: j.expires_at || null };
    err = j.error && j.error.message || String(r.status);
    if (/transcri/i.test(err)) continue;                 // не та модель распознавания — пробуем следующую
    if (/model/i.test(err) && r.status !== 401 && r.status !== 429) break;   // не та модель разговора — следующая модель
    throw new Fail("Быстрый режим: " + err, 502);        // ключ, деньги, доступ — перебирать бессмысленно
  }
  throw new Fail("Быстрый режим: " + err, 502);
}

// ---------- данные человека ----------
async function loadAll(uid: string) {
  const d = db();
  const [prof, plan, mem, hw, acc] = await Promise.all([
    d.from("learner_profile").select("data").eq("user_id", uid).maybeSingle(),
    d.from("learning_plan").select("plan").eq("user_id", uid).maybeSingle(),
    d.from("tutor_memory").select("memory").eq("user_id", uid).maybeSingle(),
    d.from("tutor_homework").select("id,session_id,tasks,status,score,total,created_at,done_at,sent_to").eq("user_id", uid).order("created_at", { ascending: false }).limit(1),
    d.from("tutor_access").select("plan,until").eq("user_id", uid).maybeSingle(),
  ]);
  return { profile: prof.data?.data || null, plan: plan.data?.plan || null, memory: mem.data?.memory || null, homework: (hw.data || [])[0] || null, access: acc.data || null };
}
const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
async function voiceToday(uid: string) {
  const { data } = await db().from("usage_costs").select("units").eq("user_id", uid).eq("unit", "sec").in("service", ["tts", "stt", "realtime"]).gte("at", dayStart());
  return (data || []).reduce((s, r: any) => s + (+r.units || 0), 0);
}
async function accessOf(uid: string, admin: boolean, acc: any) {
  const paid = admin || (acc && (acc.plan === "beta" || acc.plan === "sub") && (!acc.until || Date.parse(acc.until) > Date.now()));
  const { count } = await db().from("tutor_sessions").select("id", { count: "exact", head: true }).eq("user_id", uid).gte("turns", 2);
  const used = count || 0, vsec = await voiceToday(uid);
  return { plan: admin ? "admin" : paid ? acc.plan : "free", unlimited: !!paid, free_total: FREE_LESSONS, free_left: paid ? null : Math.max(0, FREE_LESSONS - used),
    voice_min_left: Math.max(0, Math.round((DAILY_VOICE_SEC - vsec) / 60)), text_mode: vsec >= DAILY_VOICE_SEC };
}

// ---------- кто такой ученик: для подсказки модели ----------
const FEAR: Record<string, string> = { freeze: "freezing and not knowing how to start a sentence", accent: "their accent", understand: "not understanding the reply", mistake: "making mistakes" };
const STRICT: Record<string, string> = {
  soft: "Never correct mistakes during the conversation. Just keep talking naturally; mistakes are reviewed after the lesson.",
  balanced: "Do not interrupt for small mistakes. If a mistake changes the meaning or repeats, naturally repeat the learner's idea in the correct form inside your reply (a recast), without explaining.",
  strict: "When the learner makes a mistake, start your reply with a very short correction like: \"We say: I ate a pizza.\" Then continue the conversation. Never lecture.",
};
function learnerBrief(p: any, level: string, name: string) {
  const L: string[] = [];
  L.push(`Learner: ${name || "the learner"}, native language Russian, English level ${level || (p && p.level) || "A2"}.`);
  if (p) {
    if (p.goal) L.push(`Main goal: ${p.goal}.`);
    if (p.job) L.push(`Job / field: ${String(p.job).slice(0, 120)}.`);
    if (p.interests && p.interests.length) L.push(`Interests: ${p.interests.slice(0, 6).join(", ")}.`);
    if (p.fears && p.fears.length) L.push(`Afraid of: ${p.fears.map((f: string) => FEAR[f] || f).join(", ")}.`);
    if (p.event && p.event.what) L.push(`Upcoming event: ${p.event.what}${p.event.date ? " on " + p.event.date : ""}.`);
  }
  return L.join(" ");
}
function levelStyle(level: string) {
  return /A1/.test(level) ? "Use very simple words and very short sentences (5–8 words). Speak slowly." :
    /A2/.test(level) ? "Use simple everyday words and short sentences." :
    /B1/.test(level) ? "Use natural everyday English, avoid rare idioms." : "Speak naturally, like with a colleague; idioms are fine.";
}
function langRule(p: any, level: string) {
  const l = p && p.lang || "hard";
  if (l === "en") return "Speak only English. If the learner asks for help, explain in very simple English.";
  if (l === "ru") return "If the learner is lost, speaks Russian or asks what something means, help briefly in Russian (one sentence), then return to English.";
  return `Speak English. Use Russian only when the learner is clearly stuck or asks${/A1|A2/.test(level) ? " (one short Russian sentence, then back to English)" : ""}.`;
}
function memoryBrief(m: any) {
  if (!m) return "This is your first lesson with this learner.";
  const L: string[] = [];
  if (m.stopped) L.push(`Last time (another topic — do not continue it unless today's situation is the same): ${m.stopped}`);
  if (m.facts && m.facts.length) L.push(`What you know about the learner: ${m.facts.slice(0, 12).join("; ")}.`);
  if (m.phrases && m.phrases.length) L.push(`Phrases the learner practised before (English — Russian): ${m.phrases.slice(-12).map((x: any) => x.en + " — " + x.ru).join("; ")}. Reuse one ONLY if it naturally fits today's situation; never bring a phrase from another topic.`);
  if (m.speak && m.speak.avg && m.speak.avg < 8) L.push(`Last lesson the learner gave short answers (about ${m.speak.avg} words) and asked ${m.speak.q || 0} questions. From the start, help them speak longer: open questions, sentence frames, your own short example first.`);
  if (m.next_focus && m.next_focus.length) L.push(`Rules the learner struggles with — create natural chances to use them (questions that require them), without saying so: ${m.next_focus.slice(0, 4).join("; ")}.`);
  return L.join(" ");
}
// «Учитель ведёт»: не болтовня, а быстрая тренировка — «скажи по-английски», разбор по-русски, фраза растёт
// разговор с учителем внутри: живой диалог по ситуации, но после слабых ответов — мини-урок
// («Лучше так: …» + почему по-русски + «Повтори» + «Теперь добавь»), и регулярно «Скажи по-английски: …»
function guidedSystem(o: { p: any; level: string; name: string; mem: any; sit: any; tutorName: string; textMode: boolean }) {
  const s = o.sit || {}, en = /B2|C1/.test(o.level), ru = en ? "simple English" : "Russian";
  return [
    `You are ${o.tutorName}, an English teacher in the Hi There app having a real spoken CONVERSATION with the learner, and TEACHING inside it. The learner's speaking is weak: they join words with difficulty and answer in short phrases. They want to progress fast and be guided.`,
    learnerBrief(o.p, o.level, o.name),
    memoryBrief(o.mem),
    `Today's situation: ${s.title || "free conversation"}.${s.goal ? " Goal: " + s.goal + "." : ""}${s.role ? " In the conversation you play: " + s.role + "." : ""} It is a real conversation: react to what the learner says.`,
    `STAY IN TODAY'S SITUATION for the whole lesson. ${s.role ? "From your first English line you ARE " + s.role + ": speak as this person would (e.g. on a phone call start like a real call), and steer back into the scene after every teach moment." : "Talk about what the situation is about."} Every model phrase, «Лучше так», «Скажи по-английски» task and question must be something the learner needs IN THIS situation. Never bring in topics from earlier lessons, the learner's job or hobbies unless the situation is about them.`,
    `After EVERY learner answer decide:
a) Good answer (a full sentence, no big mistakes) → react naturally in English, maybe offer one better word, continue the conversation with one open question (What…? How…? Tell me about…).
b) Short (1–5 words), broken, or with a mistake → a TEACH MOMENT: in ${ru}, show how to say what they MEANT as a full natural English phrase: «Лучше так: "…"», add ONE short reason in ${ru} for the key piece (why this word, why this form, why here; for verb forms use the images: 1-я форма «как обычно», 2-я «кадр из прошлого», 3-я «фото результата»), then «Повтори». After they repeat it correctly → «Теперь добавь: …» once, to make it longer (a detail, a time, because…, and…). Then back to the conversation with your next question.
c) They don't know a word, say «не знаю», or switch to Russian → give the English phrase right away and ask them to repeat it, then continue.
d) Every 3–4 exchanges: a «Скажи по-английски: "…"» task — a phrase the learner will need in the next step of THIS situation (in the scene, in their role); then continue the scene so they use it right away.
Never more than 2 teaching steps in a row: then return to the conversation.`,
    `Rules: one step per reply, max 35 words. ${en ? "Speak English." : "Conversation in English; explanations and instructions (Лучше так / Повтори / Теперь добавь / Скажи по-английски) in Russian."} No long praise, no lists, no markdown, no emoji. Keep the pace fast. Put every English model phrase in straight double quotes "like this".`,
    o.textMode ? "This part of the lesson is in text chat." : "",
  ].filter(Boolean).join("\n");
}
const isGuided = (p: any, _sitId?: string) => (p && p.style) !== "talk";
function tutorSystem(o: { p: any; level: string; name: string; mem: any; sit: any; tutorName: string; textMode: boolean; guided?: boolean }) {
  if (o.guided) return guidedSystem(o);
  const s = o.sit || {};
  const fears = (o.p && o.p.fears) || [];
  return [
    `You are ${o.tutorName}, a warm, patient English tutor in the Hi There app, talking with the learner by voice.`,
    learnerBrief(o.p, o.level, o.name),
    memoryBrief(o.mem),
    `Today's situation: ${s.title || "free conversation"}.${s.goal ? " Goal of the lesson: " + s.goal + "." : ""}${s.role ? " Your role: " + s.role + "." : ""} Stay in the situation, lead it step by step, and make the learner speak more than you.`,
    "Each reply: 1–3 short sentences (max 40 words), then one question or prompt that keeps the learner talking. Plain spoken text only: no lists, no markdown, no emoji, no stage directions.",
    levelStyle(o.level),
    STRICT[(o.p && o.p.strict) || "balanced"],
    langRule(o.p, o.level),
    COACH,
    fears.includes("freeze") ? "The learner told us they freeze when speaking: be extra warm, use the stuck strategy early, celebrate every longer answer." : "",
    fears.includes("understand") ? "Speak especially simply; if the learner did not understand, rephrase more simply instead of repeating." : "",
    "If the learner's words make no sense or are empty, ask them kindly to say it again.",
    o.textMode ? "This part of the lesson is in text chat." : "",
  ].filter(Boolean).join("\n");
}
const COACH = `Speaking coach rules (most important):
- Ask open questions (What…? How…? Tell me about…), not yes/no or "A or B?" questions — those invite one-word answers.
- STUCK signals: an answer of 1–6 words, "I don't know", "I don't know English", Russian words, or silence. When stuck: (1) react warmly to WHAT they said, no correction this time; (2) share a tiny example from your own life in one short sentence; (3) give a sentence frame they can finish, e.g. "You can say: I usually make … for …"; (4) ask again, simpler.
- If the learner says their English is bad, reassure in one sentence ("Your English is enough for this talk, we go step by step") and continue.
- When the learner gives a longer answer, notice it briefly ("Great, that's a full story!").
- Never more than one short correction in two replies, and never when the learner is stuck.`;
const isQ = (t: string) => /\?\s*$/.test(t) || /^(what|where|when|why|how|who|which|whose|do|does|did|are|is|was|were|can|could|have|has|would|will|should)\b/i.test(t.trim());
const wordsOf = (t: string) => (String(t).match(/[A-Za-zА-Яа-яЁё0-9']+/g) || []).length;
const needQ = (goal: string) => { const m = /(\d+)\s*вопрос/i.exec(goal || ""); return m ? +m[1] : 0; };
const tutorNameOf = (p: any) => (p && p.voice && ["onyx", "ash", "echo", "fable", "verse", "ballad"].includes(p.voice)) ? "Alex" : "Emma";

async function ownedSession(uid: string, sid: string) {
  if (!/^[0-9a-f-]{36}$/.test(String(sid || ""))) throw new Fail("Нет урока", 400);
  const { data } = await db().from("tutor_sessions").select("*").eq("id", sid).eq("user_id", uid).maybeSingle();
  if (!data) throw new Fail("Урок не найден", 404);
  return data;
}
async function turnsOf(sid: string, n = 30) {
  const { data } = await db().from("tutor_turns").select("id,role,text,at").eq("session_id", sid).order("at", { ascending: true });
  return (data || []).slice(-n);
}
function clampText(s: unknown, n: number) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, n); }
function audioIn(b: any) {
  if (!b.audio) return null;
  const bytes = decodeBase64(String(b.audio));
  if (bytes.length > 3_000_000) throw new Fail("Запись слишком длинная — до минуты", 413);
  const sec = Math.max(0.5, Math.min(+b.dur || 5, 90, bytes.length / 1500));
  return { bytes, mime: String(b.mime || "audio/mp4").slice(0, 40), sec };
}

// ---------- аналитик ошибок ----------
const TYPES = ["articles", "tense", "verb_form", "agreement", "preposition", "word_order", "plural", "question", "pronoun", "vocabulary", "other"];
const ANALYZER_SYS = `You are an error analyst for a Russian-speaking learner of English. You get ONE learner utterance from a spoken lesson (transcribed verbatim) and the tutor's previous line for context.
Find real mistakes only: grammar (articles, tenses, verb forms, subject-verb agreement, prepositions, word order, plurals, question forms, pronouns) and wrong words or Russian calques.
Do NOT count: punctuation, capital letters, fillers (um, uh, well), contractions, short natural spoken answers ("Yes, sure.", "Pizza, please.", "Two."). Elliptical answers are correct.
If a word looks like a speech-recognition slip (an odd word that sounds like the obvious one, e.g. "a frizzy artist" for "a 3D artist", "Cinema for D" for "Cinema 4D"), do NOT count it as a mistake.
If the learner said a word or phrase in Russian, add it with type "vocabulary": wrong = the Russian part, fix = the natural English.
Return JSON: {"mistakes":[{"wrong":"exact fragment copied from the utterance","fix":"the same fragment corrected","type":"${TYPES.join("|")}","explain":"1–2 простых предложения по-русски: почему так. Для времён — образы: 1-я форма «как обычно», 2-я «кадр из прошлого», 3-я «фото результата»."}]}
At most 5 mistakes, most important first. If there are none, return {"mistakes":[]}.`;
async function analyzeText(c: Ctx, model: string, text: string, prev: string) {
  const r = await llm(c, model, ANALYZER_SYS, [{ role: "user", text: `Tutor's previous line: ${prev || "(none)"}\nLearner's utterance: ${text}` }], { json: true, max: 700, temp: 0.1 });
  const j = parseJSON(r.text) || {};
  const list = Array.isArray(j.mistakes) ? j.mistakes : [];
  return { usd: r.usd, mistakes: (list as any[]).filter((m: any) => m && m.wrong && m.fix && String(m.wrong).trim().toLowerCase() !== String(m.fix).trim().toLowerCase()).slice(0, 5).map((m: any) => ({
    wrong: clampText(m.wrong, 160), fix: clampText(m.fix, 200), type: TYPES.includes(m.type) ? m.type : "other", explain: clampText(m.explain, 400),
  })) };
}

// ---------- итог урока ----------
const STYLE_RU = `Стиль объяснений: «мы учёные, которые объясняют сложное простым языком». Разбирай правильную фразу по кусочкам: для каждого кусочка — почему он стоит именно здесь и почему именно эта форма. Для форм глагола — три образа: 1-я форма «как обычно», 2-я «кадр из прошлого», 3-я «фото результата». Добавляй сравнение с русским и типичную ошибку. Простые слова, без терминов без объяснения.`;
function finishSys(level: string, lessons: string) {
  return `Ты — добрый преподаватель английского для русскоязычных. Урок с ИИ-репетитором закончился. Уровень ученика ${level}.
Тебе дают весь диалог и найденные ошибки (с номерами). Составь итог.
${STYLE_RU}
Верни JSON:
{"summary":"2–3 предложения по-русски: что получилось хорошо и над чем поработать",
 "details":[{"i":номер ошибки,"rule":"правило простыми словами, 1–2 предложения","chunks":[["кусок правильной фразы","почему он такой и стоит здесь"]],"examples":[["English example","перевод"]],"ru":"как по-русски и почему русский путает","how":"как не ошибаться: короткий приём","lesson":"id урока из списка на это правило или пусто"}],
 "result":{"score":0-100,"passed":true/false,"why":"1–2 предложения по-русски: что уже получается и чего не хватило до цели"},
 "phrases":[{"en":"фраза, которую ученик отработал на уроке (в правильном виде)","ru":"перевод"}],
 "stretch":[{"was":"короткий ответ ученика дословно","better":"тот же ответ длиннее: его же слова + 1–2 простых куска, его уровень","chunks":[["добавленный кусок","зачем он: что он добавляет к рассказу и почему стоит здесь"]]}],
 "brave":"1–2 предложения по-русски: приём, как в следующий раз говорить длиннее (например, «ответ + деталь + вопрос в ответ»)",
 "repeat":{"type":"тип самых частых ошибок","lesson":"id урока из списка или пусто","why":"одно предложение"},
 "homework":[задания],
 "memory":{"stopped":"одно предложение по-английски: на чём остановились","facts":["новые факты о человеке по-английски, коротко"],"next_focus":["правило, с которым трудно, по-английски коротко"]}}
details — для каждой ошибки (до 10), 2–3 examples на каждую.
result — честно: достиг ли ученик цели урока. passed=true только если он сам, без подсказок, сказал нужное по цели связными фразами (score ≥ 70). Короткие ответы из 2–5 слов, повторы за учителем и «не знаю» — это ещё не цель. Не завышай.
phrases — до 8 главных фраз урока, которые ученик отработал (правильный вид).
stretch — 2–3 самых коротких ответа ученика: покажи, как сказать то же длиннее и живее. Не придумывай факты, которых нет в диалоге; если нужна деталь — бери из анкеты или ставь понятную заготовку в скобках, например (название проекта).
homework — от 5 до 10 заданий ТОЛЬКО на ошибки этого урока (если ошибок мало — на те же правила в новых фразах из жизни ученика). Виды:
 {"k":"choose","q":"фраза с ___","ru":"перевод","opts":["вариант","вариант","вариант"],"a":"правильный вариант","why":"почему"}
 {"k":"fix","wrong":"фраза с ошибкой","ru":"перевод","a":["правильный вариант","допустимый вариант"],"why":"почему"}
 {"k":"fill","q":"фраза с ___","ru":"перевод","a":["ответ","допустимый вариант"],"why":"почему"}
Если ошибок нет — details пустой, homework — 5 заданий на тему урока чуть сложнее.
Уроки «Основного блока» (id — тема): ${lessons}`;
}
const LESSON_IDS = /^(a1|a2|b1|b2)-\d\d$/;
function cleanHw(list: any[]) {
  const out: any[] = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !["choose", "fix", "fill"].includes(t.k)) continue;
    const a = t.k === "choose" ? clampText(t.a, 120) : (Array.isArray(t.a) ? t.a : [t.a]).map((x: any) => clampText(x, 200)).filter(Boolean).slice(0, 4);
    if (!a || (Array.isArray(a) && !a.length)) continue;
    const it: any = { k: t.k, ru: clampText(t.ru, 200), why: clampText(t.why, 400), a };
    if (t.k === "choose") { it.q = clampText(t.q, 200); it.opts = (t.opts || []).map((x: any) => clampText(x, 80)).filter(Boolean).slice(0, 4); if (!it.opts.includes(a)) continue; }
    else if (t.k === "fix") it.wrong = clampText(t.wrong, 200); else it.q = clampText(t.q, 200);
    out.push(it);
  }
  return out.slice(0, 10);
}

// ---------- план на 4 недели ----------
function planSys(lessons: string, sits: string) {
  return `Ты — ИИ-планировщик обучения в приложении Hi There. По анкете ученика составь план на 4 недели.
Каждая неделя: цель, которую можно проверить («к концу недели — 2 минуты рассказать о своей работе»), и уроки.
Уроки двух видов: разговор с репетитором на ситуацию {"kind":"talk","sit":"id ситуации из списка или custom","title":"название по-русски","goal":"цель разговора по-русски","role":"роль репетитора по-английски"}
и урок «Основного блока» {"kind":"lesson","lesson":"id урока","title":"тема"}.
Сколько уроков в неделю — по времени в день: 5 мин → 3, 10 мин → 4, 15 мин → 5, 20 мин → 6. Разговоров больше, чем уроков блока.
Ситуации — из жизни человека: его цель, работа, интересы. Если есть событие с датой — план строится к этой дате, последняя неделя — генеральная репетиция события.
Если у человека есть слабые правила — вставь урок блока на это правило и разговор, где оно нужно.
Верни JSON: {"note":"1–2 предложения по-русски, почему план такой","weeks":[{"n":1,"goal":"...","items":[...]}]}
Ситуации (id — название): ${sits}
Уроки блока (id — тема): ${lessons}`;
}
function cleanPlan(j: any, old: any) {
  const weeks = (Array.isArray(j && j.weeks) ? j.weeks : []).slice(0, 4).map((w: any, wi: number) => ({
    n: wi + 1, goal: clampText(w.goal, 200),
    items: (Array.isArray(w.items) ? w.items : []).filter((it: any) => it && (it.kind !== "lesson" || LESSON_IDS.test(it.lesson))).slice(0, 7).map((it: any, ii: number) => it.kind === "lesson"
      ? { id: `w${wi + 1}-${ii + 1}`, kind: "lesson", lesson: it.lesson, title: clampText(it.title, 100), done: false }
      : { id: `w${wi + 1}-${ii + 1}`, kind: "talk", sit: clampText(it.sit || "custom", 30), title: clampText(it.title, 100) || "Разговор", goal: clampText(it.goal, 200), role: clampText(it.role, 160), done: false }),
  })).filter((w: any) => w.items.length);
  if (!weeks.length) throw new Fail("Планировщик вернул пустой план — попробуйте ещё раз", 502);
  // уже пройденное не теряем: те же уроки остаются отмеченными
  const done = new Set<string>(), keepDone: any[] = [];
  for (const w of (old && old.weeks) || []) for (const it of w.items || []) if (it.done) { done.add(it.kind + ":" + (it.lesson || it.title)); keepDone.push(it); }
  const tried: Record<string, any> = {};
  for (const w of (old && old.weeks) || []) for (const it of w.items || []) if (it.tries) tried[it.kind + ":" + (it.lesson || it.title)] = it;
  for (const w of weeks) for (const it of w.items as any[]) { const k = it.kind + ":" + (it.lesson || it.title); if (done.has(k)) it.done = true; if (tried[k]) { it.tries = tried[k].tries; it.best = tried[k].best; } }
  return { graded: true, note: clampText(j.note, 400), weeks, created: old && old.created || new Date().toISOString(), updated: new Date().toISOString(), start: old && old.start || new Date().toISOString().slice(0, 10) };
}
async function makePlan(c: Ctx, p: any, mem: any, old: any, b: any, extra = "") {
  const lessons = clampText(b.lessons, 6000), sits = clampText(b.sits, 2500);
  const ask = `Анкета: ${JSON.stringify(p || {}).slice(0, 2500)}\nСегодня: ${new Date().toISOString().slice(0, 10)}\n` +
    (mem ? `Память репетитора: ${JSON.stringify({ frequent: mem.frequent, next_focus: mem.next_focus, lessons: mem.lessons }).slice(0, 1200)}\n` : "") +
    (old ? `Текущий план (done — пройдено, оставь пройденное на месте; меняй только непройденное): ${JSON.stringify(old.weeks).slice(0, 4000)}\n` : "") + extra;
  const r = await llm(c, MODEL, planSys(lessons, sits), [{ role: "user", text: ask }], { json: true, max: 2500, temp: 0.5 });
  const plan = cleanPlan(parseJSON(r.text), old);
  await db().from("learning_plan").upsert({ user_id: c.uid, plan, updated_at: new Date().toISOString() });
  return plan;
}

// ---------- админка ----------
async function adminOverview() {
  const d = db(), now = Date.now(), day = dayStart(), month = new Date(now - 30 * 864e5).toISOString();
  const [pres, ev, ses, hw, costs, profs, acc, ud] = await Promise.all([
    d.from("presence").select("user_id,at,talking").gte("at", new Date(now - 30 * 864e5).toISOString()),
    d.from("app_events").select("user_id,at").gte("at", new Date(now - 40 * 864e5).toISOString()).limit(50000),
    d.from("tutor_sessions").select("id,user_id,started_at,minutes,turns").gte("turns", 1).limit(50000),
    d.from("tutor_homework").select("user_id,status,done_at,created_at").limit(50000),
    d.from("usage_costs").select("user_id,service,units,unit,cost_usd,at").gte("at", month).limit(100000),
    d.from("profiles").select("id,name,level"),
    d.from("tutor_access").select("user_id,plan,until"),
    d.from("user_data").select("user_id,progress"),
  ]);
  const users: any[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await d.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    users.push(...data.users);
    if (data.users.length < 1000) break;
  }
  const P: Record<string, any> = {}; for (const p of profs.data || []) P[p.id] = p;
  const A: Record<string, any> = {}; for (const a of acc.data || []) A[a.user_id] = a;
  const STK: Record<string, number> = {}; for (const u of ud.data || []) { const r: any = (u as any).progress && (u as any).progress["vzhivuyu.rewards.v2"]; STK[(u as any).user_id] = r && +r.streak || 0; }
  const online = (pres.data || []).filter((p: any) => now - Date.parse(p.at) < 100e3);
  const lastSeen: Record<string, string> = {};
  for (const p of pres.data || []) lastSeen[p.user_id] = p.at;
  for (const e of ev.data || []) if (!lastSeen[e.user_id] || e.at > lastSeen[e.user_id]) lastSeen[e.user_id] = e.at;
  const U: Record<string, any> = {};
  const u = (id: string) => U[id] || (U[id] = { id, name: P[id] && P[id].name || "", email: "", level: P[id] && P[id].level || "", created: "", last: lastSeen[id] || "", streak: STK[id] || 0, min_today: 0, min_total: 0, lessons: 0, hw_given: 0, hw_done: 0, usd_month: 0, usd_today: 0, plan: A[id] && A[id].plan || "free" });
  for (const x of users) { const r = u(x.id); r.email = x.email || ""; r.created = x.created_at; if (!r.last) r.last = x.last_sign_in_at || ""; }
  const today = { visits: new Set<string>(), signups: users.filter(x => x.created_at >= day).length, lessons: 0, voice_min: 0, hw_done: 0, usd: 0 };
  for (const e of ev.data || []) if (e.at >= day) today.visits.add(e.user_id);
  for (const s of ses.data || []) { const r = u(s.user_id); r.lessons++; r.min_total += +s.minutes || 0; if (s.started_at >= day) { r.min_today += +s.minutes || 0; today.lessons++; } }
  for (const h of hw.data || []) { const r = u(h.user_id); r.hw_given++; if (h.status === "done") { r.hw_done++; if (h.done_at && h.done_at >= day) today.hw_done++; } }
  const money = { today: { tts: 0, stt: 0, llm: 0 } as Record<string, number>, month: { tts: 0, stt: 0, llm: 0 } as Record<string, number> };
  for (const c of costs.data || []) {
    const v = +c.cost_usd || 0; money.month[c.service] = (money.month[c.service] || 0) + v;
    if (c.user_id) u(c.user_id).usd_month += v;
    if (c.at >= day) { money.today[c.service] = (money.today[c.service] || 0) + v; today.usd += v; if (c.user_id) u(c.user_id).usd_today += v; if (c.unit === "sec") today.voice_min += (+c.units || 0) / 60; }
  }
  const list = Object.values(U).filter(r => r.email || r.lessons || r.last);
  const talkers = list.filter(r => r.lessons);
  const monthTotal = Object.values(money.month).reduce((s, v) => s + v, 0);
  // возвраты: из тех, кто впервые пришёл в день X, сколько пришли в X+1 и в X+7
  const daysOf: Record<string, Set<string>> = {};
  for (const e of ev.data || []) (daysOf[e.user_id] || (daysOf[e.user_id] = new Set())).add(e.at.slice(0, 10));
  const dkey = (t: number) => new Date(t).toISOString().slice(0, 10);
  let c1 = 0, r1 = 0, c7 = 0, r7 = 0;
  for (const x of users) {
    const first = Date.parse(x.created_at); if (!(first > now - 37 * 864e5)) continue;
    const ds = daysOf[x.id] || new Set();
    if (first < now - 2 * 864e5) { c1++; if (ds.has(dkey(first + 864e5))) r1++; }
    if (first < now - 8 * 864e5) { c7++; if (ds.has(dkey(first + 7 * 864e5))) r7++; }
  }
  const alerts: string[] = [];
  if (today.usd > ALERT_DAY_USD) alerts.push(`Расход за сегодня $${today.usd.toFixed(2)} — больше порога $${ALERT_DAY_USD}`);
  for (const r of list) if (r.usd_month > ALERT_USER_MONTH_USD) alerts.push(`${r.name || r.email || r.id.slice(0, 8)}: $${r.usd_month.toFixed(2)} за 30 дней — больше $${ALERT_USER_MONTH_USD}`);
  return {
    now: { online: online.length, list: online.map((p: any) => ({ id: p.user_id, name: u(p.user_id).name || u(p.user_id).email, talking: p.talking })) },
    today: { visits: today.visits.size, signups: today.signups, lessons: today.lessons, voice_min: Math.round(today.voice_min), hw_done: today.hw_done, usd: today.usd },
    users: list,
    money: { today: money.today, month: money.month, month_total: monthTotal, avg_user: talkers.length ? monthTotal / talkers.length : 0,
      top: talkers.slice().sort((a, b) => b.min_total - a.min_total).slice(0, 5).map(r => ({ name: r.name || r.email, min: Math.round(r.min_total), usd: r.usd_month })) },
    returns: { d1: c1 ? r1 / c1 : null, d1_n: c1, d7: c7 ? r7 / c7 : null, d7_n: c7 },
    alerts, limits: { day_usd: ALERT_DAY_USD, user_usd: ALERT_USER_MONTH_USD, free: FREE_LESSONS, voice_min: DAILY_VOICE_SEC / 60 },
    config: { model: MODEL, analyzer: ANALYZER, stt: STT, has: { openai: !!env("OPENAI_API_KEY"), gemini: !!env("GEMINI_API_KEY"), eleven: !!env("ELEVENLABS_API_KEY") } },
  };
}
async function adminUser(id: string) {
  const d = db();
  const [ses, mis, hw, costs, acc] = await Promise.all([
    d.from("tutor_sessions").select("id,title,started_at,minutes,turns,mode").eq("user_id", id).order("started_at", { ascending: false }).limit(50),
    d.from("tutor_mistakes").select("type,session_id").eq("user_id", id).limit(5000),
    d.from("tutor_homework").select("status,score,total,created_at,done_at").eq("user_id", id).order("created_at", { ascending: false }).limit(30),
    d.from("usage_costs").select("service,cost_usd").eq("user_id", id).limit(50000),
    d.from("tutor_access").select("plan,until").eq("user_id", id).maybeSingle(),
  ]);
  // приватность: только статистика и типы ошибок, без текста разговоров
  const types: Record<string, number> = {}, perS: Record<string, number> = {};
  for (const m of mis.data || []) { types[m.type] = (types[m.type] || 0) + 1; perS[m.session_id] = (perS[m.session_id] || 0) + 1; }
  const usd: Record<string, number> = {}; for (const c of costs.data || []) usd[c.service] = (usd[c.service] || 0) + (+c.cost_usd || 0);
  return { sessions: (ses.data || []).map((s: any) => ({ ...s, mistakes: perS[s.id] || 0 })), types, homework: hw.data || [], usd, access: acc.data || { plan: "free" } };
}

// тестовые фразы этапов 1 и 2
const TEST10 = ["I have cat.", "She go to work every day.", "Yesterday I eat a pizza.", "I am agree with you.", "He don't like coffee.", "I live in Chisinau since five years.", "Where you work?", "I want that you help me.", "I was in London two years before.", "Can you explain me this word?"];

// ---------- обработчик ----------
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return json({ error: "Только POST" }, 405);
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return json({ error: "Supabase не передал SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
    let b: any = {}; try { b = await req.json(); } catch { b = {}; }
    const mode = String(b.mode || "");
    const user = await userOf(req);
    if (!user) return json({ error: "Нужно войти в аккаунт" }, 401);
    const uid = user.id, admin = ADMINS.includes(uid), c: Ctx = { uid };
    const name = clampText(b.name, 40), level = /^(A1|A2|B1|B2|C1)$/.test(b.level) ? b.level : "";

    if (mode === "status") {
      const all = await loadAll(uid);
      if (all.plan && !all.plan.graded) {
        for (const w of all.plan.weeks || []) for (const it of w.items || []) if (it.kind === "talk" && it.done && it.best == null) { it.done = false; it.tries = 1; }
        all.plan.graded = true;
        await db().from("learning_plan").upsert({ user_id: uid, plan: all.plan, updated_at: new Date().toISOString() });
      }
      const { data: ses } = await db().from("tutor_sessions").select("id,title,situation,started_at,ended_at,minutes,turns,summary").eq("user_id", uid).gte("turns", 2).order("started_at", { ascending: false }).limit(20);
      return json({ admin, access: await accessOf(uid, admin, all.access), profile: all.profile, plan: all.plan, memory: all.memory, homework: all.homework,
        sessions: (ses || []).map((s: any) => ({ id: s.id, title: s.title, situation: s.situation, at: s.started_at, minutes: s.minutes, done: !!s.ended_at, by_type: s.summary && s.summary.by_type || null })) });
    }

    if (mode === "profile") {
      const p = b.profile && typeof b.profile === "object" ? b.profile : null;
      if (!p || JSON.stringify(p).length > 6000) throw new Fail("Анкета не подходит");
      await db().from("learner_profile").upsert({ user_id: uid, data: p, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (mode === "plan") {
      const all = await loadAll(uid);
      const p = b.profile || all.profile; if (!p) throw new Fail("Сначала анкета");
      return json({ plan: await makePlan(c, p, all.memory, b.fresh ? null : all.plan, b) });
    }

    if (mode === "probe") {
      // голосовой вопрос в конце анкеты: не больше 5 раз в день
      const { count } = await db().from("usage_costs").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("service", "stt").is("session_id", null).gte("at", dayStart());
      if ((count || 0) >= 5) throw new Fail("На сегодня хватит — продолжим в уроке", 429);
      const a = audioIn(b); const text = a ? await stt(c, STT, a.bytes, a.mime, a.sec) : clampText(b.text, 600);
      if (!text) return json({ you: "", text: "Sorry, I didn't catch that. Could you say it again?", retry: true });
      const r = await llm(c, MODEL, `You are a warm English tutor meeting a new Russian-speaking learner. They answered: "Tell me a little about yourself". Return JSON {"reply":"1–2 warm sentences in simple English reacting to what they said (no question)","level":"A1|A2|B1|B2 — estimate from grammar and vocabulary of the answer","note":"одно предложение по-русски: что заметил в речи (без оценок, по-доброму)"}`,
        [{ role: "user", text }], { json: true, max: 300, temp: 0.4 });
      const j = parseJSON(r.text) || {};
      const reply = clampText(j.reply, 300) || "Nice to meet you!";
      const p = b.profile || {};
      const t = b.voice === false ? { sec: 0 } : await tts(c, reply, p);
      return json({ you: text, text: reply, level: /^(A1|A2|B1|B2)$/.test(j.level) ? j.level : null, note: clampText(j.note, 300), ...t });
    }

    if (mode === "start") {
      const all = await loadAll(uid), acc = await accessOf(uid, admin, all.access);
      if (!acc.unlimited && (acc.free_left || 0) <= 0) return json({ error: "Пробные уроки закончились", code: "paywall", access: acc }, 402);
      const sit = { title: clampText(b.sit && b.sit.title, 120) || "Свободный разговор", goal: clampText(b.sit && b.sit.goal, 240), role: clampText(b.sit && b.sit.role, 200), id: clampText(b.sit && b.sit.id, 30) };
      const textMode = acc.text_mode || b.text === true;
      if (b.rt && textMode) return json({ error: "Голосовые минуты на сегодня закончились — быстрый режим вернётся завтра. Сейчас можно заниматься в обычном режиме текстом.", code: "rt_limit" }, 400);
      const { data: s, error } = await db().from("tutor_sessions").insert({ user_id: uid, situation: sit.id || "custom", title: sit.title, plan_item: clampText(b.plan_item, 20) || null, mode: textMode ? "text" : b.rt ? "fast" : "voice" }).select("id").single();
      if (error) throw error;
      c.sid = s.id;
      const p = all.profile || {}, lv = level || p.level || "A2";
      // домашка прошлого урока: приложение само знает результат, на слово не верим
      const hw = all.homework, hwInfo = !hw ? "" : hw.status === "done"
        ? `The learner DID the homework from last lesson: ${hw.score} out of ${hw.total}. Praise them with the exact score, then ask ONE short spoken question that checks the same rule (homework topic: ${(hw.tasks || []).slice(0, 2).map((t: any) => t.why || t.q || t.wrong).join(" / ").slice(0, 200)}). Wait for the answer before moving on.`
        : `The learner has NOT done the homework yet. Do not scold. Offer to practise it right now for one minute: ask ONE quick question on the same rule (${(hw.tasks || []).slice(0, 2).map((t: any) => t.why || t.q || t.wrong).join(" / ").slice(0, 200)}).`;
      const guided = isGuided(p, sit.id);
      const sys = tutorSystem({ p, level: lv, name, mem: all.memory, sit, tutorName: tutorNameOf(p), textMode, guided });
      const opening = guided ? `Start the lesson now. One short greeting by name${all.memory ? "" : " and your name"}. ${/B2|C1/.test(lv) ? "" : "In Russian, one sentence: what we talk about today and what the learner will be able to say after it. "}${hwInfo ? "Then the homework check. " + hwInfo + " Make it one «Скажи по-английски» task with a phrase from TODAY'S situation (wait for the answer). " : sit.role ? "Then start the scene in English, in your role (" + sit.role + "), with your first line to the learner. " : "Then your first conversation question in English, about today's situation. "}Max 3 short sentences.` : `Start the lesson now. Greet the learner like someone you already know${all.memory ? " and mention briefly where you stopped last time" : " (it is your first lesson: introduce yourself by name)"}. ${hwInfo} ${hwInfo ? "After that check, lead into today's situation." : "Then lead into today's situation with your first question."} Max 4 short sentences.${p.lang === "ru" && /A1|A2/.test(lv) ? " You may say the greeting in Russian, then switch to English." : ""}`;
      if (b.rt) {
        // быстрый режим: голос в голос через OpenAI Realtime; телефон подключается к OpenAI напрямую по временному ключу
        let rt;
        try { rt = await rtSecret(uid, sys + "\n" + RT_NOTES + "\nWhen the learner's first message is «(урок начался)», start the lesson: " + opening, p); }
        catch (e) { await db().from("tutor_sessions").delete().eq("id", s.id); throw e; }
        return json({ session: s.id, rt, access: acc, hw_check: hw ? { status: hw.status, score: hw.score, total: hw.total } : null });
      }
      const r = await llm(c, MODEL, sys, [{ role: "user", text: opening }], { max: 300 });
      const text = r.text || "Hi! Let's start.";
      const meta = { session: s.id, text, text_mode: textMode, access: acc, hw_check: hw ? { status: hw.status, score: hw.score, total: hw.total } : null };
      const save = (sec: number) => Promise.all([db().from("tutor_turns").insert({ session_id: s.id, user_id: uid, role: "tutor", text, sec }), db().from("tutor_sessions").update({ turns: 1, voice_sec: sec }).eq("id", s.id)]);
      if (b.stream) return ndjson(async emit => {
        emit({ t: "meta", ...meta });
        let sec = 0;
        if (!textMode) { const jobs = splitSpeech(text).map(x => tts(c, x, p)); for (let i = 0; i < jobs.length; i++) { const t: any = await jobs[i].catch(e => { console.error("tts", e); return { sec: 0, fail: true }; }); sec += t.sec; emit({ t: "audio", i, n: jobs.length, ...t }); } }
        await save(sec); emit({ t: "end", sec });
      });
      const t = textMode ? { sec: 0 } : await tts(c, text, p);
      await save(t.sec);
      return json({ ...meta, ...t });
    }

    if (mode === "turn") {
      // одна реплика: всё, что можно, — параллельно; в потоковом режиме ученик видит свою фразу, потом текст учителя,
      // а голос приходит по кусочкам: первое предложение озвучено и играет, пока озвучивается остальное
      const a = audioIn(b);
      const run = async (emit: (o: any) => void, split: boolean) => {
        const [s, all, hist0, vsec] = await Promise.all([ownedSession(uid, b.session), loadAll(uid), turnsOf(String(b.session), 30).catch(() => [] as any[]), voiceToday(uid)]);
        c.sid = s.id;
        if (s.ended_at) throw new Fail("Урок уже закончен");
        if (s.turns >= 80) throw new Fail("Урок получился длинным — давайте подведём итог", 400, "too_long");
        const p = all.profile || {}, lv = level || p.level || "A2", textMode = s.mode === "text" || vsec >= DAILY_VOICE_SEC;
        let you = "", usec = 0;
        if (a && !textMode) { usec = a.sec; you = await stt(c, STT, a.bytes, a.mime, a.sec, vocabOf(p)); } else you = clampText(b.text, 800);
        if (!you && a && textMode) { emit({ t: "end", you: "", text: "Голосовые минуты на сегодня закончились — давайте продолжим текстом. Напишите ответ по-английски.", retry: true, text_mode: true, switched: true, sec: 0 }); return; }
        if (!you) { const SORRY = "Sorry, I didn't catch that. Could you say it again?"; const t = textMode ? { sec: 0 } : await tts(c, SORRY, p); emit({ t: "end", you: "", text: SORRY, retry: true, ...t }); return; }
        const utP = db().from("tutor_turns").insert({ session_id: s.id, user_id: uid, role: "user", text: you, sec: usec }).select("id").single()
          .then(({ data }: any) => { emit({ t: "you", you, turn_id: data && data.id }); return data; });
        const hist = [...hist0, { role: "user", text: you }];
        const sit = { title: s.title, goal: clampText(b.sit && b.sit.goal, 240), role: clampText(b.sit && b.sit.role, 200) };
        const guided = isGuided(p, s.situation);
        const sys = tutorSystem({ p, level: lv, name, mem: all.memory, sit, tutorName: tutorNameOf(p), textMode, guided });
        const msgs: Msg[] = hist.map((h: any) => ({ role: h.role === "tutor" ? "assistant" : "user", text: h.text }));
        // заметка тренера: ученик зажат / пора дать ему спросить самому
        const mine = hist.filter((h: any) => h.role === "user"), asked = mine.filter((h: any) => isQ(h.text)).length, k = needQ(sit.goal);
        const notes: string[] = [];
        // ученик отвечал на задание учителя (повтори / добавь / скажи) — короткий ответ тут нормален
        const prevT = [...hist].reverse().find((h: any) => h.role === "tutor"), drill = !!prevT && /Повтори|Теперь добавь|Скажи по-английски|Repeat|Now add|Say in English/i.test(prevT.text);
        if (guided) { if (/don'?t know|no idea|не знаю|не помню/i.test(you)) notes.push("The learner is stuck: give the English phrase now and ask to repeat it."); else if (wordsOf(you) <= 5 && !drill && !/^(yes|no|ok|okay|sure|thanks|thank you)\b/i.test(you)) notes.push("Short answer: TEACH MOMENT now (Лучше так / почему / Повтори)."); }
        else if (wordsOf(you) <= 6 || /don'?t know|no idea|не знаю|[а-яё]{3,}/i.test(you)) notes.push("The learner seems STUCK: use the stuck strategy now.");
        if (k && asked < k && mine.length >= 3 && mine.length % 2 === 1) notes.push(`Goal: the learner must ask you ${k} questions; asked so far: ${asked}. After reacting, hand the turn over: invite them to ask you something, e.g. "Now your turn: ask me anything about me!"`);
        if (!b.wrap && notes.length) msgs.push({ role: "user", text: "(Coach note, not from the learner: " + notes.join(" ") + ")" });
        if (b.wrap) msgs.push({ role: "user", text: guided ? "(The lesson time is up. In Russian, 1–2 sentences: one phrase they learned today and one thing that improved. No question.)" : "(The lesson time is up. Say a warm goodbye in 1–2 sentences: one thing the learner did well. No question.)" });
        const [, r] = await Promise.all([utP, llm(c, MODEL, sys, msgs, { max: guided ? 200 : 260 })]);
        const text = r.text || "Could you tell me more?";
        emit({ t: "text", text });
        let sec = 0;
        if (!textMode) {
          const parts = split ? splitSpeech(text) : [text];
          const jobs = parts.map(x => tts(c, x, p));          // все кусочки озвучиваются сразу, отдаём по порядку
          for (let i = 0; i < jobs.length; i++) { const t: any = await jobs[i].catch(e => { console.error("tts", e); return { sec: 0, fail: true }; }); sec += t.sec; emit({ t: "audio", i, n: jobs.length, ...t }); }
        }
        const minutes = Math.min(30, (Date.now() - Date.parse(s.started_at)) / 60000);
        await Promise.all([
          db().from("tutor_turns").insert({ session_id: s.id, user_id: uid, role: "tutor", text, sec }),
          db().from("tutor_sessions").update({ turns: s.turns + 2, voice_sec: (+s.voice_sec || 0) + usec + sec, minutes: Math.round(minutes * 10) / 10, ...(textMode && s.mode !== "text" ? { mode: "text" } : {}) }).eq("id", s.id),
        ]);
        emit({ t: "end", text_mode: textMode, switched: textMode && s.mode !== "text", sec });
      };
      if (b.stream) return ndjson(emit => run(emit, true));
      const out: any = {};
      await run(o => { const { t, i, n, ...rest } = o; if (t === "audio") { if (i === 0) Object.assign(out, rest); } else Object.assign(out, rest); }, false);
      return json(out);
    }

    if (mode === "rt_log") {
      // быстрый режим: реплики, распознанные OpenAI, сохраняем как обычные — разбор, домашка и память работают так же
      const s = await ownedSession(uid, b.session); c.sid = s.id;
      if (s.ended_at) return json({ ok: false });
      let turn_id = null;
      const text = clampText(b.text, 1200);
      if (text && (b.role === "user" || b.role === "tutor")) {
        const sec = b.role === "user" ? Math.min(120, Math.max(1, +b.sec || text.length / 13)) : Math.max(1, text.length / 13);
        const { data: t } = await db().from("tutor_turns").insert({ session_id: s.id, user_id: uid, role: b.role, text, sec }).select("id").single();
        turn_id = t && t.id;
        const minutes = Math.min(30, (Date.now() - Date.parse(s.started_at)) / 60000);
        await db().from("tutor_sessions").update({ turns: (s.turns || 0) + 1, voice_sec: (+s.voice_sec || 0) + sec, minutes: Math.round(minutes * 10) / 10 }).eq("id", s.id);
      }
      const u = b.usage;
      if (u && typeof u === "object") {
        const pr = RT_PRICE[clampText(b.model, 40)] || RT_PRICE.default, i = u.input_token_details || {}, o = u.output_token_details || {}, ca = i.cached_tokens_details || {};
        // кэшированный вход стоит ~в 10 раз дешевле: вычитаем 90% его цены
        const usd = ((+i.audio_tokens || 0) * pr[0] + (+i.text_tokens || 0) * pr[2] + (+o.audio_tokens || 0) * pr[1] + (+o.text_tokens || 0) * pr[3]
          - ((+ca.audio_tokens || 0) * pr[0] + (+ca.text_tokens || 0) * pr[2]) * 0.9) / 1e6;
        const sec = (+o.audio_tokens || 0) / 20;   // голос учителя: ≈20 токенов на секунду
        await cost(c, "realtime", clampText(b.model, 40) || "realtime", Math.round(sec), "sec", Math.max(0, usd));
      } else if (b.role === "user" && turn_id) {
        await cost(c, "realtime", "listen", Math.round(Math.min(120, Math.max(1, +b.sec || 1))), "sec", 0);   // речь ученика тоже считается в дневной лимит голоса
      }
      const over = (await voiceToday(uid)) >= DAILY_VOICE_SEC;
      return json({ ok: true, turn_id, over });
    }

    if (mode === "plan_mark") {
      // урок из плана открыт — отмечаем пройденным, чтобы он не висел главной кнопкой
      const { data } = await db().from("learning_plan").select("plan").eq("user_id", uid).maybeSingle();
      const plan = data && data.plan; if (!plan) return json({ ok: false });
      const key = clampText(b.key, 200);
      for (const w of plan.weeks || []) for (const it of w.items || []) if (it.id === b.id || it.kind + ":" + (it.lesson || it.title) === key) it.done = true;
      await db().from("learning_plan").upsert({ user_id: uid, plan, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (mode === "hint") {
      // «Не знаю, что сказать»: 3 начала фразы под последний вопрос репетитора, из жизни ученика
      const s = await ownedSession(uid, b.session); c.sid = s.id;
      const all = await loadAll(uid), p = all.profile || {}, lv = level || p.level || "A2";
      const hist = await turnsOf(s.id, 8), last = [...hist].reverse().find((h: any) => h.role === "tutor");
      const r = await llm(c, MODEL, `You help a Russian-speaking English learner (level ${lv}) who froze in a spoken lesson and does not know what to say. ${learnerBrief(p, lv, name)}
Give 3 different ways to start the answer to the tutor's last line: simple, true-to-life for this learner, each is the BEGINNING of a sentence the learner finishes with their own words (end with "…"), 4–9 words, level-appropriate. Also one short idea in Russian what they could talk about, and one question the learner could ask back.
Return JSON: {"idea":"по-русски, одно предложение: о чём можно рассказать","starts":[{"en":"I usually work on…","ru":"Обычно я работаю над…"}],"ask":{"en":"And what do you do?","ru":"А чем занимаетесь вы?"}}`,
        [{ role: "user", text: `Situation: ${s.title}. Tutor's last line: ${last ? last.text : "(start)"}\nLearner's previous answers: ${hist.filter((h: any) => h.role === "user").map((h: any) => h.text).join(" | ").slice(0, 600) || "(none)"}` }], { json: true, max: 400, temp: 0.6 });
      const j = parseJSON(r.text) || {};
      const pair = (x: any) => x && x.en ? { en: clampText(x.en, 120), ru: clampText(x.ru, 160) } : null;
      return json({ idea: clampText(j.idea, 240), starts: (Array.isArray(j.starts) ? j.starts : []).map(pair).filter(Boolean).slice(0, 3), ask: pair(j.ask) });
    }

    if (mode === "analyze") {
      const { data: t } = await db().from("tutor_turns").select("id,session_id,text,at,role").eq("id", String(b.turn_id || "")).eq("user_id", uid).maybeSingle();
      if (!t || t.role !== "user") throw new Fail("Нет реплики", 404);
      c.sid = t.session_id;
      const { data: prev } = await db().from("tutor_turns").select("text").eq("session_id", t.session_id).eq("role", "tutor").lt("at", t.at).order("at", { ascending: false }).limit(1);
      const r = await analyzeText(c, ANALYZER, t.text, prev && prev[0] && prev[0].text || "");
      if (r.mistakes.length) await db().from("tutor_mistakes").insert(r.mistakes.map((m: any) => ({ ...m, session_id: t.session_id, turn_id: t.id, user_id: uid })));
      const { data: saved } = await db().from("tutor_mistakes").select("id,wrong,fix,type,explain").eq("turn_id", t.id);
      return json({ mistakes: saved || [] });
    }

    if (mode === "finish") {
      const s = await ownedSession(uid, b.session); c.sid = s.id;
      if (s.ended_at && s.summary) return json({ summary: s.summary });
      const all = await loadAll(uid), p = all.profile || {}, lv = level || p.level || "A2";
      const turns = await turnsOf(s.id, 200);
      const { data: mis } = await db().from("tutor_mistakes").select("id,turn_id,wrong,fix,type,explain").eq("session_id", s.id).order("at");
      const ms: any[] = mis || [];
      const minutes = Math.min(30, (Date.now() - Date.parse(s.started_at)) / 60000);
      const spoke = turns.filter((t: any) => t.role === "user").length;
      if (!spoke) { await db().from("tutor_sessions").update({ ended_at: new Date().toISOString(), minutes }).eq("id", s.id); return json({ summary: null, empty: true }); }
      const dialog = turns.map((t: any) => (t.role === "tutor" ? "Tutor: " : "Learner: ") + t.text).join("\n").slice(-9000);
      const errs = ms.map((m: any, i: number) => `${i}. [${m.type}] «${m.wrong}» → «${m.fix}»`).join("\n") || "(ошибок нет)";
      const r = await llm(c, MODEL, finishSys(lv, clampText(b.lessons, 6000)), [{ role: "user", text: `Ситуация: ${s.title}\nДиалог:\n${dialog}\n\nОшибки:\n${errs}` }], { json: true, max: 6000, temp: 0.4 });
      const j = parseJSON(r.text) || {};
      // подробный разбор каждой ошибки — в саму ошибку
      for (const d of Array.isArray(j.details) ? j.details : []) {
        const m = ms[+d.i]; if (!m) continue;
        const detail = { rule: clampText(d.rule, 600), chunks: (d.chunks || []).slice(0, 8).map((x: any) => [clampText(x[0], 120), clampText(x[1], 400)]), examples: (d.examples || []).slice(0, 4).map((x: any) => [clampText(x[0], 200), clampText(x[1], 200)]), ru: clampText(d.ru, 500), how: clampText(d.how, 400), lesson: LESSON_IDS.test(d.lesson) ? d.lesson : "" };
        m.detail = detail;
        later(db().from("tutor_mistakes").update({ detail }).eq("id", m.id));
      }
      const by: Record<string, number> = {}; for (const m of ms) by[m.type] = (by[m.type] || 0) + 1;
      const by_type = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, n }));
      const rep = j.repeat || {};
      const mine = turns.filter((t: any) => t.role === "user" && t.text), wl = mine.map((t: any) => wordsOf(t.text));
      const longest = mine[wl.indexOf(Math.max(...wl))];
      const speak = { answers: mine.length, avg: Math.round(wl.reduce((a: number, x: number) => a + x, 0) / Math.max(1, wl.length) * 10) / 10, longest: longest ? clampText(longest.text, 300) : "", longest_n: Math.max(0, ...wl), q: mine.filter((t: any) => isQ(t.text)).length, q_need: needQ(String(b.goal || "")) };
      const stretch = (Array.isArray(j.stretch) ? j.stretch : []).filter((x: any) => x && x.was && x.better).slice(0, 3).map((x: any) => ({ was: clampText(x.was, 200), better: clampText(x.better, 300), chunks: (Array.isArray(x.chunks) ? x.chunks : []).slice(0, 5).map((c: any) => [clampText(c[0], 120), clampText(c[1], 300)]) }));
      const rs = j.result || {}, score = Math.max(0, Math.min(100, Math.round(+rs.score || 0)));
      const result = { score, passed: rs.passed === true && score >= 70, why: clampText(rs.why, 400) };
      const phrases = (Array.isArray(j.phrases) ? j.phrases : []).filter((x: any) => x && x.en).slice(0, 8).map((x: any) => ({ en: clampText(x.en, 160), ru: clampText(x.ru, 200) }));
      const summary = { result, phrases, text: clampText(j.summary, 800), by_type, repeat: { type: clampText(rep.type, 30) || (by_type[0] && by_type[0].type) || "", lesson: LESSON_IDS.test(rep.lesson) ? rep.lesson : "", why: clampText(rep.why, 300) }, mistakes: ms.length, minutes: Math.round(minutes * 10) / 10, speak, stretch, brave: clampText(j.brave, 400) };
      await db().from("tutor_sessions").update({ ended_at: new Date().toISOString(), minutes: summary.minutes, summary }).eq("id", s.id);
      // домашка
      const tasks = cleanHw(j.homework);
      let homework = null;
      if (tasks.length >= 3) { const { data: h } = await db().from("tutor_homework").insert({ user_id: uid, session_id: s.id, tasks }).select("id,tasks,status,created_at").single(); homework = h; }
      // память
      const m0 = all.memory || {}, jm = j.memory || {};
      const freq: Record<string, number> = {}; for (const f of m0.frequent || []) freq[f.type] = f.n; for (const [k, v] of Object.entries(by)) freq[k] = (freq[k] || 0) + v;
      const facts = [...new Set([...(m0.facts || []), ...((jm.facts || []) as string[]).map(x => clampText(x, 120))].filter(Boolean))].slice(-20);
      const memory = { stopped: clampText(jm.stopped, 300) || m0.stopped || "", facts, next_focus: ((jm.next_focus || m0.next_focus || []) as string[]).map(x => clampText(x, 120)).slice(0, 5),
        frequent: Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type, n]) => ({ type, n })), lessons: (m0.lessons || 0) + 1, last: { title: s.title, at: s.started_at }, speak: { avg: speak.avg, q: speak.q }, phrases: [...(m0.phrases || []), ...phrases].filter((x: any, i: number, a: any[]) => a.findIndex((y: any) => y.en.toLowerCase() === x.en.toLowerCase()) === i).slice(-30) };
      await db().from("tutor_memory").upsert({ user_id: uid, memory, updated_at: new Date().toISOString() });
      // план живой: отмечаем пройденное и перестраиваем непройденное по ошибкам — в фоне, ответ не ждёт
      if (all.plan && all.profile) {
        const plan = all.plan;
        for (const w of plan.weeks || []) for (const it of w.items || []) if (it.id === s.plan_item) { it.tries = (+it.tries || 0) + 1; it.best = Math.max(+it.best || 0, score); if (result.passed) it.done = true; }
        await db().from("learning_plan").upsert({ user_id: uid, plan, updated_at: new Date().toISOString() });
        if (b.lessons && b.sits) later(makePlan(c, all.profile, memory, plan, b, `Только что прошёл урок «${s.title}». Ошибки по типам: ${JSON.stringify(by_type)}. Перестрой непройденные уроки: добавь повторение слабых правил.`));
      }
      return json({ summary, mistakes: ms, homework, memory });
    }

    if (mode === "hw_submit" || mode === "hw_sent") {
      const id = String(b.id || ""); if (!/^[0-9a-f-]{36}$/.test(id)) throw new Fail("Нет домашки");
      const upd = mode === "hw_sent" ? { sent_to: /^[0-9a-f-]{36}$/.test(String(b.group || "")) ? b.group : null }
        : { status: "done", score: Math.max(0, Math.min(+b.score || 0, 20)), total: Math.max(1, Math.min(+b.total || 1, 20)), answers: Array.isArray(b.answers) ? b.answers.slice(0, 20).map((x: any) => clampText(x, 200)) : null, done_at: new Date().toISOString() };
      const { error } = await db().from("tutor_homework").update(upd).eq("id", id).eq("user_id", uid);
      if (error) throw error;
      return json({ ok: true });
    }

    if (mode === "history") {
      const s = await ownedSession(uid, b.session);
      const [turns, mis] = await Promise.all([turnsOf(s.id, 300), db().from("tutor_mistakes").select("id,turn_id,wrong,fix,type,explain,detail").eq("session_id", s.id).order("at")]);
      const { data: hw } = await db().from("tutor_homework").select("id,tasks,status,score,total,created_at").eq("session_id", s.id).maybeSingle();
      return json({ session: { id: s.id, title: s.title, at: s.started_at, minutes: s.minutes, summary: s.summary }, turns, mistakes: mis.data || [], homework: hw });
    }

    // ---------- только владелец ----------
    if (mode === "admin" || mode === "stt_test" || mode === "analyzer_test") {
      if (!admin) return json({ error: "Только для владельца" }, 403);
      if (mode === "stt_test") {
        const a = audioIn(b); if (!a) throw new Fail("Нет записи");
        const engines = env("ELEVENLABS_API_KEY") ? ["openai", "scribe"] : ["openai"];
        const out: Record<string, any> = {};
        await Promise.all(engines.map(async e => { const t0 = Date.now(); try { out[e] = { text: await stt(c, e, a.bytes, a.mime, a.sec), ms: Date.now() - t0 }; } catch (er) { out[e] = { error: (er as Error).message }; } }));
        return json(out);
      }
      if (mode === "analyzer_test") {
        const models = (Array.isArray(b.models) && b.models.length ? b.models : [MODEL, "gemini-flash-lite-latest", "gpt-4.1-mini"]).filter((m: string) => LLM_PRICE[m]).slice(0, 3);
        const res: any[] = [];
        for (const m of models) {
          let caught = 0, usd = 0, ms = 0; const rows: any[] = [];
          await Promise.all(TEST10.map(async (s, i) => { const t0 = Date.now(); try { const r = await analyzeText(c, m, s, ""); usd += r.usd; if (r.mistakes.length) caught++; rows[i] = { s, fix: r.mistakes.map((x: any) => x.fix).join("; ") }; } catch (e) { rows[i] = { s, error: (e as Error).message }; } ms += Date.now() - t0; }));
          res.push({ model: m, caught, of: TEST10.length, usd_per_10: usd, usd_lesson_est: usd * 2, avg_ms: Math.round(ms / TEST10.length), rows });
        }
        return json({ models: res });
      }
      const view = String(b.view || "overview");
      if (view === "overview") return json(await adminOverview());
      if (view === "user") return json(await adminUser(String(b.id || "")));
      if (view === "access") {
        const plan = ["free", "beta", "sub"].includes(b.plan) ? b.plan : "free";
        const { error } = await db().from("tutor_access").upsert({ user_id: String(b.id || ""), plan, until: b.until || null, updated_at: new Date().toISOString() });
        if (error) throw error;
        return json({ ok: true });
      }
      throw new Fail("Неизвестный раздел");
    }
    return json({ error: "Неизвестный режим" }, 400);
  } catch (e) {
    const f = e as Fail;
    return json({ error: f.message || String(e), code: f.code || undefined }, f.status || 500);
  }
});
