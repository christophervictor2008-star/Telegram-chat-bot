require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_NAME       = process.env.BOT_NAME || 'Web3Bot'; // your bot's username WITHOUT @
const MAX_HISTORY    = 30;
const KB_FILE        = path.join(__dirname, 'knowledge.json');

if (!TELEGRAM_TOKEN || !ANTHROPIC_KEY) {
  console.error('❌  Missing TELEGRAM_TOKEN or ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────
const bot       = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── Knowledge base (persisted to disk) ───────────────────────────────────────
// { [chatId]: { projectName, facts: string[], updatedAt } }
function loadKB() {
  try { return JSON.parse(fs.readFileSync(KB_FILE, 'utf8')); }
  catch { return {}; }
}
function saveKB(kb) { fs.writeFileSync(KB_FILE, JSON.stringify(kb, null, 2)); }
let kb = loadKB();

// ── Conversation history ──────────────────────────────────────────────────────
const sessions = new Map();
function getHistory(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, []);
  return sessions.get(chatId);
}
function trimHistory(h) {
  while (h.length > MAX_HISTORY) h.splice(0, 2);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isGroup = (msg) =>
  msg.chat.type === 'group' || msg.chat.type === 'supergroup';

async function isGroupAdmin(chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(m.status);
  } catch { return false; }
}

function isGlobalAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

async function canTeach(msg) {
  if (!isGroup(msg)) return true;                         // DMs always allowed
  if (isGlobalAdmin(msg.from.id)) return true;
  return isGroupAdmin(msg.chat.id, msg.from.id);
}

// Only respond in groups when mentioned or replied-to
function shouldRespond(msg) {
  if (!isGroup(msg)) return true;
  if (msg.reply_to_message?.from?.is_bot) return true;
  const mentioned = msg.text?.toLowerCase().includes(`@${BOT_NAME.toLowerCase()}`);
  return !!mentioned;
}

function stripMention(text) {
  return text.replace(new RegExp(`@${BOT_NAME}`, 'gi'), '').trim();
}

function send(chatId, text, replyId) {
  const opts = replyId ? { reply_to_message_id: replyId } : {};
  return bot.sendMessage(chatId, text, opts);
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystem(chatId, group) {
  const project = kb[chatId];

  let sys = `You are a knowledgeable Web3 assistant${group ? ' in a Telegram group' : ''}.
You understand blockchain, DeFi, NFTs, DAOs, wallets, tokens, smart contracts, and crypto.
Be concise and accurate. Use plain text only — no markdown or asterisks.`;

  if (project?.projectName) {
    sys += `

== Project: ${project.projectName} ==
The following facts have been taught by the admins. Use them to answer questions accurately.
If something is not covered, say you don't have that detail yet and suggest admins use /teach.

${project.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}
(Last updated: ${project.updatedAt})`;
  } else if (group) {
    sys += `

No project has been configured for this group yet.
Admins can use /setproject and /teach to add knowledge about their Web3 project.`;
  }

  return sys;
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function askClaude(chatId, text, group) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: text });
  trimHistory(history);

  const res = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system:     buildSystem(chatId, group),
    messages:   history,
  });

  const reply = res.content.map(b => b.text ?? '').join('');
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const text = isGroup(msg)
    ? `👋 Hey! I'm your Web3 assistant powered by Claude AI.\n\nMention me (@${BOT_NAME}) or reply to my messages to chat.\n\nAdmins: use /setproject and /teach to tell me about your project.`
    : `👋 Hi! I'm a Web3 assistant powered by Claude AI.\n\nAsk me anything about blockchain, DeFi, NFTs, wallets, or crypto projects.\n\nType /help to see all commands.`;
  send(msg.chat.id, text);
});

bot.onText(/\/help/, (msg) => {
  send(msg.chat.id,
    `Commands:\n\n` +
    `/setproject <name>  — Set your project name\n` +
    `/teach <fact>       — Teach me a fact about your project\n` +
    `/info               — Show what I know about this project\n` +
    `/clearproject       — Remove all project knowledge\n` +
    `/clear              — Reset chat history\n` +
    `/help               — Show this message\n\n` +
    `In groups, mention @${BOT_NAME} or reply to my messages to talk to me.\n` +
    `Only group admins can use /setproject, /teach, and /clearproject.`
  );
});

// /setproject <name>
bot.onText(/\/setproject(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const name   = match?.[1]?.trim();

  if (!name)
    return send(chatId, 'Usage: /setproject <Project Name>', msg.message_id);
  if (!(await canTeach(msg)))
    return send(chatId, 'Only group admins can set the project.', msg.message_id);

  if (!kb[chatId]) kb[chatId] = { facts: [] };
  kb[chatId].projectName = name;
  kb[chatId].updatedAt   = new Date().toISOString();
  saveKB(kb);

  send(chatId, `Project set to: ${name}\n\nNow use /teach <fact> to add knowledge about it.`);
});

// /teach <fact>
bot.onText(/\/teach(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fact   = match?.[1]?.trim();

  if (!fact)
    return send(chatId, 'Usage: /teach <a fact about your project>', msg.message_id);
  if (!(await canTeach(msg)))
    return send(chatId, 'Only group admins can teach me facts.', msg.message_id);
  if (!kb[chatId]?.projectName)
    return send(chatId, 'Set a project first with: /setproject <name>', msg.message_id);

  kb[chatId].facts.push(fact);
  kb[chatId].updatedAt = new Date().toISOString();
  saveKB(kb);

  send(chatId, `Learned! I now know ${kb[chatId].facts.length} fact(s) about ${kb[chatId].projectName}.`);
});

// /info
bot.onText(/\/info/, (msg) => {
  const project = kb[msg.chat.id];
  if (!project?.projectName)
    return send(msg.chat.id, 'No project set yet. Use /setproject <name> to get started.');

  const lines = [
    `Project: ${project.projectName}`,
    `Facts (${project.facts.length}):`,
    ...project.facts.map((f, i) => `  ${i + 1}. ${f}`),
    `Updated: ${project.updatedAt}`,
  ];
  send(msg.chat.id, lines.join('\n'));
});

// /clearproject
bot.onText(/\/clearproject/, async (msg) => {
  if (!(await canTeach(msg)))
    return send(msg.chat.id, 'Only group admins can clear the project.', msg.message_id);

  delete kb[msg.chat.id];
  saveKB(kb);
  send(msg.chat.id, 'Project knowledge cleared.');
});

// /clear
bot.onText(/\/clear/, (msg) => {
  sessions.delete(msg.chat.id);
  send(msg.chat.id, 'Chat history cleared!');
});

// ── Main chat handler ─────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!shouldRespond(msg)) return;

  const chatId = msg.chat.id;
  const group  = isGroup(msg);
  const text   = stripMention(msg.text);
  if (!text) return;

  bot.sendChatAction(chatId, 'typing');

  try {
    const reply = await askClaude(chatId, text, group);
    send(chatId, reply, group ? msg.message_id : undefined);
  } catch (err) {
    console.error('Claude error:', err.message);
    send(chatId, 'Something went wrong. Please try again.', msg.message_id);
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

console.log(`Bot running as @${BOT_NAME}   Ctrl+C to stop.`);
