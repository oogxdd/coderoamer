# Custom VM: архитектура, запуск и доступ

Этот документ объясняет реализацию ветки `feat/custom-vm-providers`: как
приложение подключается к обычному VPS, домашнему серверу или AWS EC2, зачем
нужны `AGENT_TOKEN`, AWS credentials и Tailscale auth key, а также какие части
ещё требуют доработки.

## Коротко

Приложение **не использует SSH как постоянный транспорт**. На Linux-машине
запускается `remote-agent`, а мобильный клиент обращается к нему по HTTP и
WebSocket с Bearer-аутентификацией.

```text
iPhone / Android
      │ HTTPS + WSS
      │ Authorization: Bearer AGENT_TOKEN
      ▼
Tailscale Funnel / Cloudflare Tunnel / reverse proxy
      ▼
remote-agent :8765
      ▼
PTY / shell / Claude Code / Codex / filesystem
```

`remote-agent` запускает команды от имени установившего его Linux-пользователя.
Поэтому доступ к `AGENT_TOKEN` фактически эквивалентен shell/SSH-доступу к этой
учётной записи.

## Что делает remote-agent

`remote-agent/` — Go-демон, реализующий используемую приложением часть Sprites
API:

- запуск одноразовых и фоновых команд;
- PTY-терминал поверх WebSocket;
- повторное подключение к работающей exec-сессии;
- ограниченный scrollback для переподключения;
- остановка exec-сессий и services;
- запись файлов;
- Bearer-аутентификация для HTTP и WebSocket.

Сегмент `:name` в `/sprites/:name/...` принимается для совместимости, но
игнорируется: один daemon представляет одну машину. Приложение добавляет к
указанному пользователем origin суффикс `/v1`; daemon принимает пути как с
`/v1`, так и без него.

Installer размещает бинарник и конфигурацию здесь:

```text
~/.remote-agent/remote-agent
~/.remote-agent/.env
~/.config/systemd/user/remote-agent.service
```

В `.env` хранятся `AGENT_TOKEN` и `PORT`. User-level systemd unit запускает
daemon на порту `8765`, автоматически перезапускает его и работает от имени
пользователя, выполнившего installer.

## Нужен ли SSH key

Для соединения мобильного приложения с VM — **нет**.

На уже существующей машине SSH обычно нужен только один раз: войти на неё,
склонировать repository и запустить installer.

```bash
git clone https://github.com/oogxdd/coderoamer
cd coderoamer/remote-agent
bash install.sh --tunnel=tailscale
```

После установки приложение работает через API `remote-agent`, а не через SSH.

SSH key для GitHub — отдельная вещь. Его можно создать внутри VM, если проекты
клонируются по `git@github.com:...`. Он не участвует в соединении приложения с
daemon.

В текущем AWS flow есть важное ограничение: низкоуровневый EC2 client умеет
передавать `KeyName`, но UI его не запрашивает, а `launchInstance()` не передаёт
его в `RunInstances`. Созданный приложением instance поэтому по умолчанию не
получает EC2 SSH key pair. Для восстановления после неудачного bootstrap стоит
добавить выбор key pair или доступ через AWS Systems Manager.

## Три разных секрета

### AGENT_TOKEN

Это пароль мобильного приложения к `remote-agent`. Он передаётся как:

```http
Authorization: Bearer <AGENT_TOKEN>
```

Для существующей машины installer генерирует 256-битный токен:

```bash
openssl rand -hex 32
```

Полученный URL и токен пользователь вручную вставляет в приложение. На native
платформах connection list, включая токены, хранится в Expo SecureStore.

В AWS flow приложение создаёт `AGENT_TOKEN` заранее и передаёт его instance через
EC2 user-data. Сейчас для этого используется `Math.random()`, который не является
криптографически стойким генератором. Перед production-релизом его следует
заменить на `expo-crypto.getRandomBytes()` или аналогичный CSPRNG.

### AWS Access Key ID и Secret Access Key

Эти credentials нужны только для EC2 control plane:

- `RunInstances`;
- `DescribeInstances`;
- `StartInstances`;
- `StopInstances`;
- `TerminateInstances`;
- `CreateTags`.

Они сохраняются в SecureStore телефона. Приложение самостоятельно формирует
AWS SigV4 requests и не использует AWS SDK или промежуточный backend.

AWS credentials не заменяют `AGENT_TOKEN`: первые управляют жизненным циклом
EC2, второй разрешает выполнение команд внутри созданной машины.

### Tailscale auth key

Ключ вида `tskey-...` позволяет headless-машине присоединиться к tailnet без
browser login:

```bash
tailscale up --authkey "$TS_AUTHKEY" --ssh
```

Этот ключ также не заменяет `AGENT_TOKEN`. Tailscale обеспечивает сетевой путь и
TLS, а daemon отдельно проверяет Bearer token.

## Как используется Tailscale

Текущий installer запускает Tailscale Funnel:

```bash
tailscale funnel --bg 8765
```

В результате появляется HTTPS-адрес примерно такого вида:

```text
https://machine-name.tailnet-name.ts.net
```

Важно: **Tailscale Funnel публикует сервис в открытый интернет**. Телефон не
обязан находиться в том же tailnet; доступ к command API защищает прежде всего
`AGENT_TOKEN`. Это отличается от Tailscale Serve, который ограничивает доступ
устройствами tailnet.

