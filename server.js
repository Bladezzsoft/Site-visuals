// BladeVisuals — Telegram бот визуалов Minecraft
// Роли: owner (из OWNER_IDS) > admin > moderator > user

const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===================== НАСТРОЙКИ =====================
// Токен задаётся только через переменные окружения (Render: BOT_TOKEN).
// Не храните токен Telegram-бота в исходном коде.
const BOT_TOKEN = process.env.BOT_TOKEN;
// Владельцы (всегда админы, их роль нельзя снять). Твой Telegram ID:
const OWNER_IDS = process.env.OWNER_IDS
  ? process.env.OWNER_IDS.split(',').map((s) => Number(s.trim())).filter(Boolean)
  : [5587740615];
const SITE_URL = 'https://site-visuals.onrender.com';
const PORT = process.env.PORT || 3000;
const TZ = 'Europe/Moscow';
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(__dirname, 'db.json'));
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Добавьте его в переменные окружения Render.');
  process.exit(1);
}

// ===================== БАЗА (JSON-файл) =====================
let db = { users: {}, tickets: [], lastTicketId: 0, licenses: {} };
try {
  if (fs.existsSync(DB_FILE)) {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
    db.licenses ||= {};
  }
} catch (e) {
  console.error('Ошибка чтения db.json:', e.message);
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ===================== ХЕЛПЕРЫ =====================
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { timeZone: TZ });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLE_NAMES = {
  owner: '👑 Владелец',
  admin: '🛡 Администратор',
  moderator: '🔧 Модератор',
  user: 'Пользователь',
};

const roleOf = (id) =>
  OWNER_IDS.includes(id) ? 'owner' : db.users[String(id)]?.role || 'user';
const isOwner = (id) => roleOf(id) === 'owner';
const isAdmin = (id) => ['owner', 'admin'].includes(roleOf(id));
const isStaff = (id) => roleOf(id) !== 'user';

const staffIds = () => [
  ...new Set([
    ...OWNER_IDS,
    ...Object.values(db.users)
      .filter((u) => u.role === 'admin' || u.role === 'moderator')
      .map((u) => u.id),
  ]),
];

const displayName = (from) =>
  from.username ? `@${from.username}` : from.first_name || String(from.id);

const userLabel = (id) => {
  const u = db.users[String(id)];
  return u?.username ? `@${u.username}` : `ID ${id}`;
};

function findUser(key) {
  const k = key.replace(/^@/, '').toLowerCase();
  if (/^\d+$/.test(k) && db.users[k]) return db.users[k];
  return Object.values(db.users).find((u) => (u.username || '').toLowerCase() === k);
}

function findTicketOfUser(userId) {
  const list = db.tickets.filter((t) => t.userId === userId);
  const open = list.filter((t) => t.status === 'open');
  return (open.length ? open : list).slice(-1)[0];
}

const getTicket = (id) => db.tickets.find((t) => t.id === Number(id));

const STATUS = { open: '🟡 Открыт', answered: '🟢 Отвечен', closed: '⚫ Закрыт' };

function ticketText(t) {
  let text =
    `🎫 <b>Тикет #${t.id}</b> — ${STATUS[t.status]}\n` +
    `От: ${esc(userLabel(t.userId))}\n` +
    `Тема: ${esc(t.title)}\n` +
    `Создан: ${fmtDate(t.createdAt)}\n\n` +
    esc(t.text);

  const last = (t.replies || [])
    .slice(-3)
    .map((r) => `• ${esc(r.admin)}: ${esc(String(r.text).slice(0, 300))}`)
    .join('\n');
  if (last) text += `\n\n💬 <b>Ответы:</b>\n${last}`;
  return text;
}

// Состояния: userId -> { step, ... }
// user:  'title' | 'text'
// staff: 'reply' | 'bc' | 'bc_confirm'
const states = new Map();

// ===================== КЛАВИАТУРЫ =====================
const mainMenu = (id) => {
  const rows = [
    [
      Markup.button.callback('👤 Профиль', 'profile'),
      Markup.button.callback('🛠 Тех поддержка', 'support'),
    ],
    [Markup.button.url('🌐 Сайт', SITE_URL)],
  ];
  if (isStaff(id)) rows.push([Markup.button.callback('🛡 Админ-панель', 'a:panel')]);
  return Markup.inlineKeyboard(rows);
};

