FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# build tools for better-sqlite3 (falls back to compile if no prebuilt binary)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# persist the SQLite DB on a mounted volume at /app/data
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
