// Hi There — админка (Supabase Edge Function «admin»). Видит только владелец: его id в Secrets PUSH_ADMINS (или ADMINS).
// Режимы (поле mode):
//   me        — вошедший пользователь: { admin } — показывать ли строку «Админка» в профиле
//   overview  — админ: кто онлайн, сегодня, люди, возвраты
//   user      — админ: карточка человека (прогресс и активность, без словаря, сообщений и постов)
// Таблицы presence и app_events — из supabase/admin.sql. SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) || "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
const ADMINS = (env("ADMINS") || env("PUSH_ADMINS")).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const db = () => createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const DAY = 864e5;
const dayStart = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

async function userOf(req: Request) {
  const t = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t || t.split(".").length !== 3) return null;
  const { data } = await db().auth.getUser(t);
  return data && data.user || null;
}
const isAdmin = (u: any) => ADMINS.includes(String(u.id).toLowerCase()) || (!!u.email && ADMINS.includes(String(u.email).toLowerCase()));

async function authUsers() {
  const out: any[] = [];
  for (let page = 1; page < 50; page++) {
    const { data, error } = await db().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    out.push(...data.users);
    if (data.users.length < 1000) break;
  }
  return out;
}
// таблицы могло ещё не быть (admin.sql не запущен) — тогда просто пусто
const rows = async (q: any) => { const { data, error } = await q; return error ? [] : (data || []); };

const COURSE_LV: [string, RegExp][] = [["A1", /^a1-/], ["A2", /^a2-/], ["B1", /^b1-/], ["B2", /^b2-/]];
// что человек прошёл: по прогрессу, который приложение само синхронизирует в user_data
function progressOf(p: any, dict: any) {
  p = p || {};
  const path = p["vzhivuyu.path.v1"] || {}, rw = p["vzhivuyu.rewards.v2"] || {}, prof = p["vzhivuyu.profile.v1"] || {};
  const done = Object.keys(path.done || {});
  const lessons = done.filter(k => /^(a1|a2|b1|b2)-\d\d$/.test(k)).length;
  const steps = done.filter(k => /^(a1|a2|b1|b2)-/.test(k)).length;
  const byLv: Record<string, number> = {}; for (const [lv, re] of COURSE_LV) byLv[lv] = done.filter(k => re.test(k)).length;
  const words = Array.isArray(dict) ? dict.length : 0;
  const iv = p["vzhivuyu.interview.v2"] || {};
  return { level: path.level || prof.level || "", streak: +rw.streak || 0, xp: +rw.xp || 0, lessons, steps, byLv, words, goal: prof.goal || "",
    books: Object.keys((p["vzhivuyu.books.v1"] || {}).done || {}).length, interview: Object.keys(iv.done || {}).length };
}

