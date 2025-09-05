const express = require('express');

const http = require('http');
const socketIo = require('socket.io');
cont TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Use environment variables for your bot token and chat ID
const token = process.env.TELEGRAM_BOT_TOKEN || 'PASTE-YOUR-BOT-TOKEN';
const chatId = process.env.TELEGRAM_CHAT_ID || 'PASTE-YOUR-CHAT-ID';

const bot = new TelegramBot(token, { polling: true });

// Relay messages from the web chat to Telegram
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('chat message', (msg) => {
    bot.sendMessage(chatId, msg);
  });
});

// Relay messages from Telegram back to the web chat
bot.on('message', (msg) => {
  io.emit('telegram message', {
    from: msg.from.username || msg.from.first_name,
    text: msg.text,
  });
});
// Use Render’s assigned port if present, otherwise default to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
