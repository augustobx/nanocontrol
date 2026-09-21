# Nanocontrol

Panel interno para observar las aplicaciones productivas de Nanolabs, consultar métricas desde Glances y gestionar backups sin ejecutar comandos dentro de los contenedores existentes.

## Qué incluye

- Estado HTTP de las nueve aplicaciones relevadas.
- CPU y RAM combinadas de sus contenedores, obtenidas desde la API de Glances.
- Inventario de backups existentes y registro de cada descarga.
- Dumps consistentes por conexión de red: PostgreSQL, MySQL/MariaDB y SQLite.
- Programación por aplicación y copia opcional a Google Drive con `rclone`.
- Registro persistente en SQLite propio de Nanocontrol.
- Acceso protegido con autenticación HTTP Basic.

## Límites de seguridad

Nanocontrol no monta `/var/run/docker.sock`, no utiliza `docker exec` y no modifica contenedores existentes. Los archivos de entorno de cada aplicación y los directorios históricos de backups se montan como solo lectura. Los nuevos backups se guardan únicamente en `/opt/backups/nanocontrol`.

## Desarrollo local

Requiere Node.js 22.13 o superior.

```bash
npm start
```

En desarrollo, si no se definen `ADMIN_USER` y `ADMIN_PASSWORD`, la autenticación queda desactivada. En producción ambas variables son obligatorias.

## Producción

El despliegue previsto vive en `/opt/apps/nanocontrol`. Antes de iniciarlo deben existir:

- `/opt/apps/nanocontrol/.env.production`, creado desde `.env.example` con una contraseña nueva.
- `/opt/apps/nanocontrol/data` para la base del panel.
- `/opt/apps/nanocontrol/secrets` para la configuración de Drive.
- `/opt/backups/nanocontrol` para los nuevos archivos.

El servicio publica `127.0.0.1:4173`, por lo que puede probarse sin exposición pública mediante un túnel SSH:

```bash
ssh -p 2207 -L 4173:127.0.0.1:4173 augusto@149.50.159.163
```

Luego se abre `http://127.0.0.1:4173` en el navegador. La publicación con dominio y TLS debe añadirse al proxy solo después de validar el panel por túnel y con autorización explícita.

## Google Drive

Actualización 1.0.1 instalada el 11/09/2026: cuenta augustobasquez@gmail.com autorizada, remote `nanolabs-drive` anclado mediante `root_folder_id` a `18r527x6Vubak5BMRC1QZT6O3-YG1wb-A` (Backups sistemas). En producción `RCLONE_PATH=/` evita duplicar la carpeta raíz. Cada aplicación usa su nombre como subcarpeta y cada archivo incluye fecha/hora UTC de generación. Se verificó desde el servidor la subida del archivo sin datos productivos `NanoControl/conexion-drive_2026-09-11T22-36-32-134Z.txt` (64 bytes) y su existencia en Drive. Se conservó rollback en `/opt/apps/nanocontrol/rollback-before-drive-1.0.1`.

Google Auth continúa en modo Prueba: conexión temporal, no considerar resuelta su continuidad para automatización hasta pasar a Producción y renovar autorización si corresponde. No se validaron dumps productivos ni restauraciones. La API autenticada `POST /api/drive/test` permite verificar una subida de texto sin consultar bases productivas.

El archivo `rclone.conf` debe quedar en `/opt/apps/nanocontrol/secrets/rclone.conf`, con un remote cuyo nombre coincida con `RCLONE_REMOTE`. Nanocontrol nunca expone el contenido de ese archivo. Si falta, los backups locales siguen funcionando y el panel muestra Drive como pendiente.

## Despliegue del 10 de septiembre de 2026

Instalado en `/opt/apps/nanocontrol`, servicio `nanocontrol`, puerto interno 4173 y red externa `proxy`. En Nginx Proxy Manager configurar `control.nanolabs.com.ar`, esquema HTTP, destino `nanocontrol`, puerto `4173`, certificado válido y Force SSL. No publicar el puerto 4173 en todas las interfaces.

Usuario inicial: `augusto`. La contraseña aleatoria está únicamente en `.env.production` del servidor (permisos 600); consultarla por SSH con `sudo` sin compartirla en chats. Las credenciales del panel son independientes de SSH.

Verificados autenticación, recursos estáticos, nueve estados HTTP y métricas reales de Glances. Backups automáticos inicialmente desactivados. No se generaron dumps productivos ni se validó su restauración durante este despliegue. Google Drive requiere autorización y configuración del remote. Los archivos históricos se inventarían, no se certifica su integridad.

La fecha de descarga indica transferencia HTTP completada, no confirma que el navegador haya guardado físicamente el archivo. Los respaldos nuevos se serializan, usan archivos parciales, límite de ejecución de 30 minutos y un mínimo inicial de 10 GB libres. No hay borrado automático por retención. MySQL/MariaDB requiere tablas transaccionales para consistencia con single-transaction; operaciones DDL concurrentes pueden afectar los dumps.

Los montajes de origen son de solo lectura. `DAC_READ_SEARCH` permite leer archivos protegidos dentro de esos montajes sin dar acceso al control de Docker. Solo el directorio propio de configuración de rclone es escribible para permitir renovar tokens OAuth. Recursos limitados a 1 CPU, 768 MB y 64 procesos.