const backMenu = () =>
  Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu')]]);

const staffPanel = (id) => {
  const rows = [[Markup.button.callback('🎫 Открытые тикеты', 'a:tickets')]];
  if (isAdmin(id)) {
    rows.push([
      Markup.button.callback('📊 Статистика', 'a:stats'),
      Markup.button.callback('📢 Рассылка', 'a:bc'),
    ]);
    rows.push([Markup.button.callback('👥 Персонал', 'a:staff')]);
    rows.push([Markup.button.callback('🔑 Ключи лаунчера', 'a:keys')]);
  }
  rows.push([Markup.button.callback('⬅️ В меню', 'menu')]);
  return Markup.inlineKeyboard(rows);
};

const toPanel = () =>
  Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'a:panel')]]);

async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', ...(keyboard || {}) };
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (!String(e.message).includes('message is not modified')) {
      await ctx.reply(text, extra);
    }
  }
}

const guard = (check, fn) => async (ctx) => {
  if (!check(ctx.from.id)) {
    return ctx.answerCbQuery('Нет доступа', { show_alert: true });
  }
  return fn(ctx);
};

const WELCOME =
  '⚔️ <b>BladeVisuals</b> — визуалы для Minecraft\n\n' +
  'Выбери действие в меню ниже.';

// ===================== БОТ =====================
const bot = new Telegraf(BOT_TOKEN);

// Регистрация / обновление пользователя (роль сохраняется)
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    const id = String(ctx.from.id);
    const existing = db.users[id];
    const username = ctx.from.username || null;
    const firstName = ctx.from.first_name || '';
    if (!existing || existing.username !== username || existing.firstName !== firstName) {
      db.users[id] = {
        ...existing,
        id: ctx.from.id,
        username,
        firstName,
        registeredAt: existing?.registeredAt || Date.now(),
      };
      saveDb();
    }
  }
  return next();
});

// Отправка ответа пользователю по тикету
async function sendAnswer(ticket, from, answer) {
  const adminName = displayName(from);
  const message =
    `💬 Администратор <b>${esc(adminName)}</b> ответил вам по вашей проблеме ` +
    `«<b>${esc(ticket.title)}</b>»\n\n` +
    `Ответ: ${esc(answer)}`;

  await bot.telegram.sendMessage(ticket.userId, message, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Написать ещё', 'support')]]),
  });

  ticket.status = 'answered';
  ticket.replies = ticket.replies || [];
  ticket.replies.push({ admin: adminName, text: answer, at: Date.now() });
  saveDb();
}

// ---------- Общие команды ----------
bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply(WELCOME, { parse_mode: 'HTML', ...mainMenu(ctx.from.id) });
});

bot.command('myid', (ctx) => ctx.reply(`Твой ID: ${ctx.from.id}`));

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  await show(ctx, WELCOME, mainMenu(ctx.from.id));
});

bot.action('profile', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.users[String(ctx.from.id)];
  const mine = db.tickets.filter((t) => t.userId === ctx.from.id);
  const openCount = mine.filter((t) => t.status === 'open').length;

  const text =
    '👤 <b>Профиль</b>\n\n' +
    `ID: <code>${u.id}</code>\n` +
    `Ник: ${u.username ? '@' + esc(u.username) : '—'}\n` +
    `Имя: ${esc(u.firstName) || '—'}\n` +
    `Роль: ${ROLE_NAMES[roleOf(u.id)]}\n` +
    `Регистрация: ${new Date(u.registeredAt).toLocaleDateString('ru-RU', { timeZone: TZ })}\n` +
    `Обращений в поддержку: ${mine.length} (открытых: ${openCount})`;

  await show(ctx, text, backMenu());
});

bot.action('support', async (ctx) => {
  await ctx.answerCbQuery();
  states.set(ctx.from.id, { step: 'title' });
  await show(
    ctx,
    '🛠 <b>Тех поддержка</b>\n\nНапиши <b>название проблемы</b> (коротко, до 60 символов):',
    Markup.inlineKeyboard([[Markup.button.callback('✖️ Отмена', 'menu')]])
  );
});

