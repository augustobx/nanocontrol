# NanoControl

Panel interno de NanoLabs para observar aplicaciones productivas, consultar métricas desde Glances y gestionar backups locales y externos sin ejecutar comandos dentro de los contenedores existentes.

**Versión actual: 1.1.1**

## Qué incluye

- Estado HTTP y consumo de CPU/RAM de las aplicaciones productivas.
- Dumps consistentes de PostgreSQL, MySQL/MariaDB y SQLite.
- Historial de backups, descargas y origen manual/automático.
- Automatización configurable por aplicación:
  - cada N horas;
  - todos los días a una hora;
  - días específicos de la semana;
  - día específico del mes;
  - fecha y hora única.
- Próxima ejecución visible por aplicación y resumen de todos los procesos automatizados.
- Copia opcional a Google Drive mediante `rclone`.
- Diagnóstico de Drive con etapa del fallo y salida útil de `rclone`.
- Reintento de Drive para un backup local ya generado.
- Registro persistente en SQLite propio de NanoControl.
- Acceso protegido con autenticación HTTP Basic.

## Seguridad

NanoControl no monta `/var/run/docker.sock`, no usa `docker exec` y no modifica los contenedores de las aplicaciones.

Los archivos de entorno productivos y directorios históricos se montan como solo lectura. Los nuevos backups se escriben únicamente en `/opt/backups/nanocontrol`.

El contenedor mantiene:

- filesystem de aplicación en modo `read_only`;
- `cap_drop: ALL`;
- únicamente `DAC_READ_SEARCH` para leer montajes protegidos;
- `no-new-privileges`;
- límite de 1 CPU, 768 MB de RAM y 64 procesos;
- puerto 4173 publicado solo en `127.0.0.1`.

## Producción

Ruta:

```text
/opt/apps/nanocontrol
```

Archivos/directorios protegidos que no se versionan:

```text
.env.production
data/
secrets/
staging-drive/
rollback-before-drive-*/
```

El servicio se publica mediante Nginx Proxy Manager en:

```text
https://control.nanolabs.com.ar
```

El contenedor productivo de esta versión es:

```text
nanocontrol:1.1.1
```

## Configuración

Ejemplo:

```dotenv
ADMIN_USER=augusto
ADMIN_PASSWORD=use-una-clave-larga-y-unica
RCLONE_REMOTE=nanolabs-drive
RCLONE_PATH=/
BACKUP_TIME_ZONE=America/Argentina/Buenos_Aires
```

Las credenciales reales permanecen únicamente en `.env.production`.

## Automatización 1.1.1

La configuración de cada aplicación se guarda en la SQLite propia del panel. La actualización desde 1.0.1 realiza una migración aditiva automática al arrancar y conserva aplicaciones, historial y configuración existente.

Modos disponibles:

- **Intervalo:** cada 1 a 720 horas.
- **Diario:** todos los días a una hora concreta.
- **Semanal:** uno o más días, a una hora concreta.
- **Mensual:** un día del mes entre 1 y 31 y una hora.
- **Una vez:** fecha y hora puntual.

La zona horaria por defecto es `America/Argentina/Buenos_Aires`.

Un backup manual no altera la próxima ejecución automática. Los backups automáticos se identifican en el historial como tales.

## Google Drive

El remote productivo `nanolabs-drive` está anclado mediante `root_folder_id` a la carpeta de Drive **Backups sistemas**. Por ese motivo `RCLONE_PATH=/` representa la raíz correcta dentro de ese remote.

El archivo:

```text
/opt/apps/nanocontrol/secrets/rclone.conf
```

debe contener el remote cuyo nombre coincide con `RCLONE_REMOTE`.

### Diagnóstico

Desde el panel, **Probar Drive**:

1. valida que exista `RCLONE_REMOTE`;
2. valida que exista `rclone.conf`;
3. ejecuta una prueba real de subida con un archivo de texto sin datos productivos;
4. elimina el archivo de prueba local;
5. muestra la etapa exacta del fallo: configuración, creación de carpeta o subida;
6. conserva el último estado y detalle de error en la SQLite de NanoControl.

Cuando una copia a Drive falla después de generar correctamente el dump, el backup local sigue quedando disponible y puede usarse **Reintentar Drive** sin volver a leer la base productiva.

Los mensajes de diagnóstico se filtran para no mostrar tokens, contraseñas ni secretos conocidos.

## Backups

Antes de comenzar un dump se exigen al menos 10 GB libres.

Los nuevos archivos se generan primero con extensión parcial y solo se renombran al nombre final cuando la operación termina correctamente.

Formatos:

- PostgreSQL: formato custom de `pg_dump`.
- MySQL/MariaDB: SQL comprimido con gzip y `--single-transaction`.
- SQLite: backup consistente mediante `sqlite3 .backup`.

No hay borrado automático por retención en esta versión.

## Desarrollo

Requiere Node.js 22.13 o superior.

```bash
npm run build
npm start
```

En desarrollo, si no se definen `ADMIN_USER` y `ADMIN_PASSWORD`, la autenticación queda desactivada. En producción son obligatorias.

## Despliegue desde Git

Después de validar la versión:

```bash
cd /opt/apps/nanocontrol
git pull --ff-only origin main
docker compose -f compose.production.yml build --pull nanocontrol
docker compose -f compose.production.yml up -d nanocontrol
docker compose -f compose.production.yml ps
```

Luego ejecutar las verificaciones de salud y probar un backup no destructivo antes de habilitar automatizaciones nuevas.


## Diagnóstico Drive 1.1.1

Los errores conocidos de OAuth ya no se muestran como trazas completas en el panel. NanoControl los clasifica y muestra una causa breve y una acción recomendada. El detalle técnico sanitizado queda disponible en el estado interno y en logs del contenedor para diagnóstico avanzado.
