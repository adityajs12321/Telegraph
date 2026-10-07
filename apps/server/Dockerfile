# Server build command: docker build -f apps/server/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/local-server/package.json apps/local-server/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npx tsc -b apps/server
RUN npm ci --omit=dev --ignore-scripts -w @telegraph/server

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
# use this btw (postgres://user:pass@host:5432/db).
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/server/dist/server.js"]
