# Stage 1: Build native addons
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Stage 2: Production runtime
FROM node:20-slim AS prod
WORKDIR /app
COPY --from=builder /app ./
ENTRYPOINT ["node"]
CMD ["bin/mempalace.js"]

# Stage 3: Development runtime
FROM node:20-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
ENTRYPOINT ["node"]
CMD ["--watch", "bin/mempalace.js"]
