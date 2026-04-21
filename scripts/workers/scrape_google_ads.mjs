// Scrape de Google Ads Transparency via Playwright
// Input: env PAYLOAD com JSON {inputs:{google_ads_transparency_url}}
// Output: google_ads.json com ads extraidos
// Fail-mode: registra errors.json e sai com 0 (continue-on-error)

import fs from 'node:fs';
import { chromium } from 'playwright';

const payload = JSON.parse(process.env.PAYLOAD || '{}');
const inputs = payload.inputs || {};
const url = (inputs.google_ads_transparency_url || '').trim();

const result = { url, fetched: false, ads: { search: [], display: [], youtube: [] } };
const errors = [];

async function run() {
    if (!url) {
        console.log('[scrape_google_ads] sem url — skip');
        return;
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

        // Espera conteudo renderizar — Transparency Center eh Angular-like
        await page.waitForTimeout(3500);

        // Tenta encontrar contadores por tipo
        const counts = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('button, [role="tab"], a'));
            const out = {};
            for (const el of labels) {
                const txt = (el.textContent || '').trim().toLowerCase();
                const m = txt.match(/(search|display|video|youtube|pesquisa|v[íi]deo|todos|all)\s*\(?\s*(\d+)/i);
                if (m) out[m[1]] = parseInt(m[2], 10);
            }
            return out;
        });
        result.counts = counts;

        // Extrai cards de anuncio visiveis
        const ads = await page.evaluate(() => {
            // Seletores heurísticos — estrutura muda, ajusta conforme precisa
            const cards = Array.from(document.querySelectorAll('[role="listitem"], [role="article"], .ad-card, creative-preview'));
            const out = [];
            for (const c of cards.slice(0, 15)) {
                const txt = (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500);
                const img = c.querySelector('img')?.src || null;
                out.push({ text: txt, media: img });
            }
            return out;
        });

        result.ads.search = ads; // Fase 1: sem distincao por tipo, coloca tudo em search
        result.fetched = true;
        result.ads_count = ads.length;

        // Screenshot de debug (commit nao é ideal mas ajuda quando falha)
        // await page.screenshot({ path: 'google_ads_screenshot.png' });

    } catch (e) {
        errors.push({ stage: 'scrape_google_ads', message: `${e.name}: ${(e.message || '').slice(0, 200)}` });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    save();
    console.log(`[scrape_google_ads] fetched=${result.fetched} ads=${result.ads_count || 0}`);
}

function save() {
    fs.writeFileSync('google_ads.json', JSON.stringify(result), 'utf-8');
    if (errors.length) {
        let prev = [];
        if (fs.existsSync('errors.json')) {
            try { prev = JSON.parse(fs.readFileSync('errors.json', 'utf-8')); } catch {}
        }
        prev.push(...errors);
        fs.writeFileSync('errors.json', JSON.stringify(prev), 'utf-8');
    }
}

run().catch((e) => {
    errors.push({ stage: 'scrape_google_ads', message: `FATAL: ${e.message}` });
    save();
    // nao trava workflow — continue-on-error cuida
    process.exit(0);
});
