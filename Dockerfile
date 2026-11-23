# Mavi ERP — multi-stage deployment image (Render, Suga.run, Railway, Fly, or VPS)
FROM node:20-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-slim

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data

ENV NODE_ENV=production
# Safe V8 heap target for 512MB+ containers handling base64 receipt/design uploads and SQLite buffers.
ENV NODE_OPTIONS=--max-old-space-size=256
ENV PORT=3000
ENV DB_PATH=/data/mavi.db

# Data must live on a mounted volume so orders, receipts, and ledgers survive redeploys.
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/bootstrap.js"]