// ===================== АДМИН-ПАНЕЛЬ =====================
async function openPanel(ctx) {
  states.delete(ctx.from.id);
  const text =
    '🛡 <b>Админ-панель</b>\n' + `Ваша роль: ${ROLE_NAMES[roleOf(ctx.from.id)]}`;
  await show(ctx, text, staffPanel(ctx.from.id));
}

bot.command('admin', async (ctx) => {
  if (!isStaff(ctx.from.id)) return;
  states.delete(ctx.from.id);
  await ctx.reply(
    '🛡 <b>Админ-панель</b>\n' + `Ваша роль: ${ROLE_NAMES[roleOf(ctx.from.id)]}`,
    { parse_mode: 'HTML', ...staffPanel(ctx.from.id) }
  );
});

bot.action('a:panel', guard(isStaff, async (ctx) => {
  await ctx.answerCbQuery();
  await openPanel(ctx);
}));


// ---------- Лицензии BladeVisuals Launcher ----------
function makeLicenseKey() {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `BLADE-${part()}-${part()}-${part()}`;
}
function licenseExpiry(days) {
  return days ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
}
function licenseStatus(lic) {
  if (lic.revoked) return '⛔ отозван';
  if (lic.expiresAt && lic.expiresAt <= Date.now()) return '⌛ истёк';
  if (lic.deviceId) return '🟢 привязан';
  return '🟡 свободен';
}
bot.action('a:keys', guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  const all = Object.values(db.licenses || {});
  const active = all.filter(x => !x.revoked && (!x.expiresAt || x.expiresAt > Date.now())).length;
  const text = `🔑 <b>Ключи лаунчера</b>\n\nВсего: <b>${all.length}</b>\nДействующих: <b>${active}</b>\n\nСоздать ключ:`;
  await show(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback('♾️ Бессрочный', 'a:keygen:0')],
    [Markup.button.callback('📅 На 30 дней', 'a:keygen:30'), Markup.button.callback('📅 На 7 дней', 'a:keygen:7')],
    [Markup.button.callback('📋 Последние ключи', 'a:keylist')],
    [Markup.button.callback('⬅️ Назад', 'a:panel')]
  ]));
}));
bot.action(/^a:keygen:(0|7|30)$/, guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const days = Number(ctx.match[1]);
  let key = makeLicenseKey();
  while (db.licenses[key]) key = makeLicenseKey();
  db.licenses[key] = {
    key, createdAt: Date.now(), createdBy: ctx.from.id,
    expiresAt: licenseExpiry(days), deviceId: null, activatedAt: null, revoked: false
  };
  saveDb();
  const expiry = days ? `Срок: ${days} дней` : 'Срок: бессрочно';
  await show(ctx, `✅ <b>Ключ создан</b>\n\n<code>${key}</code>\n${expiry}\n\nПередай ключ покупателю. Он привяжется к первому устройству при активации.`, Markup.inlineKeyboard([
    [Markup.button.callback('📋 К списку ключей', 'a:keylist')],
    [Markup.button.callback('⬅️ К ключам', 'a:keys')]
  ]));
}));
bot.action('a:keylist', guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const items = Object.values(db.licenses || {}).sort((a,b) => b.createdAt-a.createdAt).slice(0, 10);
  if (!items.length) return show(ctx, 'Ключей пока нет.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'a:keys')]]));
  const rows = items.map((lic) => [Markup.button.callback(
    `${licenseStatus(lic)} • ${lic.key}`,
    `a:key:${lic.key}`
  )]);
  rows.push([Markup.button.callback('⬅️ Назад', 'a:keys')]);
  await show(ctx, '📋 <b>Последние 10 ключей</b>\nВыбери ключ для управления:', Markup.inlineKeyboard(rows));
}));
bot.action(/^a:key:(BLADE-[A-F0-9-]+)$/, guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const lic = db.licenses[ctx.match[1]];
  if (!lic) return show(ctx, 'Ключ не найден.', toPanel());
  const device = lic.deviceId ? lic.deviceId.slice(0, 18) + '…' : 'не привязан';
  const expiry = lic.expiresAt ? fmtDate(lic.expiresAt) : 'бессрочно';
  const text = `🔑 <b>${lic.key}</b>\nСтатус: ${licenseStatus(lic)}\nУстройство: <code>${esc(device)}</code>\nИстекает: ${expiry}`;
  const rows = [];
  if (!lic.revoked) rows.push([Markup.button.callback('⛔ Отозвать ключ', `a:keyrevoke:${lic.key}`)]);
  rows.push([Markup.button.callback('⬅️ К списку', 'a:keylist')]);
  await show(ctx, text, Markup.inlineKeyboard(rows));
}));
bot.action(/^a:keyrevoke:(BLADE-[A-F0-9-]+)$/, guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const lic = db.licenses[ctx.match[1]];
  if (!lic) return show(ctx, 'Ключ не найден.', toPanel());
  lic.revoked = true;
  lic.revokedAt = Date.now();
  lic.revokedBy = ctx.from.id;
  saveDb();
  await show(ctx, `⛔ Ключ <code>${lic.key}</code> отозван.`, Markup.inlineKeyboard([
    [Markup.button.callback('📋 К списку', 'a:keylist')],
    [Markup.button.callback('⬅️ К ключам', 'a:keys')]
  ]));
}));

