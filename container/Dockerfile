# Playwright's image ships Chromium, its system libraries and Xvfb.
# The playwright npm version in package.json must match this tag.
FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY *.js ./
COPY entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production \
    PORT=3847 \
    STATE_DIR=/data \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

VOLUME ["/data"]
EXPOSE 3847

# Headed Chromium under a virtual display looks far more like a normal browser
# than headless does.
CMD ["/app/entrypoint.sh"]
