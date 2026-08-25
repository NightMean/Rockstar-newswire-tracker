FROM node:22-slim

# Install google-chrome-stable and fonts to support major charsets (Chinese, Japanese,
# Arabic, Hebrew, Thai and a few others). Puppeteer is configured below to use this
# system Chrome instead of downloading its own bundled Chromium.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use the system Chrome; skip Puppeteer's own Chromium download
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./

# npm ci installs exactly what package-lock.json pins
RUN npm ci

COPY . .

# Pre-create the feeds output directory writable by the runtime user
# (the container runs as 'node', which cannot write into the root-owned app dir)
RUN mkdir -p /usr/src/app/feeds && chown node:node /usr/src/app/feeds

# Liveness probe for orchestrators: /healthz answers as soon as the HTTP
# server is up (token fetch may take a while, hence the generous start period)
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run as the unprivileged 'node' user; Chrome launches with --no-sandbox
USER node

# Expose port (if RSS is enabled)
EXPOSE 3000

CMD [ "node", "index.js" ]