async function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}
const licenseAttempts = new Map();
function checkLicenseRequest(ip) {
  const now = Date.now();
  const old = (licenseAttempts.get(ip) || []).filter(t => now - t < 60_000);
  if (old.length >= 20) return false;
  old.push(now);
  licenseAttempts.set(ip, old);
  return true;
}
function licenseResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function handleLicenseApi(req, res, pathname) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (!checkLicenseRequest(ip)) return licenseResponse(res, 429, { ok: false, error: 'Слишком много запросов. Попробуйте позже.' });
  let body;
  try { body = await readJsonBody(req); }
  catch { return licenseResponse(res, 400, { ok: false, error: 'Некорректный запрос.' }); }
  const key = String(body.key || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '');
  if (!/^BLADE-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/.test(key) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) {
    return licenseResponse(res, 400, { ok: false, error: 'Неверный формат ключа или ID устройства.' });
  }
  const lic = db.licenses[key];
  if (!lic || lic.revoked) return licenseResponse(res, 403, { ok: false, error: 'Ключ недействителен или отозван.' });
  if (lic.expiresAt && lic.expiresAt <= Date.now()) return licenseResponse(res, 403, { ok: false, error: 'Срок действия ключа истёк.' });
  if (pathname.endsWith('/activate')) {
    if (lic.deviceId && lic.deviceId !== deviceId) {
      return licenseResponse(res, 409, { ok: false, error: 'Ключ уже привязан к другому устройству.' });
    }
    if (!lic.deviceId) {
      lic.deviceId = deviceId;
      lic.activatedAt = Date.now();
      saveDb();
    }
  } else if (lic.deviceId !== deviceId) {
    return licenseResponse(res, 403, { ok: false, error: 'Лицензия не активирована на этом устройстве.' });
  }
  return licenseResponse(res, 200, {
    ok: true, status: 'active', expiresAt: lic.expiresAt,
    message: 'Лицензия активна.'
  });
}

// ---------- Список открытых тикетов ----------
bot.action('a:tickets', guard(isStaff, async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);

  const all = db.tickets.filter((t) => t.status === 'open');
  if (!all.length) {
    return show(ctx, '🎫 Открытых тикетов нет.', toPanel());
  }

  const rows = all
    .slice(-15)
    .reverse()
    .map((t) => [
      Markup.button.callback(
        `#${t.id} • ${userLabel(t.userId)} • ${t.title}`.slice(0, 60),
        `t:${t.id}`
      ),
    ]);
  rows.push([Markup.button.callback('⬅️ Назад', 'a:panel')]);

  await show(
    ctx,
    `🎫 <b>Открытые тикеты</b> (${all.length}):`,
    Markup.inlineKeyboard(rows)
  );
}));

function ticketKeyboard(t) {
  const rows = [];
  if (t.status !== 'closed') {
    rows.push([
      Markup.button.callback('💬 Ответить', `r:${t.id}`),
      Markup.button.callback('✅ Закрыть', `c:${t.id}`),
    ]);
  }
  rows.push([Markup.button.callback('⬅️ К списку', 'a:tickets')]);
  return Markup.inlineKeyboard(rows);
}

// Просмотр тикета
bot.action(/^t:(\d+)$/, guard(isStaff, async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  const t = getTicket(ctx.match[1]);
  if (!t) return show(ctx, 'Тикет не найден.', toPanel());
  await show(ctx, ticketText(t), ticketKeyboard(t));
}));

