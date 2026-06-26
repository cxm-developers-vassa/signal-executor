# signal-executor — карта проекта

> Торговый бот на NestJS + TypeScript: читает торговые сигналы из MySQL
> (их кладёт отдельный .NET-бэкенд) и управляет ордерами фьючерсов
> USDT-M на бирже BingX. Разработка и тесты — на демо-счёте VST
> (виртуальные деньги). Цель обучения: выйти на уровень Node.js-разработчика
> для рынка труда (EU/US remote).

---

## 1. Цели

- **Учебная:** освоить Node.js / NestJS / TypeScript до job-ready уровня
  (опыт в .NET уже есть — переносим концепции: DI, модули, декораторы, ORM).
- **Продуктовая:** автономный бот, который по сигналу открывает позицию
  лимитными ордерами, ведёт её (перестановка, TP/SL) и закрывает с прибылью.
- **Принцип безопасности:** всё отрабатываем на VST (демо). Переход на
  реальные деньги — отдельное осознанное решение.

---

## 2. Технологический стек

| Слой | Выбор | Заметки |
|------|-------|---------|
| Рантайм | Node.js 22 LTS (через nvm) | есть и Node 24 для фронта |
| Фреймворк | NestJS + TypeScript | «ASP.NET для Node»: DI, модули, декораторы |
| БД | MySQL 8.4 в Docker | docker-compose, контейнер `signal-executor-db` |
| ORM | Prisma 7.8 | + адаптер `@prisma/adapter-mariadb` |
| HTTP к бирже | встроенный `fetch` | без axios |
| Планировщик | `@nestjs/schedule` | тик `@Interval(3000)` — «сердцебиение» |
| Конфиг | `@nestjs/config` | секреты в `.env` (в git НЕ попадает) |

---

## 3. Ключевые решения и нюансы (накопленный опыт)

### Prisma 7 (отличается от старых гайдов)
- `url` НЕ в `schema.prisma`, а в `prisma.config.ts`.
- Нужен `moduleFormat = "cjs"` в generator (иначе конфликт CJS/ESM).
- Нужен MariaDB-адаптер; параметры — объектом `{host, port, user, ...}`,
  не строкой подключения.
- Клиент генерируется в `generated/prisma` (в .gitignore).
- `migrate dev` сам генерирует клиент (отдельный `generate` не нужен).
- Отдельный `generate` нужен на свежем клоне / новой машине.
- После миграции в VS Code: `Cmd+Shift+P → Restart TS Server`, если
  новые поля «не видны».

### BingX API
- Подпись HMAC-SHA256; **параметры сортировать по алфавиту** перед подписью.
- Один API-ключ для демо и реала; разница ТОЛЬКО в base URL
  (`open-api-vst.bingx.com` = демо). Это защитный рубильник.
- USDT-M = пути `/openApi/swap/...`.
- Аккаунт в **hedge-режиме** (`dualSidePosition: true`):
  `positionSide` = LONG / SHORT; плечи раздельные (long и short отдельно).
- **Большие orderId/positionId — только как СТРОКИ** (JS number теряет
  точность на 19-значных числах). В ответах брать строковое поле `orderID`.
- Числа (цены/объёмы) приходят строками — приводить через `Number()`.
- `closePosition: true` в hedge-режиме капризен — для TP/SL надёжнее
  передавать `quantity`, а не `closePosition`.
- Закрытие = встречный ордер: закрыть LONG → `side=SELL, positionSide=LONG`.
  Тот же `placeOrder`, меняется только `side`.
- Cancel-and-Replace НЕ решает частичное исполнение сам — объём нового
  ордера задаёшь ты; есть `cancelRestrictions` (ONLY_NEW/...) и
  `cancelReplaceMode` (STOP_ON_FAILURE) против гонок.
- Лимит отмен: при большом числе ордеров и высокой доле отмен биржа может
  заблокировать открытие на ~10 мин → не переставлять впустую.
- Комиссии (из `getContractInfo`): maker 0.02%, taker 0.05%.
  Лимитные ордера → обычно maker.

### Рабочие привычки
- **Перед каждым `npm run start` — Cmd+Option+S (Save All).**
  Несохранённый файл = частая причина «не работает».
