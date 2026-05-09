# 6aclass.online — refactored package

Я разнёс огромные HTML-файлы на отдельные CSS/JS-файлы. Поведение сайта должно остаться тем же, но теперь структуру проще чинить.

## Что изменено

- `index.html` — главная страница, стили вынесены в `assets/css/home.css`, логика в `assets/js/home/*`.
- `index5.html` — чат, стили вынесены в `assets/css/chat.css`, логика в `assets/js/chat/*`.
- `index4.html` — карточные игры, стили вынесены в `assets/css/games.css`, логика в `assets/js/games/*`.
- `mafia.html` — страница мафии, стили вынесены в `assets/css/mafia.css`, логика в `assets/js/mafia/app.js`.
- `server.py` оставлен в корне: GitHub Pages его не запускает, он нужен для Render/другого backend-хостинга.
- `_backup_original/` содержит исходные HTML до разделения. Не загружай эту папку как рабочую замену, это просто страховка.

## Как проверить локально

Открой папку в терминале и запусти:

```bash
python -m http.server 5500
```

Потом открой:

```text
http://localhost:5500/index.html
http://localhost:5500/index5.html
http://localhost:5500/index4.html
http://localhost:5500/mafia.html
```

## Что важно

1. Не удаляй старую рабочую версию на GitHub, пока локально не проверишь этот архив.
2. На GitHub Pages работает только фронтенд: HTML/CSS/JS/картинки.
3. `server.py` должен запускаться на Render, а не на GitHub Pages.
4. Если после загрузки на GitHub что-то не работает, первым делом открой DevTools → Console.

## Следующий нормальный шаг

После проверки структуры надо чинить фото отдельно:

1. Проверить `/api/health` backend-а.
2. Проверить `/api/upload`.
3. Проверить отправку одного фото в группу.
4. Проверить отправку одного фото в ЛС.
5. Только потом трогать галерею, голосовые и оформление.
