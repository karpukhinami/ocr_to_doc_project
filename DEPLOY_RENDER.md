# Деплой на Render (из GitHub/GitLab/Bitbucket)

Ниже — как выложить этот проект на [Render](https://render.com) без установки Docker на ваш компьютер: сборка идёт в облаке Render из репозитория.

## Что вам понадобится

- Аккаунт на [render.com](https://render.com) (можно через GitHub).
- Репозиторий с этим кодом на **GitHub**, **GitLab** или **Bitbucket**.
- Ключ **OpenRouter** ([openrouter.ai](https://openrouter.ai/keys)) — без него распознавание работать не будет.

---

## Как хранить секреты на Render

Render не хранит секреты в `render.yaml` в репозитории — это правильно: в git не кладут API-ключи.

### Где задавать переменные

1. **Dashboard** → ваш **Web Service** → вкладка **Environment**.
2. Добавьте переменные вручную. Для чувствительных данных включайте **«Secret»** (или экранирование значения), чтобы ключ не отображался в логах в открытом виде при просмотре (Render помечает такие переменные как секреты).

### Какие переменные считать секретами

| Переменная | Секрет? | Описание |
|------------|---------|----------|
| `OPENROUTER_API_KEY` | **Да** | Ключ OpenRouter. Обязательно только через Environment, никогда в git. |
| `CORS_ORIGINS` | Обычно нет | Публичный URL сайта; секретом делать не обязательно, но можно. |
| Остальные (`OPENROUTER_MODEL`, `TMP_ROOT`, …) | Нет | Не секреты, можно задать в Blueprint или в UI. |

### Синхронизация с `render.yaml`

В [render.yaml](render.yaml) для ключей с `sync: false` Render **не подставляет** значение из файла — место «зарезервировано», значение **задаётся только в Dashboard**. Это как раз для секретов.

После первого деплоя откройте **Environment** и добавьте:

- `OPENROUTER_API_KEY` = ваш ключ (как Secret).
- `CORS_ORIGINS` = `https://<имя-сервиса>.onrender.com` (подставьте реальный URL из вкладки **Settings** → **URL**). После смены URL перезапуск не всегда обязателен, но при проблемах с CORS сделайте **Manual Deploy → Clear build cache & deploy** или просто **Restart**.

---

## Вариант A — Blueprint из репозитория (рекомендуется)

1. Запушьте проект в GitHub (в корне должны быть `Dockerfile`, `render.yaml`).
2. Зайдите на [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
3. Подключите репозиторий и выберите ветку (например `main`).
4. Render прочитает `render.yaml` и предложит создать сервис `ocr-to-doc`.
5. **Перед деплоем** (или сразу после создания) откройте сервис → **Environment** → добавьте:
   - `OPENROUTER_API_KEY`
   - `CORS_ORIGINS` = `https://<ваш-сервис>.onrender.com`
6. Нажмите **Apply** / сохраните переменные и дождитесь деплоя (**Logs**).

---

## Вариант B — только Web Service без Blueprint

1. **New** → **Web Service**.
2. Подключите репозиторий, ветку.
3. Настройки:
   - **Runtime**: **Docker**
   - **Dockerfile path**: `Dockerfile`
   - **Docker context**: `.` (корень репозитория)
4. **Instance type**: **Free** (если доступно для Docker).
5. **Health Check Path**: `/api/health`
6. В **Environment** добавьте переменные (см. таблицу ниже).
7. **Create Web Service**.

---

## Минимальный набор переменных окружения на Render

| Ключ | Пример / значение |
|------|-------------------|
| `OPENROUTER_API_KEY` | `sk-or-...` (секрет) |
| `CORS_ORIGINS` | `https://ocr-to-doc.onrender.com` — **точный** URL вашего приложения |

Опционально:

| Ключ | По умолчанию |
|------|----------------|
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | `qwen/qwen3-vl-235b-a22b-instruct` |
| `MAX_UPLOAD_MB` | `25` |
| `OPENROUTER_TIMEOUT_SEC` | `300` |
| `PANDOC_TIMEOUT_SEC` | `120` |
| `TMP_ROOT` | `/app/tmp` (уже в Dockerfile / render.yaml) |

---

## Порт и Docker

Render передаёт переменную **`PORT`**. В [Dockerfile](Dockerfile) приложение запускается так:

`uvicorn ... --port ${PORT:-8000}`

Так что менять Dockerfile вручную под Render не нужно.

---

## Проверка после деплоя

1. Откройте в браузере `https://<ваш-сервис>.onrender.com` — должна открыться страница приложения.
2. Проверьте API: `https://<ваш-сервис>.onrender.com/api/health` → `{"status":"ok"}`.

Если фронт грузится, а запросы к API падают с CORS — проверьте, что `CORS_ORIGINS` **точно** совпадает с origin страницы (схема `https`, без лишнего слэша в конце, если вы так не копировали).

---

## Бесплатный план и «сон»

На **Free** инстанс Render **засыпает** при простое (первый запрос после паузы может быть долгим — cold start). Это ограничение платформы, не бага проекта.

---

## Обновления из Git

При пуше в подключённую ветку Render обычно **автоматически** пересобирает и деплоит (**Auto-Deploy** включён в `render.yaml`). При необходимости отключите или деплойте вручную в **Manual Deploy**.

---

## Частые проблемы

- **Build failed / timeout** — первый Docker-образ долго собирается (Node + npm + Python + Pandoc). Повторите деплой или увеличьте таймаут в настройках сервиса, если Render это позволяет.
- **502 после сна** — подождите 30–60 секунд и обновите страницу (пробуждение Free-инстанса).
- **OpenRouter errors** — проверьте `OPENROUTER_API_KEY` и баланс/лимиты на OpenRouter.
