const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

puppeteer.use(StealthPlugin());
process.env.NTBA_FIX_350 = '1';

// ---------- CONFIG FROM ENVIRONMENT ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = parseInt(process.env.CHAT_ID);

if (!BOT_TOKEN || !CHAT_ID) {
    console.error('❌ Missing BOT_TOKEN or CHAT_ID environment variables.');
    process.exit(1);
}
// ---------------------------------------------

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------- Queue System ----------
const jobQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || jobQueue.length === 0) return;
    isProcessing = true;
    const job = jobQueue.shift();
    try { await job(); } catch (err) { console.error('❌ Job failed:', err.message); }
    isProcessing = false;
    processQueue();
}

function addJob(fn) {
    jobQueue.push(fn);
    processQueue();
}

// ---------- Helper to build URL ----------
function makeChapterInfo(slug, chapterNumber) {
    const numStr = String(chapterNumber).padStart(2, '0');
    return {
        url: `https://manhwaread.com/manhwa/${slug}/chapter-${numStr}/`,
        name: `${slug}_ch${numStr}`
    };
}

// ---------- PDF Scraper (compressed) ----------
async function scrapeAndUploadPDF(url, chapterName, chatId) {
    console.log(`🌐 Processing ${chapterName}...`);
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'   // essential for Docker
        ]
    });
    const page = await browser.newPage();

    const collectedImages = [];

    page.on('response', async (response) => {
        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        const contentLength = parseInt(headers['content-length'] || '0', 10);
        if (response.status() < 200 || response.status() >= 300) return;
        if (!contentType.startsWith('image/')) return;
        if (contentLength > 0 && contentLength < 50000) return;

        const lowerUrl = response.url().toLowerCase();
        const bad = ['logo','icon','avatar','banner','header','footer','loader','placeholder','blank','loading','spinner','gravatar','rating','star','social','pixel','tracking','analytics'];
        if (bad.some(p => lowerUrl.includes(p))) return;

        try {
            const buffer = await response.buffer();
            collectedImages.push(buffer);
            console.log(`   🖼️  Captured image ${collectedImages.length}`);
        } catch (_) {}
    });

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        await page.evaluate(async () => {
            await new Promise(resolve => {
                let total = 0;
                const timer = setInterval(() => {
                    window.scrollBy(0, 500);
                    total += 500;
                    if (total >= document.body.scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 300);
            });
        });
        await new Promise(r => setTimeout(r, 3000));
    } finally {
        await browser.close();
    }

    const imageCount = collectedImages.length;
    if (imageCount === 0) {
        await bot.sendMessage(chatId, `❌ No images found for ${chapterName}.`);
        return;
    }
    await bot.sendMessage(chatId, `📸 ${chapterName}: captured ${imageCount} pages. Creating PDF...`);

    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < collectedImages.length; i++) {
        const raw = collectedImages[i];
        const compressed = await sharp(raw)
            .resize({ width: 1400, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        const image = await pdfDoc.embedJpg(compressed);
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save();
    const pdfPath = path.join(__dirname, `${chapterName}.pdf`);
    fs.writeFileSync(pdfPath, pdfBytes);

    await bot.sendMessage(chatId, `📤 Uploading PDF for ${chapterName}...`);
    const sentMsg = await bot.sendDocument(chatId, pdfPath);
    fs.unlinkSync(pdfPath);

    const fileId = sentMsg.document?.file_id;
    if (fileId) {
        const dbPath = path.join(__dirname, 'chapters_data.json');
        let db = {};
        if (fs.existsSync(dbPath)) {
            try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) {}
        }
        db[chapterName] = { type: 'pdf', file_id: fileId };
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        await bot.sendMessage(chatId, `✅ ${chapterName} done. file_id: \`${fileId}\``, { parse_mode: 'Markdown' });
    } else {
        await bot.sendMessage(chatId, `⚠️  PDF uploaded but could not retrieve file_id for ${chapterName}.`);
    }
}

// ---------- Command Handlers ----------
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "👋 **Hello!** I can scrape ManhwaRead chapters into PDFs.\n\n" +
        "**Commands:**\n" +
        "`/scrape series-slug chapter-number` – scrape one chapter\n" +
        "`/scraperange series-slug start end` – queue a range of chapters\n" +
        "`/check file_id` – verify a saved file\n\n" +
        "**Examples:**\n" +
        "`/scrape vacation-with-my-stepmom 05`\n" +
        "`/scraperange vacation-with-my-stepmom 1 20`",
        { parse_mode: 'Markdown' }
    );
});

bot.onText(/\/scrape (.+) (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const slug = match[1].trim();
    const chapterNum = parseInt(match[2]);
    const { url, name } = makeChapterInfo(slug, chapterNum);
    bot.sendMessage(chatId, `📥 Queued: *${name}*`, { parse_mode: 'Markdown' });
    addJob(async () => {
        await scrapeAndUploadPDF(url, name, chatId);
    });
});

bot.onText(/\/scraperange (.+) (\d+) (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const slug = match[1].trim();
    const start = parseInt(match[2]);
    const end = parseInt(match[3]);

    if (start > end) {
        bot.sendMessage(chatId, '❌ Start must be ≤ end.');
        return;
    }

    const total = end - start + 1;
    bot.sendMessage(chatId, `📚 Queuing ${total} chapters from ${slug} (ch${start} to ch${end})`);

    for (let i = start; i <= end; i++) {
        const { url, name } = makeChapterInfo(slug, i);
        addJob(async () => {
            await scrapeAndUploadPDF(url, name, chatId);
        });
    }
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const fileId = match[1].trim();
    try {
        const file = await bot.getFile(fileId);
        bot.sendMessage(chatId,
            `✅ **File exists!**\n📁 Path: \`${file.file_path}\`\n📦 Size: ${file.file_size} bytes`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        bot.sendMessage(chatId, `❌ File not accessible. Error: ${err.message}`);
    }
});

console.log('🤖 Bot is running... Use /scraperange to queue many chapters.');