Официальное описание различия:

- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) —
  публичный internet endpoint;
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) — доступ
  внутри tailnet.

Для production UI желательно явно разделить режимы:

- **Private** — `tailscale serve 8765`, телефон подключён к tailnet;
- **Public** — `tailscale funnel 8765`, endpoint публичный и защищён сильным
  `AGENT_TOKEN`.

Сейчас UI называет Funnel просто `Tailscale`, поэтому пользователь может не
понять, что endpoint доступен из интернета.

## Existing machine: последовательность запуска

Для существующего VPS или домашнего сервера:

1. Пользователь входит на Linux-машину самостоятельно.
2. Запускает `remote-agent/install.sh`.
3. Installer получает или собирает статический Go binary.
4. Генерирует `AGENT_TOKEN` и записывает `.env`.
5. Создаёт и запускает systemd user service.
6. По выбору настраивает Tailscale Funnel, Cloudflare Tunnel или LAN-only.
7. Печатает Base URL и `AGENT_TOKEN`.
8. Пользователь выбирает `Add → Add Custom VPS → Existing machine` и вставляет
   напечатанные значения.

После этого custom machine появляется в общем списке рядом со Sprites.

У manual installer есть operational caveat: он включает systemd user unit, но
не вызывает `loginctl enable-linger`. На некоторых дистрибутивах такой service
после reboot не запустится до login пользователя. AWS bootstrap включает linger
отдельно; manual flow стоит сделать таким же.

## AWS EC2: последовательность запуска

Задуманный AWS flow выглядит так:

1. Пользователь вводит scoped IAM credentials, region, AMI, instance type и,
   при необходимости, Tailscale auth key.
2. Приложение заранее создаёт `AGENT_TOKEN`.
3. Приложение подписывает `RunInstances` через AWS SigV4.
4. В EC2 user-data передаются токен и bootstrap-команды.
5. Instance клонирует repository, запускает `install.sh` и поднимает tunnel.
6. Connection с `instanceId` и `AGENT_TOKEN` сохраняется сразу, ещё без URL.
7. После запуска tunnel пользователь добавляет его Base URL в connection.
8. Приложение начинает использовать VM через обычный `remote-agent` protocol.

Код для `StartInstances`, `StopInstances`, ожидания EC2 state и terminate уже
существует. Однако dashboard сейчас подключает только launch и terminate:
заявленные в документации Sleep/Wake ещё не доведены до UI.

## Как запускаются Claude и Codex

`remote-agent` не содержит Claude Code или Codex. Он выполняет команды,
присылаемые приложением, например:

```bash
cd /home/sprite/project
claude -p --output-format stream-json ...
```

или:

```bash
codex exec --json ...
```

На custom VM должны быть установлены сами CLI и нужные им runtimes. Текущий
installer устанавливает `remote-agent`, tunnel software и, при необходимости,
Go, но не устанавливает Claude Code или Codex CLI. Поэтому свежий AWS instance
может предоставить рабочий shell terminal, но chat вернёт `command not found`,
пока agent CLI не будет установлен.

Claude credentials приложение может лениво записать в `~/.sprite_env` или
`~/.claude/.credentials.json`. Для Codex предполагается `codex login`, который
можно пройти через terminal/account flow приложения.

## Что поддерживается не полностью

На момент ветки `feat/custom-vm-providers`:

- custom connections работают только в native iOS/Android build, не в web;
- Checkpoints и ttyd для custom VM скрыты, потому что daemon их не реализует;
- Go daemon покрыт интеграционными тестами;
- UI прошёл typecheck и lint, но не runtime-тест на simulator/device;
- реальные AWS, Tailscale и Cloudflare end-to-end сценарии ещё не проверены;
- AWS `AGENT_TOKEN` генерируется через `Math.random()`;
- EC2 launch не добавляет SSH key pair или SSM recovery path;
- Sleep/Wake реализованы в service layer, но не подключены к dashboard UI;
- Claude/Codex CLI не устанавливаются bootstrap-скриптом;
- ввод tunnel URL для provisioning AWS connection реализован через iOS-only
  `Alert.prompt`; Android flow пока незавершён.

Кроме того, пока feature branch не влита в default branch, команды bootstrap,
которые просто клонируют repository без `git checkout feat/custom-vm-providers`,
получат содержимое default branch. Для тестирования до merge нужно явно
checkout-нуть feature branch или передать bootstrap URL, указывающий на неё.

## Итог

Архитектурно custom VM — это не SSH connection, а небольшой self-hosted аналог
используемой части Sprites API:

- SSH нужен только для первоначальной ручной установки или аварийного доступа;
- Tailscale/Cloudflare/reverse proxy обеспечивают reachability и TLS;
- `AGENT_TOKEN` авторизует выполнение команд;
- AWS credentials управляют жизненным циклом EC2;
- Claude/Codex работают как процессы внутри VM и должны быть отдельно
  установлены и авторизованы.

Перед production-использованием приоритетны private Tailscale Serve mode,
криптографическая генерация токенов, recovery-доступ через SSH/SSM и полноценный
provisioning Claude/Codex.
