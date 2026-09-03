require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* El secreto de firma NO puede tener un valor fijo en el código: si está
   publicado, cualquiera puede fabricar un token válido y entrar como admin.
   Si no se definió la variable, se genera uno aleatorio por arranque —
   seguro, pero invalida las sesiones en cada redeploy, así que se avisa. */
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('');
  console.warn('  ⚠️  Falta la variable JWT_SECRET.');
  console.warn('     Se generó una clave temporal: las sesiones se cierran en');
  console.warn('     cada reinicio. Definí JWT_SECRET en Render para evitarlo.');
  console.warn('');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 120000   // importaciones de 10.000 productos necesitan margen
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));
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
      -- La planilla madre repite códigos en productos distintos y no se puede
      -- modificar. Por eso la clave es codigo + descripcion, no el código solo:
      -- con el código como PRIMARY KEY, el segundo producto pisaba al primero.
      CREATE TABLE IF NOT EXISTS productos (
        clave VARCHAR(400) PRIMARY KEY,
        codigo VARCHAR(100) NOT NULL,
        descripcion TEXT NOT NULL,
        unidad VARCHAR(50),
        precio_mayorista DECIMAL(15,2) DEFAULT 0,
        precio_mix DECIMAL(15,2) DEFAULT 0,
        precio_minorista DECIMAL(15,2) DEFAULT 0,
        rubro VARCHAR(100),
        observaciones TEXT,
        actualizado_en TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS facturas (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(100) NOT NULL,
        codigo_cliente VARCHAR(20) NOT NULL,
        fecha DATE,
        fecha_texto VARCHAR(50),
        importe DECIMAL(15,2) DEFAULT 0,
        nc_aplicadas DECIMAL(15,2) DEFAULT 0,
        pagos_aplicados DECIMAL(15,2) DEFAULT 0,
        pdf_nombre VARCHAR(255),
        pdf_data TEXT,
        creado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE (numero, codigo_cliente)
      );
      CREATE TABLE IF NOT EXISTS auditoria (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(100),
        badge TEXT,
        descripcion TEXT,
        usuario VARCHAR(100),
        fecha TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_productos_desc ON productos (descripcion);
      CREATE INDEX IF NOT EXISTS idx_productos_rubro ON productos (rubro);
      CREATE INDEX IF NOT EXISTS idx_movimientos_cliente ON movimientos (codigo_cliente);
      CREATE INDEX IF NOT EXISTS idx_facturas_cliente ON facturas (codigo_cliente);
      CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes (nombre);
    `);
    /* Sembrado de usuarios iniciales.
       DO NOTHING (no DO UPDATE): si el usuario ya existe se respeta su
       contraseña actual. Con DO UPDATE, cada reinicio de Render reseteaba
       la clave de ADMIN al valor de fábrica. */
    const claveAdmin = process.env.ADMIN_PASSWORD || 'admin';
    const claveCajero = process.env.CAJERO_PASSWORD || '1234';
    const hash1 = await bcrypt.hash(claveAdmin, 10);
    const hash2 = await bcrypt.hash(claveCajero, 10);
    const r1 = await client.query(`INSERT INTO usuarios (username,password_hash,role,label,avatar) VALUES ('ADMIN',$1,'admin','Administrador','AD') ON CONFLICT (username) DO NOTHING RETURNING username`, [hash1]);
    await client.query(`INSERT INTO usuarios (username,password_hash,role,label,avatar) VALUES ('LOCAL 5',$1,'cajero','Local 5','L5') ON CONFLICT (username) DO NOTHING`, [hash2]);

    if (r1.rowCount > 0 && !process.env.ADMIN_PASSWORD) {
      console.warn('');
      console.warn('  ⚠️  ADMIN creado con la contraseña de fábrica ("admin").');
      console.warn('     Cambiala YA desde Configuración → Usuarios, o definí');
      console.warn('     la variable de entorno ADMIN_PASSWORD en Render.');
      console.warn('');
    }
    console.log('✓ Base de datos lista');
  } finally { client.release(); }
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sin token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
}

/* Autorización por rol. Ocultar un botón en el frontend no protege nada:
   con el token en la mano, cualquiera puede llamar al endpoint directo.
   Estos middlewares son la única barrera real. */
function requiereRol(...rolesPermitidos) {
  return function (req, res, next) {
    const rol = req.user && req.user.role;
    if (!rol) return res.status(401).json({ error: 'Sin rol en el token' });
    if (!rolesPermitidos.includes(rol)) {
      return res.status(403).json({
        error: 'Tu usuario (' + rol + ') no tiene permiso para esta operación'
      });
    }
    next();
  };
}

const soloAdmin = requiereRol('admin');
const adminOAdministracion = requiereRol('admin', 'administracion');

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

app.post('/api/clientes', auth, adminOAdministracion, async (req, res) => {
  const c = req.body;
  try {
    await pool.query(`INSERT INTO clientes (codigo,nombre,cuit,vendedor,estado,saldo,fecha_alta,condicion_iva,email,telefono,whatsapp,direccion,localidad,provincia,cp,observaciones,limite) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre,cuit=EXCLUDED.cuit,vendedor=EXCLUDED.vendedor,estado=EXCLUDED.estado,saldo=EXCLUDED.saldo,condicion_iva=EXCLUDED.condicion_iva,email=EXCLUDED.email,telefono=EXCLUDED.telefono,whatsapp=EXCLUDED.whatsapp,direccion=EXCLUDED.direccion,localidad=EXCLUDED.localidad,provincia=EXCLUDED.provincia,cp=EXCLUDED.cp,observaciones=EXCLUDED.observaciones,limite=EXCLUDED.limite,actualizado_en=NOW()`,
    [c.codigo,c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.fechaAlta||new Date().toISOString().slice(0,10),c.condicionIva||'',c.email||'',c.telefono||'',c.whatsapp||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'',Number(c.limite)||0]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/clientes/:codigo', auth, adminOAdministracion, async (req, res) => {
  const c = req.body;
  try {
    await pool.query('UPDATE clientes SET nombre=$1,cuit=$2,vendedor=$3,estado=$4,saldo=$5,condicion_iva=$6,email=$7,telefono=$8,direccion=$9,localidad=$10,provincia=$11,cp=$12,observaciones=$13,limite=$14,actualizado_en=NOW() WHERE codigo=$15',
    [c.nombre,c.cuit||'',c.vendedor||'',c.estado||'activo',Number(c.saldo)||0,c.condicionIva||'',c.email||'',c.telefono||'',c.direccion||'',c.localidad||'',c.provincia||'',c.cp||'',c.observaciones||'',Number(c.limite)||0,req.params.codigo]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clientes/:codigo', auth, soloAdmin, async (req, res) => {
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

/* Ajustes manuales y saldos iniciales solo los puede cargar un admin —
   son los movimientos que permiten alterar un saldo sin respaldo documental. */
const TIPOS_MOVIMIENTO_SOLO_ADMIN = new Set([
  'manual_debe','manual_haber','ajuste_debe','ajuste_haber',
  'saldo_inicial_debe','saldo_inicial_haber'
]);

function validarTipoMovimiento(req, res, next) {
  const tipo = req.body && req.body.tipo;
  if (TIPOS_MOVIMIENTO_SOLO_ADMIN.has(tipo) && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Solo un Administrador puede registrar movimientos de tipo "' + tipo + '"'
    });
  }
  next();
}

app.post('/api/movimientos', auth, validarTipoMovimiento, async (req, res) => {
  const m = req.body || {};
  if (!m.codigoCliente) return res.status(400).json({ error: 'Falta codigoCliente' });

  /* El id lo genera el cliente; si no viene, se arma uno estable acá.
     Antes, un movimiento sin id rompía el INSERT y se perdía en silencio. */
  const id = m.id || ('mov-' + m.codigoCliente + '-' + (m.comprobante || 'SC').replace(/[^A-Za-z0-9]/g,'') + '-' + Date.now().toString(36));
  const debe = Number(m.debe) || 0;
  const haber = Number(m.haber) || 0;

  const client = await pool.connect();
  try {
    /* Transacción: el alta del movimiento y la actualización del saldo tienen
       que ocurrir juntas o no ocurrir. Sin esto, si falla el UPDATE el saldo
       del cliente queda desfasado respecto de sus movimientos. */
    await client.query('BEGIN');

    /* Idempotencia: si el navegador reintenta el envío (red intermitente), el
       movimiento no debe duplicarse ni sumarse dos veces al saldo.
       La comprobación es un SELECT explícito dentro de la transacción en vez
       de ON CONFLICT, porque el conteo de filas afectadas por DO NOTHING no
       es confiable en todos los drivers y un falso negativo acá significa
       cobrarle dos veces a un cliente. */
    const yaExiste = await client.query('SELECT id FROM movimientos WHERE id=$1', [id]);
    if (yaExiste.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, duplicado: true, id });
    }

    await client.query(
      `INSERT INTO movimientos (id,codigo_cliente,tipo,badge,fecha,fecha_texto,comprobante,obs,debe,haber,saldo_acum,estado,usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, m.codigoCliente, m.tipo, m.badge||'', m.fecha || null, m.fechaTexto||'',
       m.comprobante||'', m.obs||'', debe, haber, Number(m.saldoAcum)||0,
       m.estado||'activo', req.user.username]);

    const upd = await client.query(
      'UPDATE clientes SET saldo=saldo+$1-$2,actualizado_en=NOW() WHERE codigo=$3',
      [debe, haber, m.codigoCliente]);

    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'El cliente ' + m.codigoCliente + ' no existe en el servidor' });
    }

    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch(_){}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
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

