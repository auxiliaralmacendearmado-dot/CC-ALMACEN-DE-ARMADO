# Deploy en Render — Almacén de Armado

## 1. Subir los archivos al repo de GitHub

Reemplazá en tu repositorio:

- `server.js`
- `package.json`
- `public/index.html`

Render redespliega solo al detectar el push. Si no, entrá al dashboard de
Render y usá **Manual Deploy → Deploy latest commit**.

## 2. Variables de entorno (Render → Environment)

Estas tres son **obligatorias** antes de usar el sistema en producción:

| Variable | Para qué sirve | Si no la ponés |
|---|---|---|
| `DATABASE_URL` | Conexión a PostgreSQL (Supabase/Render) | No arranca |
| `JWT_SECRET` | Firma las sesiones | Se genera una al azar en cada arranque: **todos los usuarios quedan deslogueados en cada redeploy** |
| `ADMIN_PASSWORD` | Clave inicial del usuario ADMIN | Queda `admin`, que es pública en el código |

Opcional: `CAJERO_PASSWORD` (por defecto `1234`).

Para `JWT_SECRET` usá una cadena larga y aleatoria. Podés generarla así:

    node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

## 3. Primer ingreso

1. Entrá a la URL con el usuario `ADMIN` y la clave que pusiste en `ADMIN_PASSWORD`
2. Verificá que el indicador de arriba a la derecha diga **Nube** (no "Local")
3. Andá a **Configuración → Usuarios** y cambiá las claves de todos los usuarios

Las contraseñas que cambies desde el sistema **ya no se pisan** en los
redeploys: el arranque solo crea los usuarios si no existen.

## 4. Carga inicial de datos

Hacela con el sistema conectado (indicador en **Nube**), así los datos
van directo a la base y los ven todas las sucursales:

1. **Clientes** — Reportes → Importaciones → Importar cartera
2. **Productos** — Productos → Importar (Excel/CSV)
3. **Plantilla de remito** — se sincroniza sola al guardarla desde un admin

## 5. Respaldos

Reportes → Respaldos → **Respaldo completo**. Incluye clientes, movimientos,
facturas, pagos, productos y plantillas. Conviene hacerlo antes de cada
importación masiva.

## Permisos por rol

La API valida los roles del lado del servidor, no solo escondiendo botones:

| Acción | admin | administracion | cajero / vendedor |
|---|---|---|---|
| Ver clientes y movimientos | sí | sí | sí |
| Crear / editar clientes | sí | sí | no |
| Registrar pagos y facturas | sí | sí | sí |
| Ajustes manuales de saldo | sí | no | no |
| Borrar clientes o productos | sí | no | no |
| Importaciones masivas | sí | no | no |
| Editar plantillas de impresión | sí | no | no |
| Gestionar usuarios y configuración | sí | no | no |


---

# Conectar la consulta a ARCA (opcional, se puede hacer después)

El sistema ya tiene todo implementado. Al cargar un cliente, el botón
**🔎 ARCA** al lado del CUIT trae razón social, domicilio y condición
frente al IVA. Hasta que se carguen las credenciales, el botón explica
qué falta y el CUIT se sigue cargando a mano.

## Paso 1 — Habilitar el servicio en ARCA

Con clave fiscal de una **persona física** (no de la sociedad):

1. ARCA → **Administrador de Relaciones de Clave Fiscal** → Adherir Servicio
2. Buscar y adherir **Administrador de Certificados Digitales**

## Paso 2 — Generar la clave privada y el CSR

En cualquier computadora con openssl (o pedímelo y lo genero):

    openssl genrsa -out almacen.key 2048
    openssl req -new -key almacen.key -subj "/C=AR/O=Almacen de Armado/CN=cuenta-corriente/serialNumber=CUIT 30715081284" -out almacen.csr

Reemplazar el CUIT por el de la empresa. **La clave privada `almacen.key`
no se comparte con nadie y no se puede recuperar si se pierde.**

## Paso 3 — Obtener el certificado

1. ARCA → **Administrador de Certificados Digitales** → Agregar alias
2. Poner un alias descriptivo (ej: `cuenta-corriente`) y subir `almacen.csr`
3. Descargar el certificado que emite ARCA (`almacen.crt`)

## Paso 4 — Autorizar el servicio de padrón

1. ARCA → **Administrador de Relaciones de Clave Fiscal** → Nueva Relación
2. Buscar → ARCA → Web Services → **Consulta a Padrón Constancia de
   Inscripción** (`ws_sr_constancia_inscripcion`)
3. Asociarlo al alias creado en el paso 3

## Paso 5 — Cargar las credenciales en Render

En Render → Environment, agregar:

| Variable | Contenido |
|---|---|
| `ARCA_CUIT` | CUIT de la empresa, solo números |
| `ARCA_CERT` | Contenido completo del archivo `almacen.crt` |
| `ARCA_KEY` | Contenido completo del archivo `almacen.key` |
| `ARCA_ENV` | `produccion` (o `homologacion` para probar) |

Al redesplegar, el botón queda activo automáticamente. No hay que tocar
código.

## Notas

- El certificado **vence a los 24 meses**: hay que repetir los pasos 2 y 3.
- Si ya se emiten facturas electrónicas por sistema, probablemente ya
  exista un certificado: alcanza con hacer el **paso 4** sobre ese alias.
- La consulta a ARCA solo la pueden hacer usuarios **admin** o
  **administración**, no cajeros.
- El token de acceso se reutiliza 12 horas: ARCA bloquea si se piden
  demasiados seguidos.
