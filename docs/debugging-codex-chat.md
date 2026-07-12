# Дебаг Codex Legacy / Codex Live чата

Гайд для веток `debug-codex`+: как локально наблюдать за обоими Codex-транспортами
(`Codex` = legacy `codex exec --json`, `Codex Server`/`Codex Live` = `codex app-server --stdio`)
и что мне присылать, если что-то не работает.

Всё описанное ниже логирование включается только при `__DEV__` (т.е. когда клиент
запущен через `npx expo start` / `npm run web`, не в TestFlight/production-сборке)
и только для codex-провайдеров — Claude не трогали.

## 1. Запуск клиента

Чат не использует нативные модули (Skia/WebView — это только вкладки
Stream terminal / ttyd), так что удобнее всего дебажить в браузере, без симулятора:

```bash
npm run web   # = node scripts/ws-proxy.js & expo start --web
```

`ws-proxy.js` нужен, потому что браузер не может слать `Authorization` в
WebSocket-хендшейке — прокси добавляет токен как заголовок для `/v1/sprites/{name}/exec`,
через который идут оба Codex-транспорта (`src/services/api.ts` → `streamExec`).

## 2. Клиентские логи (браузерная консоль)

Все теги пишутся через `console.log`, фильтруйте консоль по префиксу:

- `[chat-debug]` — общий лог хука `useChat` (`src/hooks/useChat.ts`): таймstamps
  `executeTurn`/`exec event`/`stdout parsed`/`codex thread started`/`codex turn completed`/
  `codex error event` и т.д.
  - Новое: `stdout raw` — теперь пишет **сырой** контент stdout-чанка (до 4000 символов,
    с редакцией секретов), а не только список типов распарсенных событий — раньше сырых
    данных в консоли не было вообще, только ярлыки событий.
  - Новое: `debug logging <provider> ~/.sprites-chat-debug/<name>.*` — печатается один раз
    в начале хода, показывает точный путь к файлам на спрайте для этого хода (см. ниже).
- `[codex-app-server]` — новый лог в `src/services/codex-app-server.ts`: каждая
  JSON-RPC строка, отправленная (`→`) и полученная (`←`) в хендшейке
  `initialize → thread/start|resume → turn/start` и в нотификациях
  (`item/agentMessage/delta`, `turn/completed`, ошибки). Раньше этот файл вообще
  ничего не логировал.

## 3. Логи на спрайте

Для каждого хода (`executeTurn`) в `~/.sprites-chat-debug/` на **том самом спрайте**,
где выполняется чат, появляются файлы с именем `<provider>-<userMessageId>` (provider —
`codex` для Legacy, `codexAppServer` для Live):

| Файл | Что внутри |
|---|---|
| `<name>.cmd.log` | Точная команда хода (после подстановки модели/effort/резюма сессии), с таймстампом. Секреты (Bearer/API-ключи) вырезаны. |
| `<name>.stdout.log` | Всё, что процесс написал в stdout — то же самое, что видит клиент по exec-каналу. |
| `<name>.stderr.log` | Всё, что процесс написал в stderr (heartbeat-точки, ошибки CLI, auth-сообщения). |
| `<name>.rpc.jsonl` | Только для Codex Live: каждая JSON-RPC-рамка в обе стороны — `{"ts","dir":"to-app-server"\|"from-app-server","line"}` — построчно, отдельно от `.stdout.log`, который смешивает это с остальным выводом node-обёртки. |

Реализация: `withSpriteDebugLogging` в `src/services/chat-helpers.ts` — оборачивает
итоговую команду через `exec > >(tee …) 2> >(tee … >&2)`, так что stdout/stderr не
смешиваются (важно: именно по этому признаку клиент отличает heartbeat/auth-ошибки от
обычного вывода), но каждый байт дополнительно уходит в файл. Для Codex Live путь к
`.rpc.jsonl` прокидывается через `CODEX_RPC_LOG` в node-обёртку
(`buildCodexAppServerCommand`), которая логирует туда каждый JSON-RPC фрейм.

Директория ничем не ограничена по размеру — если она разрастётся, просто удалите:
`rm -rf ~/.sprites-chat-debug`.

## 4. Как подключиться к нужному спрайту и смотреть вживую

Нужен **второй** канал в тот же спрайт, пока с телефона/веба идёт ход. Самый надёжный
способ — то, что уже есть в приложении, ничего дополнительно поднимать не надо:

1. Откройте чат нужного спрайта → 🕓 (иконка часов в хедере чата) → **Sessions & terminals**.
2. Откройте **Stream terminal** (реальный TTY по WebSocket на `/v1/sprites/{name}/exec` —
   `src/app/(app)/exec-poc.tsx`). Он не мешает уже идущему ходу — это отдельная exec-сессия.
3. Если предпочитаете компьютер — то же самое можно через Sprites CLI/SSH, если у вас
   настроен доступ к этому спрайту (см. `README.md` → Quick start, шаг про SSH-ключ).

В этом терминале, пока идёт ход:

```bash
# найти самые свежие debug-файлы этого хода
ls -lt ~/.sprites-chat-debug | head

# смотреть всё вживую
tail -f ~/.sprites-chat-debug/*.log

# только JSON-RPC трафик Codex Live
tail -f ~/.sprites-chat-debug/*.rpc.jsonl

# что вообще происходит с процессами
ps aux | grep -E 'codex|node'

# активна ли heartbeat-задача этого хода (значит, ход ещё жив на спрайте)
curl -s --unix-socket /.sprite/api.sock http://sprite/v1/tasks

# собственный on-disk транскрипт Codex (пишется и Legacy, и Live —
# это то же самое, что реально видит `codex --resume`)
ls -la ~/.codex/sessions/$(date +%Y)/$(date +%m)/$(date +%d)/
tail -f ~/.codex/sessions/$(date +%Y)/$(date +%m)/$(date +%d)/rollout-*.jsonl

# быстрая проверка авторизации, если подозреваете auth-issue
codex login status
```

(Это уже упомянуто в `docs/codex-app-server-estimate.md` / `codex-sessions.ts` — rollout
живёт по пути `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<threadId>.jsonl`.)

## 5. Что присылать для дебага

Для конкретного сломанного хода:

1. Какой провайдер (Codex Legacy vs Codex Live) и в чём именно проявился баг
   (что видно в UI vs что ожидалось).
2. Дамп браузерной консоли за этот ход, отфильтрованный по `[chat-debug]` и
   `[codex-app-server]`.
3. Содержимое `~/.sprites-chat-debug/<name>.cmd.log`, `.stdout.log`, `.stderr.log`
   и (для Live) `.rpc.jsonl` — можно просто `cat` их в терминале и скопировать,
   или переслать файлы.

Этого достаточно, чтобы сопоставить: что реально ушло на сервер → что реально
пришло назад → что из этого распарсил клиент → что показал UI.
