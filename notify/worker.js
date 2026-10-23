/**
 * Tony老師 通知中繼服務（Cloudflare Worker）
 *
 * 功能
 *  - POST /new    客人送出線上預約後呼叫 → 傳 LINE（＋Email）給設計師
 *  - POST /test   設計師在 APP 按「傳送測試通知」→ 檢查所有設定並發一則測試訊息
 *  - POST /line   LINE Webhook：有人傳「ID」給官方帳號，回覆他的 LINE User ID
 *  - 排程         每天早上把今天的行程傳 LINE（Cloudflare Cron："0 1 * * *" = 台灣 09:00）
 *  - GET  /line-test  只測試 LINE：只需 LINE_CHANNEL_TOKEN、LINE_USER_ID 兩個密碼；
 *                     為防止被亂用，等 OWNER_EMAIL 設定好（正式啟用）後這個網址就自動關閉
 *
 * 需要在 Cloudflare → Worker → 設定 → 變數和密碼 加入（類型選「密碼」）：
 *  FIREBASE_API_KEY      Firebase 設定裡的 apiKey
 *  FIREBASE_PROJECT_ID   Firebase 設定裡的 projectId
 *  OWNER_EMAIL           設計師登入 APP 的 Email
 *  BOT_EMAIL             通知機器人帳號 Email（固定填 notify-bot@tony-teacher.app）
 *  BOT_PASSWORD          通知機器人帳號密碼
 *  LINE_CHANNEL_TOKEN    LINE 官方帳號 Messaging API 的 Channel access token
 *  LINE_USER_ID          要收通知的 LINE User ID（多人用逗號分隔）
 * 選填：
 *  LINE_CHANNEL_SECRET   啟用「傳 ID 查自己的 User ID」功能時需要
 *  RESEND_API_KEY        要收 Email 通知時填（Resend.com 的 API Key）
 *  NOTIFY_EMAIL          收 Email 的信箱（需與 Resend 註冊信箱相同）
 *  DAILY_SUMMARY         填 off 可關閉每日摘要
 */

const TZ_OFFSET = 8 * 3600 * 1000; // 台灣時間
const WD = '日一二三四五六';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });

/* ---------- 共用小工具 ---------- */
const pad = n => String(n).padStart(2, '0');
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHM = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const durText = m => m >= 60 ? Math.floor(m / 60) + ' 小時' + (m % 60 ? ' ' + (m % 60) + ' 分' : '') : m + ' 分';
const taipeiToday = () => new Date(Date.now() + TZ_OFFSET).toISOString().slice(0, 10);
const dateLabel = s => { const [y, m, d] = s.split('-').map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${m}/${d}（${WD[wd]}）`; };
const svcNames = x => (x.services || []).map(s => s.name).join('＋') || '預約';

/* ---------- Firebase（用唯讀的通知機器人帳號） ---------- */
let tokenCache = { token: '', exp: 0 };
async function botToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOT_EMAIL, password: env.BOT_PASSWORD, returnSecureToken: true })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('通知機器人登入失敗：' + (d.error && d.error.message || r.status));
  tokenCache = { token: d.idToken, exp: Date.now() + (Number(d.expiresIn || 3600) - 300) * 1000 };
  return d.idToken;
}
const fsBase = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
function dec(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  return null;
}
const decFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));
async function fsGet(env, path) {
  const r = await fetch(`${fsBase(env)}/${path}`, { headers: { Authorization: 'Bearer ' + await botToken(env) } });
  if (r.status === 404) return null;
  const d = await r.json();
  if (!r.ok) throw new Error('讀取資料庫失敗：' + (d.error && d.error.message || r.status));
  return decFields(d.fields);
}
async function fsQuery(env, collection, field, value) {
  const r = await fetch(`${fsBase(env)}:runQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await botToken(env) },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: collection }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } } } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('查詢資料庫失敗：' + ((d[0] && d[0].error && d[0].error.message) || (d.error && d.error.message) || r.status));
  return d.filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), ...decFields(x.document.fields) }));
}
async function shopName(env) { try { const s = await fsGet(env, 'settings/main'); return (s && s.shopName) || 'Tony老師'; } catch { return 'Tony老師'; } }

