# Build stage: compile TS -> dist, keep production deps only.
FROM node:24 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.check.json ./
COPY src ./src
# `npm run build` runs scripts/copy-assets.mjs, so the build stage needs that
# one file (the rest of scripts/ stays out of the context — see .dockerignore).
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
# NOTE (necessary): AGENT.md is a runtime asset — GET /AGENT.md serves it from
# dist/, and the build fails without this COPY (a silent stale image resulted
# the one time it was missing).
COPY AGENT.md ./AGENT.md
# `npm run build` also copies non-TS runtime assets (e.g. dist/db/schema.sql,
# which the DB reads next to dist/db/index.js) — see scripts/copy-assets.mjs.
RUN npm run build && npm prune --omit=dev

# Runtime: Debian-based node:24 (not Alpine) — the capture pipeline launches
# the `chrome` channel (Google Chrome), which has no musl/Alpine build.
FROM node:24
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget ca-certificates fonts-liberation \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
        libdrm2 libgbm1 libnspr4 libnss3 libx11-6 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Static assets served from dist-relative paths (GET /icon.png reads /app/public/icon.png).
COPY public ./public
RUN useradd -m webcap && mkdir -p /data && chown webcap /data
USER webcap
# Playwright records video (POST /v1/x402/video, /v1/video) through its own
# bundled ffmpeg, which the system Chrome .deb does not provide. Installed as
# webcap so it lands in /home/webcap/.cache/ms-playwright/ffmpeg-<build>,
# where recordVideo looks it up at runtime. Without this every video call 502s.
RUN node_modules/.bin/playwright-core install ffmpeg
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/main.js"]
