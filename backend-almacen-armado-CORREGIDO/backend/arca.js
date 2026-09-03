/* ============================================================================
   INTEGRACIÓN CON ARCA (ex AFIP) — Consulta de padrón por CUIT
   ============================================================================

   QUÉ HACE
   Dado un CUIT, devuelve razón social, domicilio, condición frente al IVA y
   categoría de monotributo, consultando el web service oficial
   `ws_sr_constancia_inscripcion`.

   CÓMO FUNCIONA
   ARCA no acepta consultas anónimas. El circuito es:
     1. Se arma un TRA (Ticket de Requerimiento de Acceso): un XML con la hora
        de emisión y expiración y el servicio que se quiere usar.
     2. Se firma ese XML con el certificado digital (CMS / PKCS#7).
     3. Se manda al WSAA, que devuelve un `token` y un `sign` válidos 12 horas.
     4. Con ese token se consulta el padrón por SOAP.
   El token se cachea en memoria: pedir uno nuevo en cada consulta hace que
   ARCA bloquee por exceso de solicitudes.

   QUÉ FALTA PARA ACTIVARLO
   Solamente las credenciales. Se configuran como variables de entorno:
     ARCA_CUIT  → CUIT de la empresa (solo números)
     ARCA_CERT  → contenido del archivo .crt
     ARCA_KEY   → contenido del archivo .key
     ARCA_ENV   → 'produccion' (por defecto) u 'homologacion' para pruebas
   Sin ellas el módulo responde `configurado:false` y el sistema sigue
   funcionando igual: el CUIT se carga a mano, como hasta ahora.
   ========================================================================== */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const URLS = {
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    padron: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  },
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  }
};

const SERVICIO = 'ws_sr_constancia_inscripcion';

function config() {
  return {
    cuit: (process.env.ARCA_CUIT || '').replace(/\D/g, ''),
    cert: process.env.ARCA_CERT || '',
    key: process.env.ARCA_KEY || '',
    env: (process.env.ARCA_ENV || 'produccion').toLowerCase()
  };
}

function estaConfigurado() {
  const c = config();
  return !!(c.cuit && c.cert && c.key);
}

/* Qué falta configurar, para poder mostrarlo en la pantalla de ajustes */
function faltantes() {
  const c = config();
  const f = [];
  if (!c.cuit) f.push('ARCA_CUIT');
  if (!c.cert) f.push('ARCA_CERT');
  if (!c.key) f.push('ARCA_KEY');
  return f;
}

/* ---- 1. TRA: el pedido de acceso que se le firma a ARCA ---- */
function armarTRA() {
  const ahora = new Date();
  const desde = new Date(ahora.getTime() - 10 * 60 * 1000);  // 10 min de margen
  const hasta = new Date(ahora.getTime() + 12 * 60 * 60 * 1000);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, '-03:00');
  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>
    <generationTime>${iso(desde)}</generationTime>
    <expirationTime>${iso(hasta)}</expirationTime>
  </header>
  <service>${SERVICIO}</service>
</loginTicketRequest>`;
}

/* ---- 2. Firma CMS con openssl (disponible en el contenedor de Render) ---- */
function firmarTRA(tra) {
  return new Promise((resolve, reject) => {
    const c = config();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-'));
    const fTra = path.join(dir, 'tra.xml');
    const fCert = path.join(dir, 'cert.crt');
    const fKey = path.join(dir, 'private.key');
    const limpiar = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };

    try {
      fs.writeFileSync(fTra, tra);
      fs.writeFileSync(fCert, c.cert);
      fs.writeFileSync(fKey, c.key, { mode: 0o600 });
    } catch (e) { limpiar(); return reject(e); }

    execFile('openssl',
      ['smime', '-sign', '-in', fTra, '-signer', fCert, '-inkey', fKey,
       '-outform', 'DER', '-nodetach'],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        limpiar();
        if (err) return reject(new Error('No se pudo firmar el pedido: ' + String(stderr).slice(0, 300)));
        resolve(stdout.toString('base64'));
      });
  });
}

/* ---- Cliente SOAP mínimo ---- */
function postSOAP(url, xml, soapAction) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(xml)
    };
    if (soapAction) headers['SOAPAction'] = soapAction;
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers, timeout: 20000 },
      res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
    req.on('timeout', () => { req.destroy(); reject(new Error('ARCA no respondió a tiempo')); });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

const entre = (txt, tag) => {
  const m = txt.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? m[1].trim() : '';
};
const desescapar = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/* ---- 3. Token de acceso, cacheado hasta su vencimiento ---- */
let _ticket = null;

async function obtenerTicket() {
  if (_ticket && _ticket.expira > Date.now() + 5 * 60 * 1000) return _ticket;

  const cms = await firmarTRA(armarTRA());
  const url = (URLS[config().env] || URLS.produccion).wsaa;
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body>
</soapenv:Envelope>`;

  const r = await postSOAP(url, sobre);
  if (r.status !== 200) {
    const falla = entre(r.body, 'faultstring') || ('HTTP ' + r.status);
    throw new Error('WSAA rechazó el pedido: ' + desescapar(falla));
  }

  const xml = desescapar(entre(r.body, 'loginCmsReturn'));
  const token = entre(xml, 'token');
  const sign = entre(xml, 'sign');
  if (!token || !sign) throw new Error('WSAA no devolvió el token de acceso');

  const exp = entre(xml, 'expirationTime');
  _ticket = {
    token, sign,
    expira: exp ? new Date(exp).getTime() : Date.now() + 11 * 60 * 60 * 1000
  };
  return _ticket;
}

