// Hi There — отправка пуш-уведомлений (Supabase Edge Function «push-send»).
// Режимы (поле mode в теле запроса или ?mode= в адресе):
//   keygen      — один раз: создать пару ключей VAPID (работает, только пока ключи не заданы в Secrets)
//   key         — публичный ключ для приложения
//   status      — вошедший пользователь: { admin } — может ли он делать рассылку
//   subscribe   — вошедший пользователь: сохранить подписку телефона
//   unsubscribe — вошедший пользователь: удалить подписку телефона
//   test        — вошедший пользователь: прислать пробное уведомление себе
//   broadcast   — админ (его id в PUSH_ADMINS): сообщение всем подписанным
//   daily       — расписание (заголовок x-cron-key = CRON_KEY): напоминание о повторении слов
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…), PUSH_ADMINS, CRON_KEY.
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// ключи могли вставить с кавычками или пробелами — чистим
const clean = (v: string) => v.trim().replace(/^["'«]+|["'»]+$/g, "").trim();
const PUB = clean(env("VAPID_PUBLIC_KEY")), PRIV = clean(env("VAPID_PRIVATE_KEY"));
let SUBJ = clean(env("VAPID_SUBJECT")) || "mailto:hello@hithere.app";
if (!/^(mailto:|https:\/\/)/.test(SUBJ)) SUBJ = /@/.test(SUBJ) ? "mailto:" + SUBJ : "mailto:hello@hithere.app";
// проверяем ключи при запросе, а не при запуске: иначе любая ошибка в Secrets роняет функцию целиком (WORKER_ERROR)
let vapidErr = "";
if (PUB && PRIV) {
  try { webpush.setVapidDetails(SUBJ, PUB, PRIV); }
  catch (e) {
    vapidErr = "Ключи в Secrets не подходят: " + ((e as Error).message || e) +
      ` (VAPID_PUBLIC_KEY: ${PUB.length} символов, нужно 87; VAPID_PRIVATE_KEY: ${PRIV.length}, нужно 43 — не перепутаны ли местами?)`;
  }
}
const ADMINS = env("PUSH_ADMINS").split(",").map(s => s.trim()).filter(Boolean);
const db = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

type Row = { endpoint: string; user_id: string | null; sub: webpush.PushSubscription };
type Msg = { title: string; body: string; tab?: string; tag?: string };

async function userOf(req: Request) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t || t.split(".").length !== 3) return null;   // ключ приложения (не токен пользователя)
  const { data } = await db().auth.getUser(t);
  return data && data.user || null;
}
async function allSubs(filter?: (q: any) => any): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db().from("push_subs").select("endpoint,user_id,sub").range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data as Row[]));
    if (!data || data.length < 1000) return out;
  }
}
async function send(rows: Row[], make: (r: Row) => Msg | null | Promise<Msg | null>) {
  let sent = 0, gone = 0, failed = 0;
  const dead: string[] = [];
  for (let i = 0; i < rows.length; i += 40) {
    await Promise.all(rows.slice(i, i + 40).map(async r => {
      const m = await make(r); if (!m) return;
      try { await webpush.sendNotification(r.sub, JSON.stringify(m), { TTL: 12 * 3600, urgency: "normal" }); sent++; }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { gone++; dead.push(r.endpoint); } else failed++;
      }
    }));
  }
  if (dead.length) await db().from("push_subs").delete().in("endpoint", dead);   // телефон отписался — убираем
  return { sent, gone, failed };
}
const plural = (n: number, a: string, b: string, c: string) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

// вечернее напоминание: сколько слов ждут повторения (слова, которые человек сам отправил в повторение)
async function daily() {
  const rows = await allSubs(q => q.not("user_id", "is", null));
  const ids = [...new Set(rows.map(r => r.user_id as string))];
  const due: Record<string, number> = {}, queued: Record<string, number> = {};
  const until = Date.now() + 6 * 3600e3;   // до конца сегодняшнего вечера
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from("user_data").select("user_id,dict").in("user_id", ids.slice(i, i + 200));
    if (error) throw error;
    for (const u of data || []) {
      const dict = Array.isArray(u.dict) ? u.dict : [];
      due[u.user_id] = dict.filter((d: any) => d && d.ir && d.ir.st >= 1 && d.ir.st < 4 && d.ir.due < until).length;
      queued[u.user_id] = dict.filter((d: any) => d && d.ir && d.ir.st === 0).length;
    }
  }
  return send(rows, r => {
    const n = due[r.user_id as string] || 0, q = queued[r.user_id as string] || 0;
    if (n) return { title: "Пора повторить 🔁", body: `${n} ${plural(n, "слово ждёт", "слова ждут", "слов ждут")} повторения. Пара минут — и готово.`, tab: "cards", tag: "ir" };
    if (q) { const k = Math.min(5, q); return { title: "Новые слова ждут", body: `В очереди ${q} ${plural(q, "слово", "слова", "слов")}. Начнём сегодня с ${k}?`, tab: "cards", tag: "ir" }; }
    return null;
  });
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    const mode = String(body.mode || url.searchParams.get("mode") || "");

    if (mode === "keygen") {
      if (PUB && PRIV) return json({ error: "Ключи уже заданы" }, 400);
      const k = webpush.generateVAPIDKeys();
      return json({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey });
    }
    if (!PUB || !PRIV) return json({ error: "Не заданы VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY" }, 500);
    if (vapidErr) return json({ error: vapidErr }, 500);
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return json({ error: "Supabase не передал SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
    if (mode === "key") return json({ key: PUB });

    if (mode === "daily") {
      if (!env("CRON_KEY") || req.headers.get("x-cron-key") !== env("CRON_KEY")) return json({ error: "forbidden" }, 403);
      return json(await daily());
    }

    const user = await userOf(req);
    if (!user) return json({ error: "Нужно войти в аккаунт" }, 401);
    const admin = ADMINS.includes(user.id);

    if (mode === "status") return json({ admin });
    if (mode === "subscribe") {
      const s = body.sub;
      if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "Неверная подписка" }, 400);
      const { error } = await db().from("push_subs").upsert({ endpoint: s.endpoint, user_id: user.id, sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, tz: String(body.tz || "").slice(0, 60), updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }
    if (mode === "unsubscribe") {
      await db().from("push_subs").delete().eq("endpoint", String(body.endpoint || "")).eq("user_id", user.id);
      return json({ ok: true });
    }
    if (mode === "test") {
      const rows = await allSubs(q => q.eq("user_id", user.id));
      return json(await send(rows, () => ({ title: "Hi There", body: "Уведомления работают 👋" })));
    }
    if (mode === "broadcast") {
      if (!admin) return json({ error: "Только для автора" }, 403);
      const title = String(body.title || "Hi There").slice(0, 60), text = String(body.body || "").slice(0, 200);
      if (!text) return json({ error: "Пустой текст" }, 400);
      return json(await send(await allSubs(), () => ({ title, body: text, tag: "news" })));
    }
    return json({ error: "Неизвестный режим" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
