FROM node:22-bookworm-slim AS build

WORKDIR /app/mcp-server

COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci

COPY mcp-server/tsconfig.json ./
COPY mcp-server/src ./src

RUN npm run build
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app/mcp-server

COPY --from=build /app/mcp-server/package.json ./
COPY --from=build /app/mcp-server/package-lock.json ./
COPY --from=build /app/mcp-server/node_modules ./node_modules
COPY --from=build /app/mcp-server/dist ./dist

COPY data/seed /app/data/seed

EXPOSE 3000

CMD ["node", "dist/index.js"]