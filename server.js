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
    console.log('Base de datos lista');
  } finally { client.release(); }
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalido' }); }
}

app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE username=$1 AND activo=true', [usuario?.toUpperCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o contrasena incorrectos' });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username, role: rows[0].role, label: rows[0].label, avatar: rows[0].avatar }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { username: rows[0].username, role: rows[0].role, label: rows[0].label, avatar: rows[0].avatar } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clientes', auth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM clientes WHERE estado != 'eliminado' ORDER BY nombre ASC");
    res.json(rows.map(r => ({ codigo: r.codigo, nombre: r.nombre, cuit: r.cuit||'', vendedor: r.vendedor||'', estado: r.estado, saldo: String(r.saldo||0), fechaAlta: r.fecha_alta, condicionIva: r.condicion_iva||'', email: r.email||'', telefono: r.telefono||'', direccion: r.direccion||'', localidad: r.localidad||'', provincia: r.provincia||'', cp: r.cp||'', observaciones: r.observaciones||'', limite: String(r.limite||0) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clientes', auth, async (req, res) => {
  const c = req.body;
  try {
    await pool.query('INSERT INTO clientes (codigo,nombre,cuit,vendedor,estado,saldo,fecha_alta,condicion_iva,email,telefono,direccion,localidad,provincia,cp,observaciones,limite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre,email=EXCLUDED.email,telefono=EXCLUDED.telefono,direccion=EXCLUDED.direccion,saldo=EXCLUDED.saldo,actualizado_en=NOW()',
    [c.codigo,c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.fechaAlta||new Date().toISOString().slice(0,10),c.condicionIva||'',c.email||'',c.telefono||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'',Number(c.limite)||0]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clientes/:codigo', auth, async (req, res) => {
  const c = req.body;
  try {
    await pool.query('UPDATE clientes SET nombre=$1,cuit=$2,vendedor=$3,estado=$4,saldo=$5,condicion_iva=$6,email=$7,telefono=$8,direccion=$9,localidad=$10,provincia=$11,cp=$12,observaciones=$13,limite=$14,actualizado_en=NOW() WHERE codigo=$15',
