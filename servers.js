const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = '9018221392:AAHgdmTjhPa7PbC8I1smVzKQVORRNq46_uo';
const API = `https://api.telegram.org/bot${TOKEN}`;

let OWNER_CHAT_ID = null;
let lastUpdateId = 0;

/* Приём заявки с сайта */
app.post('/api/support', async (req, res) => {
  const { nickname, telegram, message } = req.body || {};
  if (!nickname || !telegram || !message) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }
  if (!OWNER_CHAT_ID) {
    return res.status(503).json({ error: 'Владелец ещё не активировал бота. Напишите боту /start' });
  }

  const text = `<b>🆘 Новая заявка в техподдержку BladeVisuals</b>\n\n` +
    `<b>Никнейм:</b> ${escapeHtml(nickname)}\n` +
    `<b>Telegram:</b> ${escapeHtml(telegram)}\n` +
    `<b>Сообщение:</b>\n${escapeHtml(message)}`;

  try {
    const r = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
    const data = await r.json();
    if (data.ok) {
      res.json({ success: true, message: 'Заявка отправлена владельцу' });
    } else {
      res.status(500).json({ error: data.description });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Опрос Telegram (polling) */
setInterval(async () => {
  try {
    const r = await fetch(`${API}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`);
    const data = await r.json();
    if (!data.ok || !data.result || data.result.length === 0) return;

    for (const upd of data.result) {
      lastUpdateId = upd.update_id;
      if (upd.message) await handleMessage(upd.message);
      if (upd.callback_query) await handleCallback(upd.callback_query);
    }
  } catch (e) {
    console.error('Polling error:', e.message);
  }
}, 3000);

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Pierwsza osoba, która napisze боту, становится владельцем
  if (!OWNER_CHAT_ID) {
    OWNER_CHAT_ID = chatId;
    await sendMessage(chatId, `✅ Вы установлены как владелец BladeVisuals.\n\nТеперь вам будут приходить заявки из поддержки.\n\nКоманды:\n/reply <юзернейм или ID> <текст> — ответить пользователю\n/id — узнать свой chat ID`);
    return;
  }

  if (chatId != OWNER_CHAT_ID) {
    await sendMessage(chatId, 'Ваше сообщение получено. Владелец свяжется с вами.');
    return;
  }

  // Владелец отвечает пользователю
  if (text.startsWith('/reply ')) {
    const parts = text.split(' ');
    const target = parts[1];
    const replyText = parts.slice(2).join(' ');
    if (!target || !replyText) {
      await sendMessage(chatId, 'Использование: /reply @username или ID текст');
      return;
    }
    await sendMessage(target, `<b>📨 Ответ от техподдержки BladeVisuals:</b>\n\n${escapeHtml(replyText)}`);
    await sendMessage(chatId, `✅ Ответ отправлен ${escapeHtml(target)}`);
  } else if (text === '/id') {
    await sendMessage(chatId, `Ваш chat ID: <code>${chatId}</code>`);
  } else {
    await sendMessage(chatId, 'Команды:\n/reply <юзернейм или ID> <текст> — ответить пользователю\n/id — узнать свой chat ID');
  }
}

async function handleCallback(cq) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cq.id, text: 'Используйте команду /reply' })
  });
}

function sendMessage(chatId, text) {
  return fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

app.listen(3000, () => console.log('Server running on http://localhost:3000'));
