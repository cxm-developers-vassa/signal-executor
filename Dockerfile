# ===== Этап 1: сборка =====
FROM node:22-slim AS builder

# Prisma требует OpenSSL для генерации клиента
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала только манифесты — для кеширования слоя зависимостей
COPY package*.json ./

# Ставим ВСЕ зависимости (включая dev — нужны для сборки)
RUN npm ci

# Копируем исходники
COPY . .

# Генерируем Prisma-клиент (под Linux-контейнер!)
RUN npx prisma generate

# Собираем NestJS (получаем dist/)
RUN npm run build

# ===== Этап 2: запуск =====
FROM node:22-slim AS runner

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Только манифесты и продакшн-зависимости
COPY package*.json ./
RUN npm ci --omit=dev

# Копируем из этапа сборки: собранный код, сгенерированный клиент, prisma-файлы
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Запуск: применяем миграции, затем стартуем бота
CMD npx prisma migrate deploy && node dist/src/main