async function overview() {
  const d = db(), now = Date.now(), day = dayStart();
  const [users, pres, ev, profs, ud] = await Promise.all([
    authUsers(),
    rows(d.from("presence").select("user_id,at").gte("at", new Date(now - 30 * DAY).toISOString())),
    rows(d.from("app_events").select("user_id,at").gte("at", new Date(now - 40 * DAY).toISOString()).limit(50000)),
    rows(d.from("profiles").select("id,name,level")),
    rows(d.from("user_data").select("user_id,progress,dict,updated_at")),
  ]);
  const P: Record<string, any> = {}; for (const p of profs) P[p.id] = p;
  const D: Record<string, any> = {}; for (const u of ud) D[u.user_id] = u;
  const last: Record<string, string> = {};
  const seen = (id: string, at: string) => { if (at && (!last[id] || at > last[id])) last[id] = at; };
  for (const p of pres) seen(p.user_id, p.at);
  for (const e of ev) seen(e.user_id, e.at);
  for (const u of ud) seen(u.user_id, u.updated_at);
  const online = pres.filter((p: any) => now - Date.parse(p.at) < 100e3);
  const list = users.map(x => {
    const g = progressOf(D[x.id] && D[x.id].progress, D[x.id] && D[x.id].dict);
    return { id: x.id, name: P[x.id] && P[x.id].name || "", email: x.email || "", created: x.created_at, last: last[x.id] || x.last_sign_in_at || "", ...g, level: g.level || (P[x.id] && P[x.id].level) || "" };
  });
  const visits = new Set<string>(); for (const e of ev) if (e.at >= day) visits.add(e.user_id);
  for (const u of ud) if (u.updated_at >= day) visits.add(u.user_id);
  const learned = list.filter(u => u.last >= day && (u.lessons || u.steps)).length;
  // возвраты: из тех, кто зарегистрировался в день X, сколько открыли приложение в X+1 и в X+7
  const daysOf: Record<string, Set<string>> = {};
  for (const e of ev) (daysOf[e.user_id] || (daysOf[e.user_id] = new Set())).add(e.at.slice(0, 10));
  const dkey = (t: number) => new Date(t).toISOString().slice(0, 10);
  let c1 = 0, r1 = 0, c7 = 0, r7 = 0;
  for (const x of users) {
    const first = Date.parse(x.created_at); if (!(first > now - 37 * DAY)) continue;
    const ds = daysOf[x.id] || new Set();
    if (first < now - 2 * DAY) { c1++; if (ds.has(dkey(first + DAY))) r1++; }
    if (first < now - 8 * DAY) { c7++; if (ds.has(dkey(first + 7 * DAY))) r7++; }
  }
  const week = list.filter(u => u.last && now - Date.parse(u.last) < 7 * DAY).length;
  const lv: Record<string, number> = {}; for (const u of list) if (u.level) lv[u.level] = (lv[u.level] || 0) + 1;
  return {
    now: { online: online.length, list: online.map((p: any) => { const u = list.find(x => x.id === p.user_id); return { id: p.user_id, name: u ? u.name || u.email : "" }; }) },
    today: { visits: visits.size, signups: users.filter(x => x.created_at >= day).length, learned },
    totals: { users: users.length, week, levels: lv, words: list.reduce((s, u) => s + u.words, 0), lessons: list.reduce((s, u) => s + u.lessons, 0) },
    users: list,
    returns: { d1: c1 ? r1 / c1 : null, d1_n: c1, d7: c7 ? r7 / c7 : null, d7_n: c7 },
    tables: { presence: pres.length > 0 || ev.length > 0 },
  };
}

async function userCard(id: string) {
  const d = db(), now = Date.now();
  const [ud, ev, prof, au] = await Promise.all([
    d.from("user_data").select("progress,dict,updated_at").eq("user_id", id).maybeSingle(),
    rows(d.from("app_events").select("at").eq("user_id", id).gte("at", new Date(now - 28 * DAY).toISOString()).limit(5000)),
    d.from("profiles").select("name,level").eq("id", id).maybeSingle(),
    d.auth.admin.getUserById(id),
  ]);
  const g = progressOf(ud.data && ud.data.progress, ud.data && ud.data.dict);
  const days = [...new Set(ev.map((e: any) => e.at.slice(0, 10)))].sort();
  const u = au.data && au.data.user;
  // приватность: только счётчики — без слов словаря, сообщений и постов
  return { name: prof.data && prof.data.name || "", email: u && u.email || "", created: u && u.created_at || "", last_sync: ud.data && ud.data.updated_at || "", ...g, days };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return json({ error: "Только POST" }, 405);
    if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) return json({ error: "Supabase не передал SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" }, 500);
    let b: any = {}; try { b = await req.json(); } catch { b = {}; }
    const user = await userOf(req);
    if (!user) return json({ error: "Нужно войти в аккаунт" }, 401);
    const admin = isAdmin(user);
    if (b.mode === "me") return json({ admin });
    if (!admin) return json({ error: "Только для автора приложения" }, 403);
    if (b.mode === "overview") return json(await overview());
    if (b.mode === "user") return json(await userCard(String(b.id || "")));
    return json({ error: "Неизвестный режим" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
