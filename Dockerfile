FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/collector.db
ENV PORT=3000
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./
VOLUME /data
EXPOSE 3000
CMD ["node", "build"]