- Терминал — источник истины (важнее красных подчёркиваний в редакторе).
- Коммитить на каждой вехе; `.env` в .gitignore (проверено).

---

## 4. Архитектура

```
src/
  prisma/      — PrismaService + PrismaModule (@Global, отдаёт доступ к БД)
  bingx/       — BingxService (слой биржи) + BingxModule (exports BingxService)
  signals/     — приём сигналов (от .NET-бэка)
  trading/     — TradingService + TradingModule (ЛОГИКА БОТА, «тик»)
  app.module.ts — корень: Config, Schedule, Prisma, Signals, Bingx, Trading
prisma/
  schema.prisma — модели БД
  migrations/   — миграции
  seed.ts       — начальные данные (BotConfig + SymbolConfig)
prisma.config.ts — конфиг Prisma 7 (url, shadow, seed-команда)
.env            — секреты (НЕ в git)
```

### Слой биржи — методы BingxService (готовы, проверены на VST)
- Чтение: `getBalance`, `getPrice`, `getPositionMode`, `getContractInfo`,
  `getLeverage`, `getPositions`.
- Торговля: `setLeverage`, `testOrder`, `placeOrder` (лимит, вход и закрытие),
  `placeStopOrder` (TP/SL market с триггером), `queryOrder`, `cancelOrder`,
  `closePosition` (market по positionId).
- Вспомогательные «кирпичи»: `sign`, `buildQueryString` (сортировка + timestamp).

---

## 5. Модель данных (схема БД)

- **Signal** — входящие сигналы. `status`: NEW/PROCESSING/COMPLETED/
  CANCELLED/FAILED. Связь 1:1 с Trade.
- **BotConfig** — глобально: `budget` (USDT, = маржа), `conflictStrategy`
  (CONSERVATIVE/AGGRESSIVE), `isActive` (рубильник; в seed = false).
- **SymbolConfig** — на каждый символ: `leverage`, `budgetPercent`,
  `entryPriceOffsetPercent`, `repriceThresholdPercent`, `entryTimeoutSec`,
  `takeProfitPercent`, `stopLossPercent` (рабочие, лимитные),
  `safetyTpPercent`, `safetySlPercent` (страховочные, market).
- **Trade** — сделка / состояние конечного автомата. `status`: ENTERING/
  OPEN/CLOSING/CLOSED/CANCELLED/FAILED. Поля: targetQuantity, filledQuantity,
  avgEntryPrice, **effectiveEntryPrice** (с вшитой комиссией открытия),
  positionId (строка), takeProfitPrice, stopLossPrice, entryDeadline,
  realizedPnl, leverage, budgetPercent.
- **Order** — история всех ордеров. `purpose`: ENTRY/CLOSE/SAFETY_TP/
  SAFETY_SL. bingxOrderId (строка!), type, side, positionSide, price,
  quantity, status, executedQty, **commission** (фактическая, из биржи).
- Связи формальные (FK + навигация). Активный ордер ищем через таблицу
  Order по tradeId + статус (без дублирующей ссылки в Trade).

---

## 6. Логика бота (полная спецификация — ориентир)

> Реализуем ИТЕРАЦИЯМИ, но БД спроектирована сразу под всё.

### Принципы
- **Тик каждые 3 сек делает ОДИН шаг по каждой сделке и завершается;**
  состояние живёт в БД между тиками (бот «без памяти», читает состояние).
- **Перед каждым действием — сверка с биржей** (источник истины).
- **Все входы/выходы — ТОЛЬКО лимитные ордера.** Market — лишь в
  страховочных TP/SL.
- Конечный автомат (status в Trade) направляет, какой шаг делать.
- Защита от наложения тиков — флаг `isRunning` (замок) + try/finally.

### Управление капиталом
- `budget` = маржа (свои деньги); плечо умножает позицию (**Вариант A**):
  `маржа = budget × budgetPercent%` → `номинал = маржа × leverage`
  → `qty = номинал / price` → округлить ВНИЗ до quantityPrecision
  → проверить минимумы (tradeMinQuantity, tradeMinUSDT).
- Позиция = % бюджета (по умолчанию 100% = одна позиция; 50% = до двух).
- **Правило: один символ = одна позиция.** Дубль того же направления —
  игнор. Два LONG по одному символу нельзя.

