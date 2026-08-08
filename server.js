require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
 
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'almacen-armado-secret-2026';
 
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
 
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
 
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'cajero',
        label VARCHAR(100),
        avatar VARCHAR(10),
        activo BOOLEAN DEFAULT true,
        creado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clientes (
        codigo VARCHAR(20) PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        cuit VARCHAR(50),
        vendedor VARCHAR(100),
        estado VARCHAR(20) DEFAULT 'activo',
        saldo DECIMAL(15,2) DEFAULT 0,
        fecha_alta DATE,
        condicion_iva VARCHAR(100),
        email VARCHAR(255),
        telefono VARCHAR(100),
        whatsapp VARCHAR(100),
        direccion TEXT,
        localidad VARCHAR(100),
        provincia VARCHAR(100),
        cp VARCHAR(20),
        observaciones TEXT,
        limite DECIMAL(15,2) DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW(),
        actualizado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS movimientos (
        id VARCHAR(100) PRIMARY KEY,
        codigo_cliente VARCHAR(20),
        tipo VARCHAR(50),
        badge TEXT,
        fecha DATE,
        fecha_texto VARCHAR(50),
        comprobante VARCHAR(255),
        obs TEXT,
        debe DECIMAL(15,2) DEFAULT 0,
        haber DECIMAL(15,2) DEFAULT 0,
        saldo_acum DECIMAL(15,2) DEFAULT 0,
        estado VARCHAR(20) DEFAULT 'activo',
        usuario VARCHAR(100),
        creado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS remitos (
        numero VARCHAR(50) PRIMARY KEY,
        codigo_cliente VARCHAR(20),
        valores JSONB NOT NULL,
        plantilla_snapshot JSONB,
        creado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS configuracion (
        clave VARCHAR(100) PRIMARY KEY,
        valor TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS plantillas (
        id VARCHAR(100) PRIMARY KEY,
        datos JSONB NOT NULL,
        creado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS papelera (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(50),
        codigo VARCHAR(50),
        nombre VARCHAR(255),
        datos JSONB,
        fecha_borrado DATE,
        borrado_por VARCHAR(100),
        creado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS auditoria (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(100),
        badge TEXT,
        descripcion TEXT,
        usuario VARCHAR(100),
        fecha TIMESTAMP DEFAULT NOW()
      );
    `);
    const hash1 = await bcrypt.hash('admin', 10);
    const hash2 = await bcrypt.hash('1234', 10);
    await client.query(`INSERT INTO usuarios (username,password_hash,role,label,avatar) VALUES ('ADMIN',$1,'admin','Administrador','AD') ON CONFLICT (username) DO UPDATE SET password_hash=$1`, [hash1]);
    await client.query(`INSERT INTO usuarios (username,password_hash,role,label,avatar) VALUES ('LOCAL 5',$1,'cajero','Local 5','L5') ON CONFLICT (username) DO UPDATE SET password_hash=$1`, [hash2]);
    console.log('✓ Base de datos lista');
  } finally { client.release(); }
}
 
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}
 
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});
 
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE username=$1 AND activo=true', [usuario?.toUpperCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username, role: rows[0].role, label: rows[0].label, avatar: rows[0].avatar }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: rows[0].username, role: rows[0].role, label: rows[0].label, avatar: rows[0].avatar } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.get('/api/clientes', auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM clientes WHERE estado != 'eliminado' ORDER BY nombre ASC");
    res.json(rows.map(r => ({ codigo: r.codigo, nombre: r.nombre, cuit: r.cuit||'', vendedor: r.vendedor||'', estado: r.estado, saldo: String(r.saldo||0), fechaAlta: r.fecha_alta, condicionIva: r.condicion_iva||'', email: r.email||'', telefono: r.telefono||'', whatsapp: r.whatsapp||'', direccion: r.direccion||'', localidad: r.localidad||'', provincia: r.provincia||'', cp: r.cp||'', observaciones: r.observaciones||'', limite: String(r.limite||0) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/clientes', auth, async (req, res) => {
  const c = req.body;
  try {
    await pool.query(`INSERT INTO clientes (codigo,nombre,cuit,vendedor,estado,saldo,fecha_alta,condicion_iva,email,telefono,whatsapp,direccion,localidad,provincia,cp,observaciones,limite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre,cuit=EXCLUDED.cuit,vendedor=EXCLUDED.vendedor,estado=EXCLUDED.estado,saldo=EXCLUDED.saldo,condicion_iva=EXCLUDED.condicion_iva,email=EXCLUDED.email,telefono=EXCLUDED.telefono,whatsapp=EXCLUDED.whatsapp,direccion=EXCLUDED.direccion,localidad=EXCLUDED.localidad,provincia=EXCLUDED.provincia,cp=EXCLUDED.cp,observaciones=EXCLUDED.observaciones,limite=EXCLUDED.limite,actualizado_en=NOW()`,
    [c.codigo,c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.fechaAlta||new Date().toISOString().slice(0,10),c.condicionIva||'',c.email||'',c.telefono||'',c.whatsapp||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'',Number(c.limite)||0]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.put('/api/clientes/:codigo', auth, async (req, res) => {
  const c = req.body;
  try {
    await pool.query('UPDATE clientes SET nombre=$1,cuit=$2,vendedor=$3,estado=$4,saldo=$5,condicion_iva=$6,email=$7,telefono=$8,direccion=$9,localidad=$10,provincia=$11,cp=$12,observaciones=$13,limite=$14,actualizado_en=NOW() WHERE codigo=$15',
    [c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.condicionIva||'',c.email||'',c.telefono||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'',Number(c.limite)||0,req.params.codigo]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.delete('/api/clientes/:codigo', auth, async (req, res) => {
  try {
    await pool.query("UPDATE clientes SET estado='eliminado' WHERE codigo=$1", [req.params.codigo]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.get('/api/movimientos/:codigo', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM movimientos WHERE codigo_cliente=$1 ORDER BY fecha DESC', [req.params.codigo]);
    res.json(rows.map(r => ({ id: r.id, tipo: r.tipo, badge: r.badge, fecha: r.fecha, fechaTexto: r.fecha_texto, comprobante: r.comprobante, obs: r.obs, debe: Number(r.debe), haber: Number(r.haber), saldoAcum: Number(r.saldo_acum), estado: r.estado, usuario: r.usuario })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/movimientos', auth, async (req, res) => {
  const m = req.body;
  try {
    await pool.query('INSERT INTO movimientos (id,codigo_cliente,tipo,badge,fecha,fecha_texto,comprobante,obs,debe,haber,saldo_acum,estado,usuario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [m.id,m.codigoCliente,m.tipo,m.badge||'',m.fecha,m.fechaTexto||'',m.comprobante||'',m.obs||'',Number(m.debe)||0,Number(m.haber)||0,Number(m.saldoAcum)||0,m.estado||'activo',req.user.username]);
    await pool.query('UPDATE clientes SET saldo=saldo+$1-$2,actualizado_en=NOW() WHERE codigo=$3',[Number(m.debe)||0,Number(m.haber)||0,m.codigoCliente]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.get('/api/remitos', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM remitos ORDER BY creado_en DESC');
    res.json(rows.map(r => ({ numero: r.numero, valores: r.valores, plantillaSnapshot: r.plantilla_snapshot, creadoEn: r.creado_en })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/remitos', auth, async (req, res) => {
  const { numero, valores, plantillaSnapshot } = req.body;
  try {
    await pool.query('INSERT INTO remitos (numero,codigo_cliente,valores,plantilla_snapshot) VALUES ($1,$2,$3,$4) ON CONFLICT (numero) DO UPDATE SET valores=EXCLUDED.valores',
    [numero, null, JSON.stringify(valores), JSON.stringify(plantillaSnapshot)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.get('/api/configuracion', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT clave,valor FROM configuracion');
    const cfg = {};
    rows.forEach(r => { try { cfg[r.clave] = JSON.parse(r.valor); } catch { cfg[r.clave] = r.valor; } });
    res.json(cfg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/configuracion', auth, async (req, res) => {
  try {
    for (const [key, val] of Object.entries(req.body)) {
      await pool.query('INSERT INTO configuracion (clave,valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor=$2,actualizado_en=NOW()', [key, JSON.stringify(val)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/importar-clientes', auth, async (req, res) => {
  const { clientes } = req.body;
  if (!Array.isArray(clientes)) return res.status(400).json({ error: 'Formato inválido' });
  let creados = 0, errores = 0;
  for (const c of clientes) {
    try {
      await pool.query(`INSERT INTO clientes (codigo,nombre,cuit,vendedor,estado,saldo,fecha_alta,email,telefono,direccion,localidad,provincia,cp,observaciones) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre,email=EXCLUDED.email,telefono=EXCLUDED.telefono,direccion=EXCLUDED.direccion,localidad=EXCLUDED.localidad,saldo=EXCLUDED.saldo`,
      [c.codigo,c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.fechaAlta||new Date().toISOString().slice(0,10),c.email||'',c.telefono||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'']);
      creados++;
    } catch { errores++; }
  }
  res.json({ ok: true, creados, errores });
});
 
app.get('/api/usuarios', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,username,role,label,avatar,activo FROM usuarios');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.post('/api/auditoria', auth, async (req, res) => {
  try {
    await pool.query('INSERT INTO auditoria (tipo,badge,descripcion,usuario) VALUES ($1,$2,$3,$4)', [req.body.tipo,req.body.badge||'',req.body.descripcion||'',req.user.username]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});
 
initDB().then(() => {
  app.listen(PORT, () => console.log(`✓ Servidor en puerto ${PORT}`));
}).catch(e => { console.error('Error BD:', e); process.exit(1); });
 