// Ответить на тикет кнопкой
bot.action(/^r:(\d+)$/, guard(isStaff, async (ctx) => {
  await ctx.answerCbQuery();
  const t = getTicket(ctx.match[1]);
  if (!t) return show(ctx, 'Тикет не найден.', toPanel());
  if (t.status === 'closed') {
    return ctx.answerCbQuery('Тикет уже закрыт', { show_alert: true });
  }
  states.set(ctx.from.id, { step: 'reply', ticketId: t.id });
  await show(
    ctx,
    `💬 Напиши ответ на тикет <b>#${t.id}</b> «${esc(t.title)}».\nОн уйдёт пользователю ${esc(userLabel(t.userId))}.`,
    Markup.inlineKeyboard([[Markup.button.callback('✖️ Отмена', `t:${t.id}`)]])
  );
}));

// Закрыть тикет кнопкой
bot.action(/^c:(\d+)$/, guard(isStaff, async (ctx) => {
  const t = getTicket(ctx.match[1]);
  if (!t) return ctx.answerCbQuery('Тикет не найден', { show_alert: true });
  if (t.status === 'closed') return ctx.answerCbQuery('Уже закрыт');

  t.status = 'closed';
  t.closedBy = displayName(ctx.from);
  t.closedAt = Date.now();
  saveDb();
  await ctx.answerCbQuery('Тикет закрыт');

  bot.telegram
    .sendMessage(
      t.userId,
      `🔒 Ваш тикет <b>#${t.id}</b> «${esc(t.title)}» закрыт (${esc(t.closedBy)}).\n` +
        'Если проблема осталась, создайте новый тикет.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Тех поддержка', 'support')]]),
      }
    )
    .catch(() => {});

  await show(ctx, ticketText(t), ticketKeyboard(t));
}));

// ---------- Статистика ----------
bot.action('a:stats', guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const users = Object.values(db.users);
  const count = (s) => db.tickets.filter((t) => t.status === s).length;
  const admins = new Set([
    ...OWNER_IDS,
    ...users.filter((u) => u.role === 'admin').map((u) => u.id),
  ]).size;
  const mods = users.filter((u) => u.role === 'moderator').length;

  const text =
    '📊 <b>Статистика</b>\n\n' +
    `Пользователей: <b>${users.length}</b>\n` +
    `Администраторов: ${admins}, модераторов: ${mods}\n\n` +
    `Тикетов всего: <b>${db.tickets.length}</b>\n` +
    `🟡 Открытых: ${count('open')}\n` +
    `🟢 Отвеченных: ${count('answered')}\n` +
    `⚫ Закрытых: ${count('closed')}`;

  await show(ctx, text, toPanel());
}));

// ---------- Персонал ----------
bot.action('a:staff', guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  const lines = [];
  for (const id of OWNER_IDS) lines.push(`👑 ${esc(userLabel(id))} — владелец`);
  for (const u of Object.values(db.users)) {
    if (OWNER_IDS.includes(u.id)) continue;
    if (u.role === 'admin') lines.push(`🛡 ${esc(userLabel(u.id))} — администратор`);
  }
  for (const u of Object.values(db.users)) {
    if (u.role === 'moderator') lines.push(`🔧 ${esc(userLabel(u.id))} — модератор`);
  }

  const text =
    '👥 <b>Персонал</b>\n\n' +
    lines.join('\n') +
    '\n\n<b>Назначить:</b>\n' +
    '<code>/setrole @ник moderator</code>\n' +
    '<code>/setrole @ник admin</code> (только владелец)\n' +
    '<b>Снять:</b> <code>/setrole @ник user</code>\n\n' +
    'Человек должен хотя бы раз запустить бота (/start).';

  await show(ctx, text, toPanel());
}));

