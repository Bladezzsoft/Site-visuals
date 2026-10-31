const { Telegraf, Markup } = require('telegraf');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ===================== НАСТРОЙКИ =====================
const BOT_TOKEN = process.env.BOT_TOKEN || '9018221392:AAGOD-lKDwKcHrTvH-xVhODOiIoT2Kr82Sk';
const ADMIN_IDS = [5587740615]; // сюда свой Telegram ID
const SITE_URL = 'https://site-visuals.onrender.com';
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

if (!BOT_TOKEN) {
  console.error('Не задан BOT_TOKEN. Укажи его в переменных окружения.');
  process.exit(1);
}

// ===================== БАЗА (JSON-файл) =====================
let db = { users: {}, tickets: [], lastTicketId: 0 };
try {
  if (fs.existsSync(DB_FILE)) {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
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

const isAdmin = (id) => ADMIN_IDS.includes(id);

const displayName = (from) =>
  from.username ? `@${from.username}` : from.first_name || String(from.id);

function findUser(key) {
  const k = key.replace(/^@/, '').toLowerCase();
  if (/^\d+$/.test(k) && db.users[k]) return db.users[k];
  return Object.values(db.users).find((u) => (u.username || '').toLowerCase() === k);
}

function findTicket(userId) {
  const list = db.tickets.filter((t) => t.userId === userId);
  const open = list.filter((t) => t.status === 'open');
  return (open.length ? open : list).slice(-1)[0];
}

// Состояния создания тикета: userId -> { step: 'title' | 'text', title }
const states = new Map();

const mainMenu = () =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('👤 Профиль', 'profile'),
      Markup.button.callback('🛠 Тех поддержка', 'support'),
    ],
    [Markup.button.url('🌐 Сайт', SITE_URL)],
  ]);

const backMenu = () =>
  Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'menu')]]);

async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', ...keyboard };
  try {
    await ctx.editMessageText(text, extra);
  } catch (e) {
    if (!String(e.message).includes('message is not modified')) {
      await ctx.reply(text, extra);
    }
  }
}

const WELCOME =
  '⚔️ <b>BladeVisuals</b> — визуалы для Minecraft\n\n' +
  'Выбери действие в меню ниже.';

// ===================== БОТ =====================
const bot = new Telegraf(BOT_TOKEN);

// Регистрация / обновление пользователя
bot.use(async (ctx, next) => {
  if (ctx.from && !ctx.from.is_bot) {
    const id = String(ctx.from.id);
    const existing = db.users[id];
    db.users[id] = {
      id: ctx.from.id,
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || '',
      registeredAt: existing?.registeredAt || Date.now(),
    };
    saveDb();
  }
  return next();
});

bot.start(async (ctx) => {
  states.delete(ctx.from.id);
  await ctx.reply(WELCOME, { parse_mode: 'HTML', ...mainMenu() });
});

bot.command('myid', (ctx) => ctx.reply(`Твой ID: ${ctx.from.id}`));

// ---------- Кнопки ----------
bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  states.delete(ctx.from.id);
  await show(ctx, WELCOME, mainMenu());
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
    `Регистрация: ${new Date(u.registeredAt).toLocaleDateString('ru-RU')}\n` +
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

// ---------- Команды админа ----------
// /reply <username> <ответ>
bot.command('reply', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const m = ctx.message.text.match(/^\/reply(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/);
  if (!m) {
    return ctx.reply('Использование: /reply <username> <ответ>');
  }

  const [, key, answer] = m;
  const user = findUser(key);
  if (!user) return ctx.reply(`Пользователь «${key}» не найден.`);

  const ticket = findTicket(user.id);
  if (!ticket) return ctx.reply('У этого пользователя нет тикетов.');

  const adminName = displayName(ctx.from);
  const message =
    `💬 Администратор <b>${esc(adminName)}</b> ответил вам по вашей проблеме ` +
    `«<b>${esc(ticket.title)}</b>»\n\n` +
    `Ответ: ${esc(answer)}`;

  try {
    await bot.telegram.sendMessage(user.id, message, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('🛠 Написать ещё', 'support')]]),
    });
    ticket.status = 'answered';
    ticket.replies = ticket.replies || [];
    ticket.replies.push({ admin: adminName, text: answer, at: Date.now() });
    saveDb();
    await ctx.reply(`✅ Ответ на тикет #${ticket.id} отправлен.`);
  } catch (e) {
    await ctx.reply(`❌ Не удалось отправить: ${e.message}`);
  }
});

// /tickets — список открытых тикетов
bot.command('tickets', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const open = db.tickets.filter((t) => t.status === 'open');
  if (!open.length) return ctx.reply('Открытых тикетов нет.');

  const text = open
    .slice(-20)
    .map((t) => {
      const u = db.users[String(t.userId)];
      const who = u?.username ? '@' + u.username : t.userId;
      return `#${t.id} • ${who} • ${t.title}`;
    })
    .join('\n');
  await ctx.reply(text);
});

// ---------- Текстовые сообщения (создание тикета) ----------
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const state = states.get(ctx.from.id);
  if (!state) {
    return ctx.reply('Выбери действие в меню:', mainMenu());
  }

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
    const hint = ctx.from.username || ctx.from.id;
    for (const adminId of ADMIN_IDS) {
      bot.telegram
        .sendMessage(
          adminId,
          `🆕 <b>Тикет #${ticket.id}</b>\n` +
            `От: ${esc(who)}\n` +
            `Тема: ${esc(ticket.title)}\n\n${esc(ticket.text)}\n\n` +
            `Ответить: <code>/reply ${esc(hint)} </code>`,
          { parse_mode: 'HTML' }
        )
        .catch((e) => console.error('Не удалось уведомить админа', adminId, e.message));
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

// ===================== HTTP (для Render) =====================
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('BladeVisuals bot is running');
  })
  .listen(PORT, () => console.log(`HTTP сервер на порту ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
