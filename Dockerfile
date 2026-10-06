FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY apps apps
COPY packages packages
RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp
RUN useradd --uid 501 --gid 20 --create-home --home-dir /home/social-cleanup social-cleanup
WORKDIR /app
COPY --from=build --chown=social-cleanup:20 /app /app
RUN npx playwright install --with-deps --only-shell chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

USER social-cleanup
EXPOSE 3000
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