app.post('/api/configuracion', auth, soloAdmin, async (req, res) => {
  try {
    for (const [key, val] of Object.entries(req.body)) {
      await pool.query('INSERT INTO configuracion (clave,valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor=$2,actualizado_en=NOW()', [key, JSON.stringify(val)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/importar-clientes', auth, soloAdmin, async (req, res) => {
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

app.get('/api/usuarios', auth, soloAdmin, async (req, res) => {
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

/* ===== PLANTILLAS DE IMPRESIÓN ===== */
/* Sin esto cada sucursal tendría que rearmar el remito a mano en su navegador */
app.get('/api/plantillas', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,datos FROM plantillas ORDER BY id ASC');
    res.json(rows.map(r => r.datos));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plantillas', auth, soloAdmin, async (req, res) => {
  const p = req.body;
  if (!p || !p.id) return res.status(400).json({ error: 'Falta el id de la plantilla' });
  try {
    await pool.query(
      'INSERT INTO plantillas (id,datos) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET datos=EXCLUDED.datos',
      [p.id, JSON.stringify(p)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plantillas/:id', auth, soloAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM plantillas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ===== ARCA (ex AFIP) — consulta de padrón por CUIT ===== */
const arca = require('./arca');

/* Estado de la integración: la usa el frontend para mostrar el botón
   habilitado o explicar qué falta configurar. */
app.get('/api/arca/estado', auth, (req, res) => {
  res.json({
    configurado: arca.estaConfigurado(),
    faltantes: arca.faltantes(),
    ambiente: arca.config().env
  });
});

app.get('/api/arca/padron/:cuit', auth, adminOAdministracion, async (req, res) => {
  try {
    const r = await arca.consultarPadron(req.params.cuit);
    if (r.configurado === false) {
      return res.status(503).json({
        error: 'La conexión con ARCA todavía no está configurada',
        faltantes: r.faltantes
      });
    }
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ===== PRODUCTOS ===== */
/* Identidad del producto: código + descripción. Ver comentario en la tabla. */
function claveProducto(p) {
  return (String(p.codigo || '').trim().toUpperCase() + '||' +
          String(p.descripcion || '').trim().toUpperCase()).slice(0, 400);
}
app.get('/api/productos', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM productos ORDER BY codigo ASC');
    res.json(rows.map(r => ({
      codigo: r.codigo, descripcion: r.descripcion, unidad: r.unidad || '',
      precioMayorista: Number(r.precio_mayorista) || 0,
      precioMix: Number(r.precio_mix) || 0,
      precioMinorista: Number(r.precio_minorista) || 0,
      rubro: r.rubro || '', observaciones: r.observaciones || ''
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/productos', auth, adminOAdministracion, async (req, res) => {
  const p = req.body;
  if (!p || !p.codigo) return res.status(400).json({ error: 'Falta el código' });
  try {
    await pool.query(`INSERT INTO productos (clave,codigo,descripcion,unidad,precio_mayorista,precio_mix,precio_minorista,rubro,observaciones)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (clave) DO UPDATE SET descripcion=EXCLUDED.descripcion,unidad=EXCLUDED.unidad,
        precio_mayorista=EXCLUDED.precio_mayorista,precio_mix=EXCLUDED.precio_mix,
        precio_minorista=EXCLUDED.precio_minorista,rubro=EXCLUDED.rubro,
        observaciones=EXCLUDED.observaciones,actualizado_en=NOW()`,
    [claveProducto(p), String(p.codigo).trim(), p.descripcion||'', p.unidad||'',
     Number(p.precioMayorista)||0, Number(p.precioMix)||0, Number(p.precioMinorista)||0,
     p.rubro||'', p.observaciones||'']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/productos/:codigo', auth, soloAdmin, async (req, res) => {
  try {
    /* Si viene la descripción se borra ese producto exacto; si no, todos los
       que compartan ese código (comportamiento explícito, no accidental). */
    if (req.query.descripcion) {
      await pool.query('DELETE FROM productos WHERE clave=$1',
        [claveProducto({ codigo: req.params.codigo, descripcion: req.query.descripcion })]);
    } else {
      await pool.query('DELETE FROM productos WHERE codigo=$1', [String(req.params.codigo).toUpperCase()]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* Importación masiva de productos — en lotes, dentro de una transacción */
app.post('/api/importar-productos', auth, soloAdmin, async (req, res) => {
  const { productos } = req.body;
  if (!Array.isArray(productos)) return res.status(400).json({ error: 'Formato inválido' });
  const client = await pool.connect();
  let creados = 0, errores = 0;
  try {
    await client.query('BEGIN');
    // Insert multi-fila: con 10.000 productos, hacerlo de a uno tarda minutos.
    // Se agrupan de a 200 filas por sentencia y se deduplica por código dentro
    // del bloque (Postgres rechaza dos updates a la misma fila en un ON CONFLICT).
    const CHUNK = 200;
    const vistos = new Set();
    const limpios = [];
    for (const p of productos) {
      if (!p || !p.codigo) { errores++; continue; }
      const cod = String(p.codigo).trim(); // se preserva tal cual la planilla
      if (!cod) { errores++; continue; }
      const clave = claveProducto(p);
      if (vistos.has(clave)) { errores++; continue; }
      vistos.add(clave);
      limpios.push([clave, cod, p.descripcion||'', p.unidad||'',
        Number(p.precioMayorista)||0, Number(p.precioMix)||0, Number(p.precioMinorista)||0,
        p.rubro||'', p.observaciones||'']);
    }

    for (let i = 0; i < limpios.length; i += CHUNK) {
      const bloque = limpios.slice(i, i + CHUNK);
      const valores = [];
      const placeholders = bloque.map((fila, idx) => {
        const base = idx * 9;
        valores.push(...fila);
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
      }).join(',');
      try {
        await client.query(`INSERT INTO productos (clave,codigo,descripcion,unidad,precio_mayorista,precio_mix,precio_minorista,rubro,observaciones)
          VALUES ${placeholders}
          ON CONFLICT (clave) DO UPDATE SET descripcion=EXCLUDED.descripcion,unidad=EXCLUDED.unidad,
            precio_mayorista=EXCLUDED.precio_mayorista,precio_mix=EXCLUDED.precio_mix,
            precio_minorista=EXCLUDED.precio_minorista,rubro=EXCLUDED.rubro,
            observaciones=EXCLUDED.observaciones,actualizado_en=NOW()`, valores);
        creados += bloque.length;
      } catch (err) {
        errores += bloque.length;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, creados, errores });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

/* ===== FACTURAS (con PDF adjunto) ===== */
/* El listado NO devuelve el pdf_data para no mandar megabytes al abrir la ficha */
app.get('/api/facturas/:codigoCliente', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id,numero,codigo_cliente,fecha,fecha_texto,importe,nc_aplicadas,pagos_aplicados,pdf_nombre,(pdf_data IS NOT NULL) AS tiene_pdf FROM facturas WHERE codigo_cliente=$1 ORDER BY fecha DESC',
      [req.params.codigoCliente]);
    res.json(rows.map(r => ({
      id: 'fac-' + r.numero, numero: r.numero, fecha: r.fecha_texto || r.fecha,
      importe: Number(r.importe) || 0,
      ncAplicadas: Number(r.nc_aplicadas) || 0,
      pagosAplicados: Number(r.pagos_aplicados) || 0,
      pdfNombre: r.pdf_nombre || '', tienePdf: r.tiene_pdf
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* El PDF se pide aparte, solo cuando el usuario hace clic en "Ver" */
app.get('/api/facturas/:codigoCliente/:numero/pdf', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT pdf_data,pdf_nombre FROM facturas WHERE codigo_cliente=$1 AND numero=$2',
      [req.params.codigoCliente, req.params.numero]);
    if (!rows.length || !rows[0].pdf_data) return res.status(404).json({ error: 'Sin PDF' });
    res.json({ pdf: rows[0].pdf_data, pdfNombre: rows[0].pdf_nombre || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/facturas', auth, async (req, res) => {
  const f = req.body;
  if (!f || !f.numero || !f.codigoCliente) return res.status(400).json({ error: 'Faltan número o cliente' });
  try {
    await pool.query(`INSERT INTO facturas (numero,codigo_cliente,fecha,fecha_texto,importe,nc_aplicadas,pagos_aplicados,pdf_nombre,pdf_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (numero,codigo_cliente) DO UPDATE SET importe=EXCLUDED.importe,
        nc_aplicadas=EXCLUDED.nc_aplicadas,pagos_aplicados=EXCLUDED.pagos_aplicados,
        pdf_nombre=COALESCE(EXCLUDED.pdf_nombre,facturas.pdf_nombre),
        pdf_data=COALESCE(EXCLUDED.pdf_data,facturas.pdf_data)`,
    [String(f.numero).toUpperCase(), f.codigoCliente, f.fechaIso || null, f.fecha || '',
     Number(f.importe)||0, Number(f.ncAplicadas)||0, Number(f.pagosAplicados)||0,
     f.pdfNombre || null, f.pdf || null]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* Catch-all: sirve el index.html para cualquier ruta que no sea /api.
   Se usa app.use en lugar de app.get('*') porque el comodín '*' rompe el
   arranque en Express 5, y además así una ruta /api inexistente devuelve
   un 404 JSON en vez de quedar colgada sin respuesta. */
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Endpoint no encontrado: ' + req.path });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`✓ Servidor en puerto ${PORT}`));
}).catch(e => { console.error('Error BD:', e); process.exit(1); });
