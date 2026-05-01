# Кибер-Завхоз — серверная часть

REST API на Node.js + Express + MySQL для мобильного приложения учёта имущества.

## Требования

- **Ubuntu 22.04+** или Windows 10+
- **Node.js 22+** ([nodejs.org](https://nodejs.org))
- **MySQL 8+**
- Открытый порт **3000** (или измените в `server.js`)

---

## Установка на Ubuntu (рекомендуется для продакшена)

### 1. Подключиться к серверу по SSH

```bash
ssh root@ВАШ_IP
```

### 2. Установить Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

### 3. Установить и настроить MySQL

```bash
apt install -y mysql-server
systemctl start mysql
systemctl enable mysql
mysql_secure_installation
```

В `mysql_secure_installation` на все вопросы можно отвечать `n` (для разработки).

### 4. Создать базу данных и пользователя

```bash
mysql -u root
```

В консоли MySQL:

```sql
CREATE DATABASE cyber_zavhoz CHARACTER SET utf8mb4;

-- Снижаем требования к паролю (для разработки)
SET GLOBAL validate_password.length = 4;
SET GLOBAL validate_password.policy = LOW;

-- Создаём пользователя или используем root
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'root1234';
FLUSH PRIVILEGES;

-- Создаём таблицы
USE cyber_zavhoz;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  login VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'editor',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) DEFAULT '',
  location VARCHAR(255) DEFAULT '',
  responsible VARCHAR(100) DEFAULT '',
  notes TEXT,
  status VARCHAR(50) DEFAULT 'active',
  photo VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO users (login, password, full_name, role)
  VALUES ('admin', 'admin', 'Администратор', 'admin');

EXIT;
```

> Таблица `item_history` создаётся автоматически при первом запуске сервера.

### 5. Скачать и собрать проект

```bash
cd /root
git clone https://github.com/mobil0/diplomcheck.git server
cd server
npm install
```

### 6. Настроить пароль БД

В `server.js` найти блок `DB_CONFIG`:

```js
const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: 'root1234',  // ← ваш пароль
  database: 'cyber_zavhoz'
};
```

### 7. Открыть порт 3000

```bash
ufw allow 3000
```

### 8. Запустить через PM2 (24/7 работа)

```bash
npm install -g pm2
pm2 start server.js --name kiber-zavhoz
pm2 save
pm2 startup
```

После последней команды скопируйте и выполните выведенную команду — это включит автозапуск после ребута сервера.

### Управление сервером

```bash
pm2 list                       # статус
pm2 logs kiber-zavhoz          # логи
pm2 restart kiber-zavhoz       # перезапуск
pm2 stop kiber-zavhoz          # остановить
```

---

## Установка на Windows (для локальной разработки)

### 1. Установить Node.js
Скачать с [nodejs.org](https://nodejs.org) — LTS версию.

### 2. Установить XAMPP (для MySQL)
Скачать с [apachefriends.org](https://www.apachefriends.org), установить, запустить **MySQL** через Control Panel.

### 3. Создать БД через phpMyAdmin
Открыть `http://localhost/phpmyadmin` → создать базу `cyber_zavhoz` → импортировать SQL-структуру (см. блок выше).

### 4. Запустить сервер

```cmd
cd C:\путь\к\папке\server
npm install
node server.js
```

Сервер запустится на `http://localhost:3000`.

---

## Проверка работы

```bash
curl http://localhost:3000/api/items
```

Должен вернуть `{"error":"Нет токена"}` — это значит сервер живой и требует авторизации.

Тестовый вход: `admin` / `admin`.

---

## Эндпоинты

| Метод | URL | Описание |
|---|---|---|
| POST | `/api/login` | Авторизация |
| GET | `/api/items` | Список имущества |
| GET | `/api/items/:id` | Карточка |
| POST | `/api/items` | Добавить (editor+) |
| PUT | `/api/items/:id` | Обновить (editor+) |
| DELETE | `/api/items/:id` | Удалить (admin) |
| GET | `/api/items/:id/qr` | Картинка QR-кода |
| GET | `/api/items/:id/barcode` | Картинка штрихкода |
| GET | `/api/items/:id/history` | История изменений |
| POST | `/api/items/:id/photo` | Загрузить фото |
| DELETE | `/api/items/:id/photo` | Удалить фото |
| GET | `/api/export/print` | HTML-страница для печати существующих |
| GET | `/api/export/print-generate` | HTML-страница для печати новых сгенерированных |
| GET | `/api/users` | Список пользователей (admin) |
| POST/PUT/DELETE | `/api/users[/:id]` | CRUD пользователей (admin) |

---

## Подключение мобильного клиента

В файле `mobile/src/api.js` поменять:

```js
let SERVER_URL = 'http://ВАШ_IP:3000';
```

Пересобрать APK:

```bash
cd mobile/android
./gradlew assembleRelease
```

APK будет в `android/app/build/outputs/apk/release/app-release.apk`.
