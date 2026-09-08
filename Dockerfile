# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Install build dependencies for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin/ ./bin/
COPY src/ ./src/

ENV NODE_ENV=production
VOLUME ["/root/.seb"]

ENTRYPOINT ["node", "bin/seb.mjs"]
CMD ["chat"]