/* ---------- 發送 ---------- */
async function sendLine(env, text) {
  const ids = String(env.LINE_USER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const token = String(env.LINE_CHANNEL_TOKEN || '').trim();
  if (!token || !ids.length) return 'skipped';
  if (/^[0-9a-f]{32}$/i.test(token)) throw new Error('LINE_CHANNEL_TOKEN 填成了 Channel secret（32 碼那個）。請改填 Messaging API 分頁最下面、按「發行」產生的 Channel access token（很長一串，約 170 字）。');
  const msg = [{ type: 'text', text: text.slice(0, 4900) }];
  const r = ids.length === 1
    ? await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ to: ids[0], messages: msg }) })
    : await fetch('https://api.line.me/v2/bot/message/multicast', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ to: ids, messages: msg }) });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch {} throw new Error('LINE 傳送失敗：' + (m || r.status)); }
  return 'ok';
}
async function sendEmail(env, subject, text) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return 'skipped';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.RESEND_API_KEY },
    body: JSON.stringify({ from: 'Tony老師 <onboarding@resend.dev>', to: [env.NOTIFY_EMAIL], subject, text })
  });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch {} throw new Error('Email 傳送失敗：' + (m || r.status)); }
  return 'ok';
}
async function sendAll(env, subject, text) {
  const out = {};
  for (const [k, fn] of [['line', () => sendLine(env, text)], ['email', () => sendEmail(env, subject, text)]]) {
    try { out[k] = await fn(); } catch (e) { out[k] = String(e.message || e); }
  }
  return out;
}

/* ---------- 訊息內容 ---------- */
function requestText(q, shop) {
  const end = toHM(toMin(q.start) + (q.duration || 0));
  return [`【${shop}】新的線上預約`, '',
    `日期：${dateLabel(q.date)}`, `時間：${q.start}–${end}（約 ${durText(q.duration || 0)}）`, `項目：${svcNames(q)}`, `費用：${money(q.price)}`,
    `客人：${q.name || '未留稱呼'}　${q.phone || ''}`, q.note ? `備註：${q.note}` : null, '',
    '請打開 Tony老師 APP 接受或婉拒。'].filter(x => x !== null).join('\n');
}
function summaryText(day, bookings, pending, shop) {
  const list = bookings.filter(b => b.status === 'booked' || b.status === 'done').sort((a, b) => toMin(a.start) - toMin(b.start));
  const lines = [`【${shop}】早安！今天 ${dateLabel(day)}有 ${list.length} 組預約`, ''];
  list.forEach(b => lines.push(`${b.start}–${toHM(toMin(b.start) + (b.duration || 0))}　${svcNames(b)}${b.customerName ? '（' + b.customerName + '）' : ''}`));
  if (list.length) lines.push('', `預估 ${money(list.reduce((a, b) => a + (b.price || 0), 0))}`);
  if (pending) lines.push('', `另外有 ${pending} 筆線上預約待確認。`);
  return lines.join('\n');
}

