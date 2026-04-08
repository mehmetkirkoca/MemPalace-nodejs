FROM node:20-alpine
RUN apk add --no-cache python3 make g++ curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENTRYPOINT ["node", "bin/mempalace.js"]
