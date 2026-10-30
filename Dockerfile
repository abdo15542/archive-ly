FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng poppler-utils postgresql-client tar  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --omit=dev
COPY apps/api ./apps/api
COPY apps/web ./apps/web
ENV PORT=4000
EXPOSE 4000
CMD ["npm","--workspace","apps/api","start"]
