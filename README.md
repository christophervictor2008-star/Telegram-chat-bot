# Telegram-chat-bot
## Telegram Claude Web3 Bot
A Telegram bot powered by Claude AI that can be added to groups and taught about your Web3 project.
Setup
1. Get your keys
Telegram token → message @BotFather → /newbot
Anthropic key  → https://console.anthropic.com
Your Telegram ID → message @userinfobot (for ADMIN_IDS)
2. Install & configure
npm install
cp .env.example .env
# Edit .env with your keys
3. Run
npm start
# or for auto-restart on changes:
npm run dev
Commands
Command
Who
Description
/setproject <name>
Group admins
Set the Web3 project name for this group
/teach <fact>
Group admins
Add a fact to the knowledge base
/info
Anyone
Show current project knowledge
/clearproject
Group admins
Remove all project knowledge
/clear
Anyone
Reset conversation history
/help
Anyone
Show all commands
Usage in Groups
Add the bot to your group
Make the bot an admin (so it can read messages)
Set your project: /setproject MyToken
Teach it facts one by one:
/teach The token ticker is $MYT
/teach Total supply is 100 million
/teach Contract address: 0x1234...abcd
/teach Staking APY is currently 18%
/teach The team is based in Singapore and founded in 2022
/teach Our DEX listing is on Uniswap v3
Members can now mention the bot or reply to its messages to ask questions:
@YourBot what's the staking APY?
@YourBot where is the token listed?
The bot only responds when mentioned (@BotName) or when someone replies to one of its messages — so it won't spam the group.
Knowledge persistence
Project knowledge is saved to knowledge.json in the same folder. Each group has its own independent knowledge base, so you can add the bot to multiple project groups.
Deploying (keep it running 24/7)
Railway (easiest):
Push to GitHub
Connect repo on railway.app
Add env vars in Railway dashboard
VPS with PM2:
npm install -g pm2
pm2 start bot.js --name web3bot
pm2 save && pm2 startup
