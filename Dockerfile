FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --include=optional --no-audit --no-fund \
 && npm install --no-save --package-lock=false "@rollup/rollup-linux-x64-gnu@$(node -p "require('./node_modules/rollup/package.json').version")"
COPY apps/api ./apps/api
COPY apps/web ./apps/web
RUN npm run build:web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng poppler-utils postgresql-client tar \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --omit=dev && npm cache clean --force
COPY apps/api/src ./apps/api/src
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV PORT=4000
ENV WEB_DIST_DIR=/app/apps/web/dist
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","--workspace","apps/api","start"]
