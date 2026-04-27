const express = require('express');
const mysql = require('mysql2/promise');
const multer = require('multer');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = 3000;

const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'cyber_zavhoz'
};

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const tokens = new Map();

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Нет токена' });
  const token = header.replace('Bearer ', '');
  const user = tokens.get(token);
  if (!user) return res.status(401).json({ error: 'Неверный токен' });
  req.user = user;
  next();
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `item_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

let db;
async function initDB() {
  db = await mysql.createPool(DB_CONFIG);
  console.log('БД подключена');
  // История изменений
  await db.query(`CREATE TABLE IF NOT EXISTS item_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    item_id INT,
    user_login VARCHAR(50),
    action VARCHAR(50),
    action_label VARCHAR(100),
    changes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // Права пользователей
  try {
    await db.query(`ALTER TABLE users ADD COLUMN permissions JSON`);
  } catch(e) {}
  // Папка uploads
  if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
}

async function logHistory(itemId, userLogin, action, actionLabel, changes) {
  try {
    await db.query(
      'INSERT INTO item_history (item_id, user_login, action, action_label, changes) VALUES (?, ?, ?, ?, ?)',
      [itemId, userLogin, action, actionLabel, changes ? JSON.stringify(changes) : null]
    );
  } catch(e) {}
}

// === АВТОРИЗАЦИЯ ===
app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const [rows] = await db.query(
      'SELECT * FROM users WHERE login = ? AND password = ?',
      [login, password]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const user = rows[0];
    const token = `${user.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    tokens.set(token, { id: user.id, login: user.login, role: user.role, fullName: user.full_name });
    res.json({ token, role: user.role, fullName: user.full_name, login: user.login });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === ИМУЩЕСТВО ===
app.get('/api/items', auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const sql = q
      ? `SELECT * FROM items WHERE name LIKE ? OR code LIKE ? OR location LIKE ? ORDER BY updated_at DESC`
      : `SELECT * FROM items ORDER BY updated_at DESC`;
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/items/code/:code', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM items WHERE code = ?', [req.params.code]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/items/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/items', auth, async (req, res) => {
  try {
    const { code, name, category, location, responsible, notes, status } = req.body;
    const [result] = await db.query(
      'INSERT INTO items (code, name, category, location, responsible, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [code, name, category || '', location || '', responsible || '', notes || '', status || 'active']
    );
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [result.insertId]);
    await logHistory(result.insertId, req.user.login, 'create', 'Добавлено', { name, code, location });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Код уже существует' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/items/:id', auth, async (req, res) => {
  try {
    const { code, name, category, location, responsible, notes, status } = req.body;
    const [oldRows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    await db.query(
      'UPDATE items SET code=?, name=?, category=?, location=?, responsible=?, notes=?, status=? WHERE id=?',
      [code, name, category || '', location || '', responsible || '', notes || '', status || 'active', req.params.id]
    );
    const [rows] = await db.query('SELECT * FROM items WHERE id = ?', [req.params.id]);
    const old = oldRows[0] || {};
    const changes = {};
    if (old.location !== location) changes['Местонахождение'] = `${old.location} → ${location}`;
    if (old.responsible !== responsible) changes['Ответственный'] = `${old.responsible} → ${responsible}`;
    if (old.status !== status) changes['Статус'] = `${old.status} → ${status}`;
    await logHistory(req.params.id, req.user.login, 'update', 'Изменено',
      Object.keys(changes).length > 0 ? Object.entries(changes).map(([k,v]) => `${k}: ${v}`).join('; ') : null);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/items/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT name, code FROM items WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
    if (rows[0]) await logHistory(req.params.id, req.user.login, 'delete', 'Удалено', { name: rows[0].name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === ИСТОРИЯ ===
app.get('/api/items/:id/history', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM item_history WHERE item_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// === ЭКСПОРТ В PDF (универсальный) ===
async function generateCodeImage(code, type) {
  if (type === 'barcode') {
    return await bwipjs.toBuffer({
      bcid: 'code128', text: code, scale: 2, height: 12,
      includetext: false,
    });
  }
  const dataUrl = await QRCode.toDataURL(code, { width: 200, margin: 1 });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function streamPdf(items, options, res) {
  const { type = 'qr', size = 'small', showName = true } = options;
  const sizeMap = { small: 60, medium: 100, large: 150 };
  const codeW = sizeMap[size] || 60;
  const codeH = type === 'barcode' ? codeW * 0.4 : codeW;

  const doc = new PDFDocument({ margin: 20, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${type}-codes.pdf`);
  doc.pipe(res);

  const margin = 20;
  const pageW = doc.page.width - margin * 2;
  const pageH = doc.page.height - margin * 2;
  const cellW = codeW + 20;
  const cellH = codeH + (showName ? 30 : 16);
  const cols = Math.max(1, Math.floor(pageW / cellW));
  const rows = Math.max(1, Math.floor(pageH / cellH));
  const perPage = cols * rows;

  for (let i = 0; i < items.length; i++) {
    const idxOnPage = i % perPage;
    if (i > 0 && idxOnPage === 0) doc.addPage();

    const col = idxOnPage % cols;
    const row = Math.floor(idxOnPage / cols);
    const cellX = margin + col * cellW;
    const cellY = margin + row * cellH;
    const imgX = cellX + (cellW - codeW) / 2;
    const imgY = cellY + 4;

    try {
      const buf = await generateCodeImage(items[i].code, type);
      doc.image(buf, imgX, imgY, { width: codeW, height: codeH });
    } catch (e) { console.error('img err', e.message); }

    doc.fontSize(7).fillColor('#000').text(
      items[i].code, cellX, imgY + codeH + 2, { width: cellW, align: 'center' }
    );
    if (showName && items[i].name) {
      doc.fontSize(6).fillColor('#666').text(
        items[i].name.substring(0, 28), cellX, imgY + codeH + 12, { width: cellW, align: 'center' }
      );
    }
  }

  doc.end();
}