// /setrole <username|id> <user|moderator|admin>
bot.command('setrole', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const m = ctx.message.text.match(/^\/setrole(?:@\w+)?\s+(\S+)\s+(\S+)\s*$/i);
  if (!m) {
    return ctx.reply(
      'Использование: /setrole <username|id> <user|moderator|admin>\n' +
        'Пример: /setrole @steve moderator'
    );
  }

  const role = m[2].toLowerCase();
  if (!['user', 'moderator', 'admin'].includes(role)) {
    return ctx.reply('Роль должна быть: user, moderator или admin.');
  }

  const target = findUser(m[1]);
  if (!target) {
    return ctx.reply('Пользователь не найден. Он должен хотя бы раз запустить бота (/start).');
  }
  if (OWNER_IDS.includes(target.id)) {
    return ctx.reply('Роль владельца изменить нельзя.');
  }

  const current = target.role || 'user';
  if ((role === 'admin' || current === 'admin') && !isOwner(ctx.from.id)) {
    return ctx.reply('Назначать и снимать администраторов может только владелец.');
  }

  target.role = role;
  saveDb();

  await ctx.reply(`✅ ${userLabel(target.id)} теперь: ${ROLE_NAMES[role]}`);

  const note =
    role === 'user'
      ? 'Ваша роль в боте BladeVisuals снята.'
      : `Вам назначена роль: ${ROLE_NAMES[role]}\nОткройте панель командой /admin`;
  bot.telegram.sendMessage(target.id, note).catch(() => {});
});

// /reply <username|id> <ответ> — быстрый ответ по последнему тикету
bot.command('reply', async (ctx) => {
  if (!isStaff(ctx.from.id)) return;

  const m = ctx.message.text.match(/^\/reply(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/);
  if (!m) return ctx.reply('Использование: /reply <username> <ответ>');

  const [, key, answer] = m;
  const user = findUser(key);
  if (!user) return ctx.reply(`Пользователь «${key}» не найден.`);

  const ticket = findTicketOfUser(user.id);
  if (!ticket) return ctx.reply('У этого пользователя нет тикетов.');

  try {
    await sendAnswer(ticket, ctx.from, answer);
    await ctx.reply(`✅ Ответ на тикет #${ticket.id} отправлен.`);
  } catch (e) {
    await ctx.reply(`❌ Не удалось отправить: ${e.message}`);
  }
});

// ---------- Рассылка ----------
bot.action('a:bc', guard(isAdmin, async (ctx) => {
  await ctx.answerCbQuery();
  states.set(ctx.from.id, { step: 'bc' });
  await show(
    ctx,
    '📢 <b>Рассылка</b>\n\nНапиши текст, который получат все пользователи бота (' +
      Object.keys(db.users).length +
      ').',
    Markup.inlineKeyboard([[Markup.button.callback('✖️ Отмена', 'a:panel')]])
  );
}));

bot.action('bc:send', guard(isAdmin, async (ctx) => {
  const st = states.get(ctx.from.id);
  if (!st || st.step !== 'bc_confirm') {
    return ctx.answerCbQuery('Нет текста для рассылки', { show_alert: true });
  }
  states.delete(ctx.from.id);
  await ctx.answerCbQuery('Рассылка началась');
  await show(ctx, '⏳ Отправляю рассылку...');

  let sent = 0;
  let failed = 0;
  for (const u of Object.values(db.users)) {
    try {
      await bot.telegram.sendMessage(u.id, `📢 BladeVisuals\n\n${st.text}`);
      sent++;
    } catch (e) {
      failed++;
    }
    await sleep(50);
  }

  await ctx.reply(
    `✅ Рассылка завершена\nДоставлено: ${sent}\nНе доставлено: ${failed}`,
    staffPanel(ctx.from.id)
  );
}));

// ===================== ТЕКСТОВЫЕ СООБЩЕНИЯ =====================
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const state = states.get(ctx.from.id);
  if (!state) {
    return ctx.reply('Выбери действие в меню:', mainMenu(ctx.from.id));
  }

  // --- Ответ на тикет (персонал) ---
  if (state.step === 'reply') {
    states.delete(ctx.from.id);
    if (!isStaff(ctx.from.id)) return;
    const ticket = getTicket(state.ticketId);
    if (!ticket) return ctx.reply('Тикет не найден.');

    try {
      await sendAnswer(ticket, ctx.from, text);
      return ctx.reply(
        `✅ Ответ на тикет #${ticket.id} отправлен.`,
        Markup.inlineKeyboard([[Markup.button.callback('🎫 К тикетам', 'a:tickets')]])
      );
    } catch (e) {
      return ctx.reply(`❌ Не удалось отправить: ${e.message}`);
    }
  }

  // --- Текст рассылки (админ) ---
  if (state.step === 'bc') {
    if (!isAdmin(ctx.from.id)) {
      states.delete(ctx.from.id);
      return;
    }
    states.set(ctx.from.id, { step: 'bc_confirm', text });
    return ctx.reply(
      `📢 <b>Предпросмотр рассылки</b> (получателей: ${Object.keys(db.users).length}):\n\n${esc(text)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Отправить', 'bc:send'),
            Markup.button.callback('✖️ Отмена', 'a:panel'),
          ],
        ]),
      }
    );
  }

  // --- Создание тикета (пользователь) ---
  if (state.step === 'title') {
    if (text.length > 60) {
      return ctx.reply('Слишком длинно, сократи до 60 символов:');
    }
    states.set(ctx.from.id, { step: 'text', title: text });
    return ctx.reply(
      `Тема: «${text}»\n\nТеперь опиши проблему подробно:`,
      Markup.inlineKeyboard([[Markup.button.callback('✖️ Отмена', 'menu')]])
    );
  }

  if (state.step === 'text') {
    if (text.length > 1500) {
      return ctx.reply('Слишком длинно, сократи описание до 1500 символов:');
    }

    const ticket = {
      id: ++db.lastTicketId,
      userId: ctx.from.id,
      title: state.title,
      text,
      status: 'open',
      createdAt: Date.now(),
      replies: [],
    };
    db.tickets.push(ticket);
    saveDb();
    states.delete(ctx.from.id);

    await ctx.reply(
      `✅ Тикет <b>#${ticket.id}</b> «${esc(ticket.title)}» создан.\nАдминистратор ответит вам здесь.`,
      { parse_mode: 'HTML', ...backMenu() }
    );

    const who = ctx.from.username ? `@${ctx.from.username}` : `ID ${ctx.from.id}`;
    for (const staffId of staffIds()) {
      bot.telegram
        .sendMessage(
          staffId,
          `🆕 <b>Тикет #${ticket.id}</b>\n` +
            `От: ${esc(who)}\n` +
            `Тема: ${esc(ticket.title)}\n\n${esc(ticket.text)}`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📂 Открыть тикет', `t:${ticket.id}`)],
            ]),
          }
        )
        .catch((e) => console.error('Не удалось уведомить', staffId, e.message));
    }
  }
});

