# Play Store Release Guide — CodeRoamer

- Android: первый в истории проекта AAB собран под com.digital.coderoamer: https://expo.dev/artifacts/eas/8WMoLei-vn8LAxL2fP4OEbtaI-krphJqN0qSy5RGMkA.aab

Теперь про Play Store — тут, в отличие от iOS, Google не позволяет создать приложение и загрузить первую версию через API/CLI. Первый релиз обязательно нужно загрузить вручную
через веб-консоль. Дальше пошагово:

## 1. Создать аккаунт разработчика (если ещё нет)

play.google.com/console → регистрация, разовый взнос $25, верификация личности (может занять от пары часов до нескольких дней).

## 2. Создать приложение

Play Console → "Create app":
- Название: CodeRoamer
- Package name: com.digital.coderoamer (задаётся автоматически из первого загруженного AAB и потом навсегда неизменяем)
- Тип: приложение / бесплатное

## 3. Заполнить обязательные разделы (без них релиз не пропустят)

- App content: privacy policy URL, content rating (анкета), target audience, data safety form
- Store listing: описание, скриншоты (минимум для телефона), иконка, feature graphic

## 4. Загрузить первый билд — Internal testing track

Play Console → Testing → Internal testing → Create release → загрузить скачанный .aab (скачай по ссылке выше) → добавить список email-тестеров → Save → Review → Rollout.
Это самый быстрый трек (публикуется за минуты, без ревью), идеально для "сначала для теста".

## 5. Путь к продакшну

Google требует последовательного прохождения (нельзя прыгнуть сразу в Production для нового аккаунта разработчика — есть period "closed testing 14 дней с 12+ тестерами" перед
открытием production для новых аккаунтов):

Internal testing → Closed testing (14 дней, ≥12 активных тестеров) → Open testing (опционально) → Production

В консоли есть кнопка "Promote release" — переносит уже загруженный билд между треками без повторной загрузки.

## 6. На будущее — автоматизация через eas submit

После того как приложение создано в Play Console вручную один раз:
1. Play Console → Setup → API access → создать service account в Google Cloud, дать роль "Release manager"
2. Скачать JSON-ключ
3. Добавить в eas.json:

```json
"submit": {
  "production": {
    "android": { "serviceAccountKeyPath": "./path-to-key.json", "track": "internal" }
  }
}
```

После этого eas submit --platform android будет заливать билды автоматически, без захода в консоль.

Хочешь, я добавлю этот serviceAccountKeyPath-конфиг в eas.json заранее (ключ добавишь сам, когда сгенерируешь), чтобы дальше просто eas submit работал одной командой?
