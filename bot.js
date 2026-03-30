require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const ADMIN_IDS      = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const BOT_NAME       = process.env.BOT_NAME || 'Web3Bot';
const MAX_HISTORY    = 20;
const KB_FILE        = path.join(__dirname, 'knowledge.json');

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.error('❌ Missing TELEGRAM_TOKEN or GROQ_API_KEY in .env');
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────
const bot  = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── Knowledge base (saved to disk) ───────────────────────────────────────────
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
  if (!isGroup(msg)) return true;
  if (isGlobalAdmin(msg.from.id)) return true;
  return isGroupAdmin(msg.chat.id, msg.from.id);
}

function shouldRespond(msg) {
  if (!isGroup(msg)) return true;
  if (msg.reply_to_message?.from?.is_bot) return true;
  return msg.text?.toLowerCase().includes(`@${BOT_NAME.toLowerCase()}`);
}

function stripMention(text) {
  return text.replace(new RegExp(`@${BOT_NAME}`, 'gi'), '').trim();
}

function send(chatId, text, replyId) {
  const opts = replyId ? { reply_to_message_id: replyId } : {};
  return bot.sendMessage(chatId, text, opts);
}

// ── System prompt ─────────────────────────────────────────────────────────────
function buildSystem(chatId) {
  const project = kb[chatId];

  let sys = `You are a smart, friendly Web3 assistant with deep general knowledge.
You understand blockchain, DeFi, NFTs, DAOs, wallets, tokens, smart contracts,
crypto trading, tokenomics, Layer 1 and Layer 2 networks, and the broader Web3 ecosystem.
You also have broad general AI knowledge and can answer everyday questions.
Be concise, accurate, and helpful. Use plain text only — no markdown or asterisks.
If you don't know something, say so honestly.`;

  if (project?.projectName) {
    sys += `

== PROJECT KNOWLEDGE: ${project.projectName} ==
The following facts were taught by the admins of this group.
Always use this info when answering questions about the project.
If a question about the project is not covered below, say you don't have that detail yet
and suggest the admin use /teach to add it.

${project.facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}

Last updated: ${project.updatedAt}`;
  }

  return sys;
}

// ── Ask Groq ──────────────────────────────────────────────────────────────────
async function askGroq(chatId, userText) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userText });
  trimHistory(history);

  const res = await groq.chat.completions.create({
    model:      'llama-3.3-70b-versatile',   // fast + capable, free on Groq
    max_tokens: 1024,
    messages: [
      { role: 'system', content: buildSystem(chatId) },
      ...history,
    ],
  });

  const reply = res.choices[0]?.message?.content || 'No response received.';
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Commands ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const text = isGroup(msg)
    ? `👋 Hey! I'm your Web3 AI assistant.\n\nMention me (@${BOT_NAME}) or reply to my messages to chat.\nAdmins: use /setproject and /teach to tell me about your project.`
    : `👋 Hi! I'm a Web3 AI assistant.\n\nI know about blockchain, DeFi, NFTs, crypto, and general topics too.\nType /help to see all commands.`;
  send(msg.chat.id, text);
});

bot.onText(/\/help/, (msg) => {
  send(msg.chat.id,
    `Commands:\n\n` +
    `/setproject <name>  — Set your Web3 project name\n` +
    `/teach <fact>       — Teach me a fact about your project\n` +
    `/info               — Show what I know about this project\n` +
    `/clearproject       — Remove all project knowledge\n` +
    `/clear              — Reset chat history\n` +
    `/help               — Show this message\n\n` +
    `In groups, mention @${BOT_NAME} or reply to my messages to chat.\n` +
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

  send(chatId,
    `Project set to: ${name}\n\n` +
    `Now teach me about it using:\n/teach <fact>\n\n` +
    `Examples:\n` +
    `/teach The token ticker is $XYZ\n` +
    `/teach Total supply is 100 million\n` +
    `/teach Contract address is 0x123...abc\n` +
    `/teach Listed on Uniswap v3`
  );
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

  send(chatId,
    `Got it! I now know ${kb[chatId].facts.length} fact(s) about ${kb[chatId].projectName}.\n` +
    `Keep adding more with /teach or check all facts with /info`
  );
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
    ``,
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
  send(msg.chat.id, 'Project knowledge cleared. Use /setproject to start fresh.');
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
    const reply = await askGroq(chatId, text);
    send(chatId, reply, group ? msg.message_id : undefined);
  } catch (err) {
    console.error('Groq error:', err.message);
    send(chatId, 'Something went wrong. Please try again.', msg.message_id);
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

console.log(`Bot running as @${BOT_NAME}   Ctrl+C to stop.`);