/* ---------- LINE Webhook 簽章 ---------- */
async function lineSigOk(env, body, sig) {
  if (!env.LINE_CHANNEL_SECRET || !sig) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.LINE_CHANNEL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

/* ---------- 路由 ---------- */
async function handleNew(req, env) {
  let id = '';
  try { id = String(JSON.parse(await req.text()).id || ''); } catch {}
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return json({ ok: false, error: 'bad id' }, 400);
  const q = await fsGet(env, 'requests/' + id);
  // 只通知真的存在、仍待確認、且剛送出的預約 → 外人無法用這個網址亂發通知
  if (!q || q.status !== 'pending' || Math.abs(Date.now() - Number(q.createdAt || 0)) > 10 * 60000) return json({ ok: false, error: 'not found or expired' }, 404);
  const shop = await shopName(env);
  const res = await sendAll(env, `新的線上預約：${dateLabel(q.date)} ${q.start} ${svcNames(q)}`, requestText(q, shop));
  return json({ ok: true, ...res });
}
async function handleTest(req, env) {
  // 只有設計師本人（APP 登入的帳號）可以發測試通知
  const auth = req.headers.get('Authorization') || '';
  const idToken = auth.replace(/^Bearer\s+/i, '');
  const checks = {};
  const need = ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'OWNER_EMAIL', 'BOT_EMAIL', 'BOT_PASSWORD', 'LINE_CHANNEL_TOKEN', 'LINE_USER_ID'].filter(k => !env[k]);
  if (need.length) return json({ ok: false, checks: { settings: '缺少設定：' + need.join('、') } });
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
  const d = await r.json().catch(() => ({}));
  const email = d.users && d.users[0] && d.users[0].email;
  if (!email || email.toLowerCase() !== String(env.OWNER_EMAIL).toLowerCase()) return json({ ok: false, checks: { owner: '身分驗證失敗（OWNER_EMAIL 要跟登入 APP 的 Email 一樣）' } }, 403);
  checks.owner = 'ok';
  let shop = 'Tony老師';
  try { const s = await fsGet(env, 'settings/main'); shop = (s && s.shopName) || shop; await fsQuery(env, 'bookings', 'date', taipeiToday()); checks.database = 'ok'; }
  catch (e) { checks.database = String(e.message || e); }
  Object.assign(checks, await sendAll(env, `【${shop}】測試通知`, `【${shop}】測試通知\n\n收到這則訊息，代表新預約通知已經設定完成。`));
  return json({ ok: Object.values(checks).every(v => v === 'ok' || v === 'skipped'), checks });
}
async function handleLine(req, env) {
  const body = await req.text();
  if (!await lineSigOk(env, body, req.headers.get('x-line-signature'))) return new Response('ok');
  let events = []; try { events = JSON.parse(body).events || []; } catch {}
  for (const ev of events) {
    const text = ev.type === 'message' && ev.message && ev.message.type === 'text' ? ev.message.text.trim().toUpperCase() : '';
    if (ev.replyToken && (text === 'ID' || ev.type === 'follow')) {
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_CHANNEL_TOKEN },
        body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: 'text', text: `你的 LINE User ID：\n${ev.source.userId}\n\n要收預約通知，請把它加到 Cloudflare 的 LINE_USER_ID。` }] })
      });
    }
  }
  return new Response('ok');
}
async function handleLineTest(env) {
  const page = (ok, msg) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE 測試</title>
<body style="font:18px/1.6 -apple-system,'PingFang TC',sans-serif;background:#FFF7EE;color:#1B1B1F;padding:32px 20px;max-width:480px;margin:auto">
<h1 style="font-size:26px">${ok ? '✅ 已送出' : '⚠️ 還沒成功'}</h1><p>${msg}</p></body>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (env.OWNER_EMAIL) return page(false, '正式設定已完成，這個測試網址已關閉。請改用 APP 裡的「傳送測試通知」。');
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_USER_ID) return page(false, '還缺密碼：' + ['LINE_CHANNEL_TOKEN', 'LINE_USER_ID'].filter(k => !env[k]).join('、') + '。<br>到 Cloudflare → 這個 Worker → 設定 → 變數和密碼 新增後，再重新整理這一頁。');
  try {
    await sendLine(env, '【Tony老師】LINE 測試成功！\n\n收到這則訊息，代表 LINE 官方帳號和通知服務已經接通。');
    return page(true, '打開 LINE 看看官方帳號有沒有傳來「LINE 測試成功」。<br><br>沒收到的話：確認你已經用手機<b>加這個官方帳號為好友</b>，以及 LINE_USER_ID 是 U 開頭那一串。');
  } catch (e) {
    const m = String(e.message || e);
    const hint = /Channel secret/.test(m) ? '' : /401|Authentication|token/i.test(m) ? 'Channel access token 不對，請到 LINE Developers 重新 Issue 並複製完整一串。'
      : /400|to|user/i.test(m) ? 'LINE_USER_ID 不對，請複製 Basic settings 最下面「Your user ID」（U 開頭）。' : '';
    return page(false, '傳送失敗：' + m + (hint ? '<br><br>' + hint : ''));
  }
}
async function dailySummary(env) {
  if (String(env.DAILY_SUMMARY || '').toLowerCase() === 'off') return { skipped: true };
  const day = taipeiToday();
  const [bookings, pendingAll, shop] = await Promise.all([fsQuery(env, 'bookings', 'date', day), fsQuery(env, 'requests', 'status', 'pending'), shopName(env)]);
  const live = bookings.filter(b => b.status === 'booked' || b.status === 'done');
  if (!live.length && !pendingAll.length) return { skipped: true, reason: 'no bookings' };
  return sendAll(env, `【${shop}】今天 ${dateLabel(day)} 的行程`, summaryText(day, bookings, pendingAll.length, shop));
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'POST' && path === '/new') return await handleNew(req, env);
      if (req.method === 'POST' && path === '/test') return await handleTest(req, env);
      if (req.method === 'POST' && path === '/line') return await handleLine(req, env);
      if (req.method === 'GET' && path === '/line-test') return await handleLineTest(env);
      if (req.method === 'GET' && (path === '' || path === '/')) return json({ ok: true, service: 'Tony老師 通知服務' });
      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailySummary(env).catch(() => {}));
  }
};
// 給測試用
export { dailySummary, requestText, summaryText };
