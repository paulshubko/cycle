# Цикл

Трекер менструального циклу за схемою SetFlow:

- **Застосунок** (`web/`) це статична сторінка на GitHub Pages. Відкриваєш у Safari, "Поділитися → На початковий екран", і він працює як звичайна програма, навіть офлайн.
- **Дані** спершу зберігаються на телефоні, тож усе працює миттєво і без інтернету.
- **Sync-сервер** (`server.js`) крутиться на Mac mini. Він тримає дані, повну історію змін з кожного пристрою і щоденні бекапи.

Підключення як у SetFlow: Профіль → адреса сервера → логін/пароль. Або "Працювати без акаунта", тоді дані лише на телефоні.

---

## 1. Сервер на Mac mini

### Docker (рекомендую, видно в Portainer)

```bash
# з Windows-ноутбука
scp -r cycle pavlo@100.109.154.103:~/cycle
ssh pavlo@100.109.154.103
cd ~/cycle && docker compose up -d --build
curl localhost:8790/api/health        # {"ok":true,"app":"cycle","signup":true}
```

### Або systemd, як setflow-sync

```bash
sudo mkdir -p /opt/cycle /var/lib/cycle && sudo chown pavlo /opt/cycle /var/lib/cycle
cp -r server.js web /opt/cycle/
node --version                         # потрібно 22.5+
sudo cp cycle.service /etc/systemd/system/ && sudo systemctl enable --now cycle
```

### Відкрити назовні через Tailscale Funnel

Корінь `macmini.tailf4703b.ts.net` уже зайнятий SetFlow, тому Цикл вішаємо на порт 8443:

```bash
sudo tailscale funnel --bg --https=8443 http://127.0.0.1:8790
tailscale funnel status
curl https://macmini.tailf4703b.ts.net:8443/api/health
```

**Адреса сервера для застосунку:** `https://macmini.tailf4703b.ts.net:8443`

## 2. Застосунок на GitHub Pages

1. Створи репозиторій `paulshubko/cycle`.
2. Залий туди **вміст** папки `web/`, щоб `index.html` лежав у корені.
3. Settings → Pages → Deploy from branch → `main` / root.
4. Через хвилину застосунок буде на `https://paulshubko.github.io/cycle/`.

```bash
cd cycle/web
git init -b main && git add . && git commit -m "Cycle web app"
git remote add origin git@github.com:paulshubko/cycle.git && git push -u origin main
```

> **Запасний варіант без GitHub.** Сервер сам роздає той самий застосунок. Можна просто відкрити `https://macmini.tailf4703b.ts.net:8443` і додати на головний екран. Адреса сервера тоді підставиться сама.

## 3. На телефоні

1. Відкрий `https://paulshubko.github.io/cycle/` у Safari.
2. Поділитися → На початковий екран.
3. Відкрий **з іконки** (у iOS у застосунку з головного екрана окреме сховище, не те, що в Safari).
4. Введи адресу сервера, потім "Створити акаунт". Перший акаунт стає власником, після цього реєстрація закривається.

На інших пристроях достатньо "Увійти" з тим самим логіном.

---

## Як працює синхронізація

- Кожна зміна дня має час редагування. Сервер приймає її, лише якщо вона новіша за ту, що в нього є (last-write-wins по днях). Тож два телефони не перетирають одне одному різні дні.
- Без мережі зміни стають у чергу ("⏳ 2 зміни в черзі") і відправляються, коли з'явиться зв'язок. Синк також запускається при відкритті застосунку і раз на 5 хвилин.
- Кожна зміна пишеться в історію з пристроєм і часом. На вкладці "Історія" будь-яку зміну можна відкотити, і відкат доїде на всі пристрої.
- Бекап бази робиться щодня в `data/backups/` (останні 30). Додатково можна вивантажити JSON/CSV у Профілі.

## Акаунти з консолі

```bash
docker exec -it cycle node server.js users
docker exec -it cycle node server.js adduser anna 'пароль-мін-8'
docker exec -it cycle node server.js passwd owner 'новий-пароль'   # розлогінює всі пристрої
```

## Відновлення з бекапу

```bash
docker compose stop
cp data/backups/cycle-2026-10-27.db data/cycle.db && rm -f data/cycle.db-wal data/cycle.db-shm
docker compose start
```

## Безпека

- Паролі зберігаються в scrypt, токени на сервері тільки як хеш.
- Після 5 невдалих входів IP блокується на 10 хвилин.
- CORS дозволений лише для `ALLOWED_ORIGINS`.
- Docker слухає тільки `127.0.0.1`, назовні сервер доступний виключно через Funnel (HTTPS).

## API

| Метод | Шлях | |
|---|---|---|
| GET | `/api/health` | перевірка, чи відкрита реєстрація |
| POST | `/api/register`, `/api/login` | `{username, password}` → `{token}` |
| POST | `/api/sync` | `{since, changes:[{day,data,ts}], settings?, settingsTs?}` → зміни з `seq > since` |
| GET | `/api/history?limit=&before=` | журнал змін |
| POST | `/api/history/:id/restore` | відкотити зміну |
| GET | `/api/devices` | пристрої з активними сесіями |
| POST | `/api/logout` | |

Авторизація: `Authorization: Bearer <token>`.
