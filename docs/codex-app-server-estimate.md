# Codex App-Server — оценка реализации

> Контекст: chat-way для Codex сейчас работает через `codex exec --json` (JSONL поверх
> одноразового exec-процесса). Главное ограничение — **нет streaming'а** текста
> ассистента: `agent_message` приходит целиком в `item.completed` в конце хода.
> Claude же стримит токен-за-токеном через `claude -p --output-format stream-json`.
> Чтобы догнать Claude по «живости», нужен Codex **app-server**
> (`codex app-server --stdio`, раньше обсуждался как `codex proto`) — процесс с
> JSON-RPC и инкрементальными событиями.

## Статус реализации

Ветка `codex-dev-server` реализует **первый practical cut**: cold-per-turn
`codex app-server --stdio` поверх существующего Exec WebSocket.

- `streamExec` получил stdin writer (`onStdinReady`) и отправляет payload в
  stream id `0`.
- `src/services/codex-app-server.ts` делает JSON-RPC handshake:
  `initialize` → `thread/start`/`thread/resume` → `turn/start`.
- `CodexStreamParser` теперь понимает app-server notifications
  (`item/agentMessage/delta`, reasoning deltas, command/file/MCP items,
  `turn/plan/updated`, `turn/completed`) и старый `codex exec --json` формат.
- `useChat` маршрутизирует Codex turns через app-server и завершает exec session
  после `turn/completed`, сохраняя reattach через `ActiveChatRun`.

Это **не** warm daemon и не per-chat service. Процесс остается одноразовым на ход,
чтобы не конфликтовать со sprite suspend model. Ниже сохранена исходная оценка
для более крупного persistent/warm эпика.

## Что даёт app-server (чего нет у `exec --json`)

- **Token-by-token streaming** ответа ассистента и reasoning (а не один блок в конце).
- **Долгоживущая сессия**: один процесс держит тред, не нужно `exec resume` на каждый ход
  (меньше холодных стартов, быстрее отклик).
- **Двусторонний протокол**: approvals/permission-запросы, interrupt, дозапросы —
  по JSON-RPC, а не только «выстрелил и читаешь stdout».
- **Структурные апдейты** item'ов (`item.updated`) с инкрементальным выводом команд.

## Архитектура, которую придётся завести

Сейчас транспорт — `api.streamExec(sprite, ['bash','-c', cmd], ...)`: один shot,
читаем stdout построчно (`CodexStreamParser`). App-server требует **persistent stdio
JSON-RPC поверх длительного процесса** внутри sprite. Это другой класс транспорта.

Варианты:

1. **`codex app-server --stdio` поверх exec-стрима** — запустить app-server как
   процесс в sprite, писать JSON-RPC в stdin, читать события из stdout. Проблема:
   текущий `streamExec` заточен под «команда → выход», нужен полнодуплексный канал
   (stdin писать в работающую сессию). Надо проверить, поддерживает ли наш sprite
   exec-API запись в stdin живого процесса (скорее всего нужен PTY/attach-канал,
   как у ttyd-терминала).
2. **`@openai/codex-sdk` (TS) внутри sprite** — обёртка-демон на Node, который держит
   тред и эмитит наши NDJSON-события наружу. Тогда RN-клиент по-прежнему читает NDJSON,
   но процесс — долгоживущий. Нужен способ слать новые промпты в этот демон (сокет/файл).

## Оценка трудозатрат (грубо)

| Блок | Сложность | ~Объём |
|---|---|---|
| Дуплексный транспорт (stdin в живой процесс / attach-сессия) | **высокая** — основной риск | 3–5 дн |
| JSON-RPC клиент + lifecycle сессии (start/turn/interrupt/close) | средняя | 2–3 дн |
| Маппинг streaming-событий app-server → `ChatContent` (дельты текста/reasoning) | низко-средняя (фундамент уже есть) | 1–2 дн |
| Reconnect/attach к живой сессии (как `ActiveChatRun` сейчас) | средняя | 1–2 дн |
| Approvals/permissions UI (если включать интерактив) | средняя, опционально | 2–3 дн |
| Тесты + откат на `exec --json` как fallback | низкая | 1 дн |

**Итого: ~1.5–2.5 недели** на одного разработчика для паритета с Claude по streaming,
**без** approvals-UI. С approvals — +0.5 недели.

**Главный риск и дев-блокер №1 был дуплексный канал в sprite.** Для cold-per-turn
варианта он закрыт добавлением stdin writer в `streamExec`. Для полноценного warm
daemon остаются вопросы lifecycle, interrupt/close и UI для approvals.

## Рекомендация

App-server оправдан, если streaming-ощущение критично. Текущая реализация берет
минимальный полезный срез: live text/reasoning deltas без warm process и без
Services API. Persistent app-server остается отдельным эпиком, если понадобится
убирать cold-start между быстрыми follow-up ходами.