// Экспорт существующих позиций
app.get('/api/export/qr', async (req, res) => {
  try {
    const type = req.query.type === 'barcode' ? 'barcode' : 'qr';
    const size = ['small', 'medium', 'large'].includes(req.query.size) ? req.query.size : 'small';
    let items;
    if (req.query.ids) {
      const ids = req.query.ids.split(',').map(Number).filter(Boolean);
      if (ids.length === 0) return res.status(400).json({ error: 'Пустой список' });
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await db.query(`SELECT code, name FROM items WHERE id IN (${placeholders}) ORDER BY name`, ids);
      items = rows;
    } else {
      const [rows] = await db.query('SELECT code, name FROM items ORDER BY name');
      items = rows;
    }
    if (items.length === 0) return res.status(404).json({ error: 'Нет данных' });
    await streamPdf(items, { type, size, showName: true }, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка генерации PDF' });
  }
});

// Генерация новых пустых кодов
app.get('/api/export/generate', async (req, res) => {
  try {
    const count = Math.min(Math.max(parseInt(req.query.count) || 10, 1), 200);
    const prefix = (req.query.prefix || 'ИНВ-').substring(0, 20);
    const start = parseInt(req.query.start) || 1;
    const pad = parseInt(req.query.pad) || 3;
    const type = req.query.type === 'barcode' ? 'barcode' : 'qr';
    const size = ['small', 'medium', 'large'].includes(req.query.size) ? req.query.size : 'small';

    const items = [];
    for (let i = 0; i < count; i++) {
      const num = String(start + i).padStart(pad, '0');
      items.push({ code: `${prefix}${num}`, name: '' });
    }
    await streamPdf(items, { type, size, showName: false }, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка генерации PDF' });
  }
});

// === ФОТО ===
app.post('/api/items/:id/photo', auth, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const filename = req.file.filename;
    const [rows] = await db.query('SELECT photo FROM items WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].photo) {
      const oldPath = path.join(__dirname, 'uploads', rows[0].photo);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.query('UPDATE items SET photo = ? WHERE id = ?', [filename, req.params.id]);
    res.json({ photo: filename, url: `/uploads/${filename}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

// === КОДЫ === (без auth — только генерируют картинки по коду из БД)
app.get('/api/items/:id/qr', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT code FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    const buffer = await QRCode.toBuffer(rows[0].code, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации QR' });
  }
});

app.get('/api/items/:id/barcode', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT code FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    const buffer = await bwipjs.toBuffer({
      bcid: 'code128', text: rows[0].code, scale: 3, height: 15,
      includetext: true, textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации штрихкода' });
  }
});

// === ГЕНЕРАЦИЯ ОТДЕЛЬНОГО QR/ШТРИХКОДА ПО КОДУ (для preview) ===
app.get('/api/code/qr/:code', async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(req.params.code, { width: 400, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) { res.status(500).end(); }
});

app.get('/api/code/barcode/:code', async (req, res) => {
  try {
    const buffer = await bwipjs.toBuffer({
      bcid: 'code128', text: req.params.code, scale: 3, height: 15,
      includetext: true, textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (e) { res.status(500).end(); }
});

// === ПОЛЬЗОВАТЕЛИ (admin) ===
app.get('/api/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const [rows] = await db.query('SELECT id, login, full_name, role, permissions, created_at FROM users');
    const result = rows.map(u => ({
      ...u,
      permissions: u.permissions ? (typeof u.permissions === 'string' ? JSON.parse(u.permissions) : u.permissions) : { can_add: true, can_edit: true, can_delete: false, can_export: true }
    }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const { login, password, full_name, role } = req.body;
    const [result] = await db.query(
      'INSERT INTO users (login, password, full_name, role) VALUES (?, ?, ?, ?)',
      [login, password, full_name, role || 'user']
    );
    res.json({ id: result.insertId, login, full_name, role: role || 'user' });
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    const { full_name, role, password } = req.body;
    const perms = req.body.permissions ? JSON.stringify(req.body.permissions) : null;
    if (password) {
      await db.query('UPDATE users SET full_name=?, role=?, password=?, permissions=? WHERE id=?', [full_name, role, password, perms, req.params.id]);
    } else {
      await db.query('UPDATE users SET full_name=?, role=?, permissions=? WHERE id=?', [full_name, role, perms, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нужны права администратора' });
    await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Ошибка запуска:', err);
});