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
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '7d', // фотки кэшируем
  immutable: true,
}));

// Все API-ответы — без кэша (актуальные данные)
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

const tokens = new Map();
// Кэш QR/штрихкодов в памяти — переиспользуем данные
const codeCache = new Map();
const CODE_CACHE_MAX = 2000;

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Нет токена' });
  const token = header.replace('Bearer ', '');
  const user = tokens.get(token);
  if (!user) return res.status(401).json({ error: 'Неверный токен' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}
const canEdit = requireRole('editor', 'admin');
const adminOnly = requireRole('admin');

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
  // Расширяем колонку role до 3 типов: viewer, editor, admin
  try {
    await db.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(20) DEFAULT 'editor'`);
  } catch(e) {}
  try {
    await db.query(`UPDATE users SET role = 'editor' WHERE role = 'user'`);
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
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '').trim();
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

app.post('/api/items', auth, canEdit, async (req, res) => {
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

app.put('/api/items/:id', auth, canEdit, async (req, res) => {
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

app.delete('/api/items/:id', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT name, code, photo FROM items WHERE id = ?', [req.params.id]);
    await db.query('DELETE FROM items WHERE id = ?', [req.params.id]);
    // Удаляем файл фото с диска если есть
    if (rows[0]?.photo) {
      const filePath = path.join(UPLOADS_DIR, rows[0].photo);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { console.error('photo del', e.message); }
    }
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

// Кэшированная генерация data URL для HTML страниц печати
async function genCodeDataUrlCached(code, type) {
  const key = `${type}:${code}`;
  if (codeCache.has(key)) return codeCache.get(key);

  let dataUrl;
  if (type === 'barcode') {
    const buf = await bwipjs.toBuffer({
      bcid: 'code128', text: code, scale: 3, height: 12,
      includetext: false, paddingwidth: 5,
    });
    dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  } else {
    dataUrl = await QRCode.toDataURL(code, { width: 180, margin: 1 });
  }

  codeCache.set(key, dataUrl);
  // LRU-обрезание
  if (codeCache.size > CODE_CACHE_MAX) {
    const firstKey = codeCache.keys().next().value;
    codeCache.delete(firstKey);
  }
  return dataUrl;
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

// === HTML экспорт для печати/PDF ===
const SIZE_PX = { small: 90, medium: 140, large: 200 };
const SIZE_COLS = { small: 5, medium: 4, large: 3 };

async function genCodeDataUrl(code, type) {
  return genCodeDataUrlCached(code, type);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function renderPrintHtml(items, type, size) {
  const px = SIZE_PX[size] || 90;
  const cellH = type === 'barcode' ? Math.round(px * 0.45) : px;
  const cols = SIZE_COLS[size] || 5;
  const cells = items.map(item => `
    <div class="cell">
      <div class="img-wrap">
        <img src="${item.img}" width="${px}" height="${cellH}" />
      </div>
      <div class="code">${escapeHtml(item.code)}</div>
      ${item.name ? `<div class="name">${escapeHtml(item.name.substring(0, 30))}</div>` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Печать кодов — ${items.length} шт.</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f5; padding: 0;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .toolbar { background: #1976D2; color: #fff; padding: 16px; position: sticky; top: 0; z-index: 10; box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  .toolbar h1 { margin: 0 0 6px; font-size: 18px; }
  .toolbar .count { font-size: 13px; opacity: 0.9; margin-bottom: 10px; }
  .toolbar button { background: #fff; color: #1976D2; border: none; padding: 10px 22px; border-radius: 6px; font-size: 15px; font-weight: 700; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .toolbar button:hover { background: #f0f0f0; }
  .hint { font-size: 11px; color: rgba(255,255,255,0.75); margin-top: 8px; line-height: 1.5; }
  .container { max-width: 1100px; margin: 16px auto; background: #fff; padding: 16px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 4px; }
  .cell { text-align: center; padding: 6px 4px; page-break-inside: avoid; border: 1px dashed #ccc; }
  .img-wrap { width: ${px}px; height: ${cellH}px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
  .img-wrap img { max-width: 100%; max-height: 100%; display: block; object-fit: contain; }
  .code { font-family: 'Courier New', monospace; font-size: 8px; margin-top: 3px; color: #000; word-break: break-all; }
  .name { font-size: 7px; color: #333; margin-top: 1px; }
  @media print {
    .toolbar { display: none; }
    body { background: #fff; padding: 0; }
    .container { box-shadow: none; padding: 4px; max-width: none; margin: 0; }
    .cell { border: 1px dashed #aaa; }
    .code { color: #000; }
    .name { color: #333; }
    @page { margin: 0.8cm; }
  }
</style>
</head><body>
  <div class="toolbar">
    <h1>📄 Кибер-Завхоз — печать кодов</h1>
    <div class="count">${type === 'barcode' ? 'Штрихкоды' : 'QR-коды'} · ${items.length} шт. · размер ${size}</div>
    <button id="printBtn" onclick="doPrint()" disabled style="opacity:0.5">⏳ Загрузка...</button>
    <div class="hint">
      Android: «Печать» → смените принтер на <b>«Сохранить как PDF»</b><br>
      iOS: «Печать» → раздвиньте пальцы на превью → «Поделиться» → «Сохранить в Файлы»
    </div>
  </div>
  <div class="container">
    <div class="grid">${cells}</div>
  </div>
<script>
  function doPrint() { window.print(); }
  var imgs = document.querySelectorAll('img');
  var total = imgs.length, loaded = 0;
  function onLoad() {
    loaded++;
    if (loaded >= total) {
      var btn = document.getElementById('printBtn');
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = '🖨 Печать / Сохранить PDF';
    }
  }
  if (total === 0) { onLoad(); }
  imgs.forEach(function(img) {
    if (img.complete) { onLoad(); }
    else { img.addEventListener('load', onLoad); img.addEventListener('error', onLoad); }
  });
</script>
</body></html>`;
}

async function buildItemsWithImages(items, type) {
  return await Promise.all(items.map(async (item) => ({
    ...item, img: await genCodeDataUrl(item.code, type),
  })));
}

// HTML страница для печати существующих (быстро — картинки грузит браузер)
app.get('/api/export/print', async (req, res) => {
  try {
    const type = req.query.type === 'barcode' ? 'barcode' : 'qr';
    const size = ['small', 'medium', 'large'].includes(req.query.size) ? req.query.size : 'small';
    let items;
    if (req.query.ids) {
      const ids = req.query.ids.split(',').map(Number).filter(Boolean);
      if (ids.length === 0) return res.status(400).send('Пустой список');
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await db.query(`SELECT id, code, name FROM items WHERE id IN (${placeholders}) ORDER BY name`, ids);
      items = rows;
    } else {
      const [rows] = await db.query('SELECT id, code, name FROM items ORDER BY name');
      items = rows;
    }
    if (items.length === 0) return res.status(404).send('Нет данных');
    // Используем URL эндпоинтов — браузер грузит картинки сам, ответ мгновенный
    const withImages = items.map(item => ({
      ...item,
      img: type === 'barcode'
        ? `/api/items/${item.id}/barcode`
        : `/api/items/${item.id}/qr`,
    }));
    const html = renderPrintHtml(withImages, type, size);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка генерации страницы');
  }
});

// HTML страница для печати новых сгенерированных
app.get('/api/export/print-generate', async (req, res) => {
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
    const withImages = await buildItemsWithImages(items, type);
    const html = renderPrintHtml(withImages, type, size);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка генерации страницы');
  }
});

// === ОТЧЁТ ИНВЕНТАРИЗАЦИИ ===
// In-memory хранилище отчётов (для случаев когда foundIds/missingIds большие)
const inventoryReports = new Map();
const INVENTORY_REPORT_TTL = 30 * 60 * 1000; // 30 минут

// POST: сохранить данные отчёта, получить ID
app.post('/api/inventory-report', auth, async (req, res) => {
  try {
    const { foundIds = [], missingIds = [], conductedBy } = req.body;
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    inventoryReports.set(id, {
      foundIds: foundIds.map(Number).filter(Boolean),
      missingIds: missingIds.map(Number).filter(Boolean),
      conductedBy: conductedBy || req.user.full_name || req.user.login,
      conductedAt: new Date().toISOString(),
      expiresAt: Date.now() + INVENTORY_REPORT_TTL,
    });
    // Очистка просроченных
    for (const [k, v] of inventoryReports.entries()) {
      if (v.expiresAt < Date.now()) inventoryReports.delete(k);
    }
    res.json({ id, url: `/api/inventory-report/${id}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания отчёта' });
  }
});

// GET: HTML страница отчёта (без auth — открывается в браузере)
app.get('/api/inventory-report/:id', async (req, res) => {
  try {
    const report = inventoryReports.get(req.params.id);
    if (!report) {
      return res.status(404).send('<h1>Отчёт не найден или устарел</h1><p>Сформируйте новый отчёт в приложении.</p>');
    }

    const allIds = [...report.foundIds, ...report.missingIds];
    let foundItems = [], missingItems = [];
    if (allIds.length > 0) {
      const placeholders = allIds.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT id, code, name, category, location, responsible, status FROM items WHERE id IN (${placeholders})`,
        allIds
      );
      const byId = new Map(rows.map(r => [r.id, r]));
      foundItems = report.foundIds.map(id => byId.get(id)).filter(Boolean);
      missingItems = report.missingIds.map(id => byId.get(id)).filter(Boolean);
    }

    const total = foundItems.length + missingItems.length;
    const foundPct = total > 0 ? Math.round((foundItems.length / total) * 100) : 0;
    const date = new Date(report.conductedAt);
    const dateStr = date.toLocaleDateString('ru-RU') + ' ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

    const renderRow = (it, status) => `
      <tr class="${status}">
        <td class="code">${escapeHtml(it.code)}</td>
        <td class="name">${escapeHtml(it.name)}</td>
        <td class="loc">${escapeHtml(it.location || '—')}</td>
        <td class="resp">${escapeHtml(it.responsible || '—')}</td>
      </tr>`;

    const html = `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Акт инвентаризации</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Times New Roman', serif; padding: 12px; background: #f5f5f5; color: #000; }
  .container { max-width: 900px; margin: 0 auto; background: #fff; padding: 24px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  h1 { text-align: center; margin: 0 0 6px; font-size: 20px; }
  .subtitle { text-align: center; color: #666; margin-bottom: 20px; font-size: 13px; }
  .meta { background: #f9f9f9; padding: 12px 14px; border-radius: 4px; margin-bottom: 18px; font-size: 13px; }
  .meta-row { display: flex; flex-wrap: wrap; margin: 4px 0; }
  .meta-label { font-weight: 700; min-width: 170px; flex-shrink: 0; }
  .meta-value { flex: 1; word-break: break-word; }
  .stats { display: flex; gap: 8px; margin-bottom: 20px; }
  .stat-box { flex: 1; padding: 12px 8px; border-radius: 6px; text-align: center; min-width: 0; }
  .stat-total { background: #E3F2FD; }
  .stat-found { background: #E8F5E9; }
  .stat-missing { background: #FFEBEE; }
  .stat-num { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; margin-top: 4px; color: #555; }
  h2 { font-size: 14px; margin: 20px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  th, td { padding: 5px 6px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; word-wrap: break-word; word-break: break-word; }
  th { background: #f0f0f0; font-weight: 700; font-size: 10px; }
  td.code { font-family: 'Courier New', monospace; font-size: 10px; }
  td.name { font-weight: 600; }
  col.col-code { width: 22%; }
  col.col-name { width: 38%; }
  col.col-loc { width: 22%; }
  col.col-resp { width: 18%; }
  tr.missing { background: #fff5f5; }
  tr.missing td.code { color: #C62828; }
  tr.found td.code { color: #2E7D32; }
  .signatures { margin-top: 40px; display: flex; flex-wrap: wrap; gap: 24px; }
  .sign-block { flex: 1; min-width: 220px; text-align: center; }
  .sign-line { border-top: 1px solid #000; margin-top: 40px; padding-top: 4px; font-size: 11px; }
  .toolbar { background: #1976D2; color: #fff; padding: 12px 14px; position: sticky; top: 0; z-index: 10; max-width: 900px; margin: 0 auto 12px; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .toolbar button { background: #fff; color: #1976D2; border: none; padding: 9px 18px; border-radius: 4px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .toolbar .lbl { opacity: 0.95; font-size: 13px; }

  @media (max-width: 600px) {
    body { padding: 6px; font-size: 13px; }
    .container { padding: 16px 12px; }
    h1 { font-size: 17px; }
    .meta { font-size: 12px; }
    .meta-label { min-width: 100%; }
    .stats { gap: 6px; }
    .stat-num { font-size: 20px; }
    .stat-label { font-size: 9px; }
    table { font-size: 10px; }
    th, td { padding: 4px 5px; }
    col.col-code { width: 26%; }
    col.col-name { width: 38%; }
    col.col-loc { width: 22%; }
    col.col-resp { width: 14%; }
  }

  @media print {
    body { background: #fff; padding: 0; }
    .container { box-shadow: none; padding: 0; max-width: none; }
    .toolbar { display: none; }
    @page { margin: 1.5cm; }
  }
</style>
</head><body>
  <div class="toolbar">
    <button onclick="window.print()">🖨 Печать / Сохранить PDF</button>
    <span class="lbl">Акт инвентаризации</span>
  </div>
  <div class="container">
    <h1>АКТ ИНВЕНТАРИЗАЦИИ</h1>
    <div class="subtitle">проведения сверки наличия имущества</div>

    <div class="meta">
      <div class="meta-row"><span class="meta-label">Дата проведения:</span><span class="meta-value">${dateStr}</span></div>
      <div class="meta-row"><span class="meta-label">Ответственное лицо (ФИО):</span><span class="meta-value">${escapeHtml(report.conductedBy)}</span></div>
      <div class="meta-row"><span class="meta-label">Всего позиций в учёте:</span><span class="meta-value">${total}</span></div>
    </div>

    <div class="stats">
      <div class="stat-box stat-total">
        <div class="stat-num">${total}</div>
        <div class="stat-label">Всего</div>
      </div>
      <div class="stat-box stat-found">
        <div class="stat-num" style="color: #2E7D32">${foundItems.length}</div>
        <div class="stat-label">Найдено (${foundPct}%)</div>
      </div>
      <div class="stat-box stat-missing">
        <div class="stat-num" style="color: #C62828">${missingItems.length}</div>
        <div class="stat-label">Не найдено</div>
      </div>
    </div>

    ${missingItems.length > 0 ? `
    <h2>❌ Не найдено при проверке (${missingItems.length})</h2>
    <div class="table-wrap"><table>
      <colgroup><col class="col-code"><col class="col-name"><col class="col-loc"><col class="col-resp"></colgroup>
      <thead><tr><th>Код</th><th>Наименование</th><th>Местонахождение</th><th>Ответственный</th></tr></thead>
      <tbody>${missingItems.map(it => renderRow(it, 'missing')).join('')}</tbody>
    </table></div>
    ` : ''}

    ${foundItems.length > 0 ? `
    <h2>✅ Найдено и подтверждено (${foundItems.length})</h2>
    <div class="table-wrap"><table>
      <colgroup><col class="col-code"><col class="col-name"><col class="col-loc"><col class="col-resp"></colgroup>
      <thead><tr><th>Код</th><th>Наименование</th><th>Местонахождение</th><th>Ответственный</th></tr></thead>
      <tbody>${foundItems.map(it => renderRow(it, 'found')).join('')}</tbody>
    </table></div>
    ` : ''}

    <div class="signatures">
      <div class="sign-block"><div class="sign-line">Лицо, проводившее инвентаризацию</div></div>
      <div class="sign-block"><div class="sign-line">Материально-ответственное лицо</div></div>
    </div>
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('<h1>Ошибка генерации отчёта</h1>');
  }
});

// Экспорт существующих позиций (старый PDF — оставлен)
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
app.delete('/api/items/:id/photo', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT photo FROM items WHERE id = ?', [req.params.id]);
    if (rows[0]?.photo) {
      const filePath = path.join(UPLOADS_DIR, rows[0].photo);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await db.query('UPDATE items SET photo = NULL WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка удаления' });
  }
});

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
const VALID_ROLES = ['viewer', 'editor', 'admin'];

app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, login, full_name, role, created_at FROM users');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const login = String(req.body.login || '').trim();
    const password = String(req.body.password || '').trim();
    const full_name = String(req.body.full_name || '').trim();
    const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'editor';
    if (!login || !password || !full_name) return res.status(400).json({ error: 'Все поля обязательны' });

    const [result] = await db.query(
      'INSERT INTO users (login, password, full_name, role) VALUES (?, ?, ?, ?)',
      [login, password, full_name, role]
    );
    console.log(`[USERS] Создан: ${login} (${role})`);
    res.json({ id: result.insertId, login, full_name, role });
  } catch (err) {
    console.error('[USERS] Create error:', err.message);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.put('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const full_name = String(req.body.full_name || '').trim();
    const role = VALID_ROLES.includes(req.body.role) ? req.body.role : 'editor';
    const password = req.body.password ? String(req.body.password).trim() : null;

    if (password) {
      await db.query('UPDATE users SET full_name=?, role=?, password=? WHERE id=?', [full_name, role, password, req.params.id]);
    } else {
      await db.query('UPDATE users SET full_name=?, role=? WHERE id=?', [full_name, role, req.params.id]);
    }
    console.log(`[USERS] Обновлён id=${req.params.id} role=${role}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[USERS] Update error:', err.message);
    res.status(500).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
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