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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
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

// === ЭКСПОРТ QR в PDF ===
app.get('/api/export/qr', auth, async (req, res) => {
  try {
    let items;
    if (req.query.ids) {
      const ids = req.query.ids.split(',').map(Number).filter(Boolean);
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await db.query(`SELECT * FROM items WHERE id IN (${placeholders}) ORDER BY name`, ids);
      items = rows;
    } else {
      const [rows] = await db.query('SELECT * FROM items ORDER BY name');
      items = rows;
    }

    const doc = new PDFDocument({ margin: 20, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=qr-codes.pdf');
    doc.pipe(res);

    const cols = 3;
    const pageW = doc.page.width - 40;
    const colW = pageW / cols;
    const qrSize = 90;
    const cellH = qrSize + 36;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const col = i % cols;
      const row = Math.floor(i / cols);

      if (i > 0 && col === 0) {
        const nextY = 20 + row * cellH;
        if (nextY + cellH > doc.page.height - 20) {
          doc.addPage();
        }
      }

      const pageRows = Math.floor((doc.y - 20) / cellH);
      const curRow = row - pageRows;
      const x = 20 + col * colW + (colW - qrSize) / 2;
      const baseY = col === 0 && row > 0 ? doc.y : 20 + Math.floor(i / cols) * cellH;
      const y = col === 0 ? (i === 0 ? 20 : doc.y + 10) : (doc.y > 20 ? doc.y : 20);

      try {
        const qrDataUrl = await QRCode.toDataURL(item.code, { width: qrSize, margin: 1 });
        const buf = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        doc.image(buf, x, col === 0 ? (i === 0 ? 20 : undefined) : undefined, { width: qrSize });
      } catch(e) {}

      doc.fontSize(7).fillColor('#333').text(item.code, 20 + col * colW, undefined, { width: colW, align: 'center' });
      doc.fontSize(6).fillColor('#666').text(item.name.substring(0, 30), 20 + col * colW, undefined, { width: colW, align: 'center' });
    }

    doc.end();
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

// === КОДЫ ===
app.get('/api/items/:id/qr', auth, async (req, res) => {
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

app.get('/api/items/:id/barcode', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT code FROM items WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Не найдено' });
    const buffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: rows[0].code,
      scale: 3,
      height: 15,
      includetext: true,
      textxalign: 'center'
    });
    res.set('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка генерации штрихкода' });
  }
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