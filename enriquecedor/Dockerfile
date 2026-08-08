# Motor de enriquecimento (server/index.mjs) — deploy no Railway.
# Imagem oficial do Playwright: traz o Chromium + dependências de sistema na
# MESMA versão do package.json (1.61.1). Não usar `playwright install` aqui.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts

# O motor só precisa da pasta server/ (o site é buildado no Vercel).
COPY server ./server

# Chromium não roda como root com sandbox; a imagem traz o usuário pwuser.
USER pwuser

# Railway injeta PORT; o motor usa PORT || ENRICH_PORT || 3011.
CMD ["node", "server/index.mjs"]
