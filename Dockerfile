FROM node:20-slim

# Install system dependencies needed by better-sqlite3 native bindings
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copy prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source
COPY . .

# Create required directories
RUN mkdir -p storage/audio storage/transcripts logs

EXPOSE 3000

# Run migration then start server
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx src/server.ts"]
