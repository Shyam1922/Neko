# Neko: one small image. There is no build step: tsx runs the TypeScript directly, as in development.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so editing source code doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The embedded database (used only when DATABASE_URL is unset) lives here; mount a volume to keep it.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "--import", "tsx", "src/server.ts"]