/* ---- 4. Consulta del padrón ---- */
async function consultarPadron(cuitConsultado) {
  if (!estaConfigurado()) {
    return { configurado: false, faltantes: faltantes() };
  }
  const idPersona = String(cuitConsultado).replace(/\D/g, '');
  if (idPersona.length !== 11) throw new Error('El CUIT debe tener 11 dígitos');

  const t = await obtenerTicket();
  const c = config();
  const url = (URLS[c.env] || URLS.produccion).padron;
  const sobre = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/">
  <soapenv:Header/>
  <soapenv:Body>
    <a5:getPersona_v2>
      <token>${t.token}</token>
      <sign>${t.sign}</sign>
      <cuitRepresentada>${c.cuit}</cuitRepresentada>
      <idPersona>${idPersona}</idPersona>
    </a5:getPersona_v2>
  </soapenv:Body>
</soapenv:Envelope>`;

  const r = await postSOAP(url, sobre);
  const body = r.body || '';

  if (/No existe persona con ese Id/i.test(body)) {
    return { configurado: true, encontrado: false, motivo: 'El CUIT no figura en el padrón de ARCA' };
  }
  if (r.status !== 200) {
    const falla = entre(body, 'faultstring') || ('HTTP ' + r.status);
    throw new Error('ARCA respondió con un error: ' + desescapar(falla));
  }

  /* Se mapea solo lo que el sistema usa para completar la ficha del cliente */
  const persona = entre(body, 'persona') || body;
  const domicilios = [...body.matchAll(/<domicilio>([\s\S]*?)<\/domicilio>/g)].map(m => m[1]);
  const fiscal = domicilios.find(d => /FISCAL/i.test(entre(d, 'tipoDomicilio'))) || domicilios[0] || '';

  const apellido = entre(persona, 'apellido');
  const nombre = entre(persona, 'nombre');
  const razon = entre(persona, 'razonSocial');

  const esMonotributo = /<datosMonotributo>/.test(body);
  const catMono = entre(body, 'descripcionCategoria');

  let condicionIva = '';
  if (esMonotributo) condicionIva = 'Monotributista';
  else if (/<impuesto>[\s\S]*?<idImpuesto>30<\/idImpuesto>/.test(body)) condicionIva = 'Responsable Inscripto';
  else if (/EXENTO/i.test(body)) condicionIva = 'Exento';

  return {
    configurado: true,
    encontrado: true,
    cuit: idPersona,
    razonSocial: razon || [apellido, nombre].filter(Boolean).join(' '),
    tipoPersona: entre(persona, 'tipoPersona'),
    estadoClave: entre(persona, 'estadoClave'),
    condicionIva,
    categoriaMonotributo: catMono,
    direccion: entre(fiscal, 'direccion'),
    localidad: entre(fiscal, 'localidad') || entre(fiscal, 'descripcionProvincia'),
    provincia: entre(fiscal, 'descripcionProvincia'),
    cp: entre(fiscal, 'codPostal')
  };
}

module.exports = { consultarPadron, estaConfigurado, faltantes, config };