bot.catch((err, ctx) => {
  console.error(`Ошибка в ${ctx.updateType}:`, err);
});

bot.launch().catch((e) => {
  console.error('Ошибка запуска бота:', e);
  process.exit(1);
});
console.log('BladeVisuals бот запущен');

// ===================== САЙТ (index.html из корня проекта) =====================
const ROOT = __dirname;

// Файлы бота, которые нельзя отдавать через сайт (там токен и данные пользователей)
const BLOCKED = new Set([
  'server.js',
  'db.json',
  'db.json.tmp',
  'package.json',
  'package-lock.json',
  'render.yaml',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — страница не найдена');
}

function sendFile(req, res, filePath) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type });
    if (req.method === 'HEAD') {
      stream.destroy();
      return res.end();
    }
    stream.pipe(res);
  });
  stream.on('error', () => notFound(res));
}

http
  .createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (e) {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (pathname.includes('\0')) {
      res.writeHead(400);
      return res.end('Bad request');
    }

    if (pathname === '/api/license/activate' || pathname === '/api/license/verify') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }
      return handleLicenseApi(req, res, pathname).catch((e) => {
        console.error('License API error:', e.message);
        if (!res.headersSent) licenseResponse(res, 500, { ok: false, error: 'Внутренняя ошибка сервера.' });
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST' });
      return res.end();
    }

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('BladeVisuals bot is running');
    }

    let filePath = path.join(ROOT, pathname);
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      return notFound(res);
    }

    // Скрытые файлы, node_modules и файлы бота не отдаём
    const parts = path.relative(ROOT, filePath).split(path.sep).filter(Boolean);
    const hidden =
      parts.some((p) => p.startsWith('.') || p === 'node_modules') ||
      (parts.length === 1 && BLOCKED.has(parts[0].toLowerCase()));
    if (hidden) return notFound(res);

    fs.stat(filePath, (err, st) => {
      if (err) return notFound(res);
      if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
      sendFile(req, res, filePath);
    });
  })
  .listen(PORT, () => console.log(`Сайт и бот работают, порт ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
