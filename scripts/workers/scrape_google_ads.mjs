// Scrape de Google Ads Transparency via Playwright
// Pega texto, media, formato (tab ativa), datas de cada card visivel

import fs from 'node:fs';
import { chromium } from 'playwright';

const payload = JSON.parse(process.env.PAYLOAD || '{}');
const inputs = payload.inputs || {};
const url = (inputs.google_ads_transparency_url || '').trim();

const result = {
    url,
    fetched: false,
    ads_count: 0,
    ads: { search: [], display: [], youtube: [], all: [] },
    counts: {},
};
const errors = [];

async function run() {
    if (!url) {
        console.log('[scrape_google_ads] sem url — skip');
        save();
        return;
    }

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
            viewport: { width: 1280, height: 900 },
            locale: 'pt-BR',
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(4000);

        // Faz scroll pra carregar mais cards (Transparency faz lazy load)
        for (let i = 0; i < 4; i++) {
            await page.evaluate(() => window.scrollBy(0, 800));
            await page.waitForTimeout(800);
        }

        // Extrai contagem das abas/filtros por formato
        const counts = await page.evaluate(() => {
            const out = {};
            // Normalmente aparece em um filtro/aba com "Search (N)", "Display (N)", "Video (N)"
            const candidates = Array.from(document.querySelectorAll('*'));
            for (const el of candidates) {
                const txt = (el.textContent || '').trim();
                if (txt.length > 100) continue;
                const m = txt.match(/(search|display|video|youtube|pesquisa|v[íi]deo)\s*\(?(\d+)\)?/i);
                if (m && !out[m[1].toLowerCase()]) {
                    out[m[1].toLowerCase()] = parseInt(m[2], 10);
                }
            }
            return out;
        });
        result.counts = counts;

        // Extrai cards. Seletores heurísticos — a estrutura real é instável, então
        // pega qualquer container com imagem + algum texto próximo.
        const ads = await page.evaluate(() => {
            // Candidatos: elementos com img + texto > 20 chars
            const results = [];
            const imgs = Array.from(document.querySelectorAll('img'));
            const seen = new Set();
            for (const img of imgs) {
                const src = img.src || '';
                if (!src || seen.has(src)) continue;
                // Pula icones (pequenos)
                const rect = img.getBoundingClientRect();
                if (rect.width < 80 || rect.height < 80) continue;
                seen.add(src);

                // Sobe até encontrar container razoável
                let container = img.parentElement;
                for (let i = 0; i < 4 && container; i++) {
                    const t = (container.textContent || '').trim();
                    if (t.length > 30) break;
                    container = container.parentElement;
                }
                if (!container) continue;

                const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
                const href = (container.querySelector('a')?.href) || null;

                // Pega datas se visíveis
                const dateMatch = text.match(/(\d{1,2}\s+de\s+\w+\s+de\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/g);

                // Tenta detectar tipo baseado em contexto do card
                let format = 'unknown';
                const lowText = text.toLowerCase();
                if (lowText.includes('youtube') || container.querySelector('video') || /ytimg|youtube/.test(src)) {
                    format = 'youtube';
                } else if (/tpc\.googlesyndication/.test(src)) {
                    format = 'display';
                }

                results.push({
                    text: text.slice(0, 600),
                    media: src,
                    href,
                    dates: dateMatch ? dateMatch.slice(0, 3) : [],
                    format,
                });
                if (results.length >= 25) break;
            }
            return results;
        });

        // Separa por formato
        for (const ad of ads) {
            result.ads.all.push(ad);
            if (ad.format === 'youtube') result.ads.youtube.push(ad);
            else if (ad.format === 'display') result.ads.display.push(ad);
            else result.ads.search.push(ad);
        }
        result.ads_count = ads.length;
        result.fetched = ads.length > 0;

    } catch (e) {
        errors.push({ stage: 'scrape_google_ads', message: `${e.name}: ${(e.message || '').slice(0, 200)}` });
    } finally {
        if (browser) await browser.close().catch(() => {});
    }

    save();
    console.log(`[scrape_google_ads] fetched=${result.fetched} ads=${result.ads_count}`);
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
    process.exit(0);
});
