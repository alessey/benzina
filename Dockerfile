# Benzina: builds the client, then runs the game server, which serves the client and /ws.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY . .
RUN npm run build && node scripts/compress.mjs packages/client/dist

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV CLIENT_DIST=/app/packages/client/dist
COPY --from=build /app /app
EXPOSE 8080
CMD ["npx", "tsx", "packages/server/src/index.ts"]