### Вход (состояние ENTERING)
- Выставить лимит, **догонять до полного размера** при частичном исполнении
  (переставлять на остаток).
- Переставлять при **сдвиге цены за порог** (`repriceThresholdPercent`,
  per-symbol). Тик каждые 3 сек — ритм проверки.
- **Таймаут входа** (`entryTimeoutSec`): по истечении — отменить остаток,
  **вести набранное**.

### Ведение позиции (OPEN → CLOSING → CLOSED)
- Позиция набрана полностью → выставить страховочные market TP/SL
  (заведомо дальше: `safetyTpPercent` / `safetySlPercent`).
- **effectiveEntryPrice** = avgPrice с вшитой ФАКТИЧЕСКОЙ комиссией открытия
  (long: avgPrice + commission/qty; short — наоборот).
- Целевая цена закрытия = `effectiveEntryPrice × (1 ± takeProfitPercent%)`.
- Закрытие — лимитным ордером, переставляемым по ситуации.
- Комиссия закрытия учитывается в `realizedPnl` ПОСТ-ФАКТУМ.

### Конкуренция за бюджет (глобальная настройка A/B)
- Нет свободного бюджета ИЛИ противоположный сигнал по символу = конфликт:
  - **A (CONSERVATIVE):** закрыть позицию, только если можно в плюс;
    иначе игнор нового сигнала.
  - **B (AGGRESSIVE):** закрыть в любом случае и открыть новую.
  - Закрываем **самую прибыльную / наименее убыточную** позицию.
- «В плюс» считаем по effectiveEntryPrice ± желаемый %, не по сырому
  unrealizedProfit.

### Отложено (после MVP)
- Бюджет в % и несколько позиций; конкуренция A/B; развороты;
  фильтр/исследование рынка для оптимального момента входа (~5–10 мин).

---

## 7. План реализации (итерации)

**MVP — одна сделка от и до (без бюджета/конкуренции):**
1. ✅ Сердцебиение (`@Interval(3000)`, мгновенный первый тик через onModuleInit).
2. ✅ Чтение новых сигналов (status=NEW) в тике.
3. 🔜 Создание Trade из сигнала: расчёт targetQuantity, статус ENTERING,
   сигнал → PROCESSING. (Код написан, бот пока выключен.)
4. ⬜ Выставление входного ордера (setLeverage + placeOrder лимит).
5. ⬜ Ведение набора: перестановка, частичное исполнение, таймаут.
6. ⬜ TP/SL + ведение лимитного закрытия.
7. ⬜ Завершение сделки (CLOSED, сигнал COMPLETED, realizedPnl).

**Следующие итерации:** бюджет/мультипозиции → конкуренция A/B →
развороты → фильтр входа.

**Фаза D (позже):** деплой на сервер 24/7 (лучше Linux; Docker делает
OS-агностично; прод — `prisma migrate deploy`, статический IP в whitelist
ключа, секреты не в коде).

---

## 8. Где мы сейчас

- Фундамент готов: окружение, NestJS, MySQL/Docker, полный слой биржи
  (проверен на VST), полная схема БД, настройки засеяны (seed).
- Сердцебиение тикает, читает сигналы.
- Написан код создания Trade из сигнала (шаг 3) — **компилируется,
  бот пока выключен (isActive=false)**.
- **Ближайший шаг:** включить бота (isActive=true) и проверить, что
  тик создаёт Trade из сигнала (появляются записи в таблице Trade,
  сигналы → PROCESSING). Затем — шаг 4 (выставление входного ордера).

---

## 9. Полезные команды

```bash
npm run start                              # запуск приложения
npx prisma migrate dev --name <имя>        # изменить схему + миграция + клиент
npx prisma db seed                         # засеять начальные данные
docker ps                                  # проверить контейнер MySQL
docker exec signal-executor-db mysql -uroot -prootpass \
  -e "CREATE DATABASE IF NOT EXISTS prisma_shadow;"   # теневая БД (миграции)
```

Горячие клавиши VS Code: **Cmd+Option+S** (Save All),
**Cmd+Shift+P → Restart TS Server** (сбросить «призрачные» ошибки).