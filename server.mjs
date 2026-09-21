import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, statfs, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const APP_VERSION = '1.1.2';
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const sourceRoot = path.resolve(process.env.BACKUP_SOURCE_ROOT || '/sources');
const glancesUrl = (process.env.GLANCES_URL || '').replace(/\/$/, '');
const port = Number(process.env.PORT || 4173);
const defaultTimeZone = process.env.BACKUP_TIME_ZONE || 'America/Argentina/Buenos_Aires';

if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD)) {
  throw new Error('Credenciales administrativas obligatorias');
}

const childEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: '/tmp' };
await mkdir(backupDir, { recursive: true });

const seedApps = [
  ['OnlyFood','onlyfood','https://onlyfood.nanoapps.ar','onlyfood-app-1,onlyfood-db-1','mariadb','onlyfood-db-1',3306,'/run/app-env/onlyfood.env','DB_NAME','DB_USER','DB_PASSWORD','','/legacy-backups/onlyfood'],
  ['OnlyERP · Tommasi','onlyerp','https://onlyerp.nanoapps.ar','onlyerp-web,onlyerp-db','mysql','onlyerp-db',3306,'/run/app-env/onlyerp.env','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD','','/legacy-backups/onlyerp'],
  ['OnlyPadel','onlypadel','https://onlypadel.nanoapps.ar','onlypadel-web,onlypadel-db','mariadb','onlypadel-db',3306,'/run/app-env/onlypadel.env','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD','',''],
  ['OnlyGym','onlygym','https://onlygym.nanoapps.ar','onlygym-web,onlygym-db','postgres','onlygym-db',5432,'/run/app-env/onlygym.env','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','',''],
  ['OnlyCars','onlycars','https://onlycars.nanoapps.ar','onlycars-app-1,onlycars-db-1','mariadb','onlycars-db-1',3306,'/run/app-env/onlycars.env','DB_NAME','DB_USER','DB_PASSWORD','','/legacy-backups/onlycars'],
  ['OnlyMob','onlymob','https://onlymob.nanoapps.ar','onlymob-web,onlymob-db','mariadb','onlymob-db',3306,'/run/app-env/onlymob.env','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD','','/legacy-backups/onlymob'],
  ['OnlyTurn','onlyturn','https://onlyturn.nanoapps.ar','onlyturn-web,onlyturn-db','postgres','onlyturn-db',5432,'/run/app-env/onlyturn.env','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','','/legacy-backups/onlyturn'],
  ['NanoKeys','nanokeys','https://keys.nanolabs.online','nanokeys-nanokeys-web-1,nanokeys-nanokeys-api-1','sqlite','',0,'','','','','nanokeys/identity.sqlite','/legacy-backups/nanokeys'],
  ['Nanolabs','nanolabs','https://nanolabs.com.ar','nanolabs-web-1,nanolabs-postgres-1','postgres','nanolabs-postgres-1',5432,'/run/app-env/nanolabs.env','POSTGRES_DB','POSTGRES_USER','POSTGRES_PASSWORD','',''],
];

const db = new DatabaseSync(path.join(dataDir, 'nanocontrol.sqlite'));
db.exec([
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'CREATE TABLE IF NOT EXISTS applications (',
  ' id INTEGER PRIMARY KEY,',
  ' name TEXT NOT NULL,',
  ' slug TEXT NOT NULL UNIQUE,',
  " url TEXT NOT NULL DEFAULT '',",
  " health_url TEXT NOT NULL DEFAULT '',",
  " container_names TEXT NOT NULL DEFAULT '',",
  " db_type TEXT NOT NULL CHECK (db_type IN ('postgres','mysql','mariadb','sqlite','none')),",
  " db_host TEXT NOT NULL DEFAULT '',",
  ' db_port INTEGER,',
  " env_file TEXT NOT NULL DEFAULT '',",
  " db_name_key TEXT NOT NULL DEFAULT '',",
  " db_user_key TEXT NOT NULL DEFAULT '',",
  " db_password_key TEXT NOT NULL DEFAULT '',",
  " sqlite_path TEXT NOT NULL DEFAULT '',",
  " legacy_backup_path TEXT NOT NULL DEFAULT '',",
  ' schedule_enabled INTEGER NOT NULL DEFAULT 0,',
  ' interval_hours INTEGER NOT NULL DEFAULT 24,',
  ' next_backup_at TEXT,',
  ' drive_enabled INTEGER NOT NULL DEFAULT 1,',
  ' created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS backups (',
  ' id INTEGER PRIMARY KEY,',
  ' application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,',
  ' filename TEXT NOT NULL,',
  ' file_path TEXT NOT NULL UNIQUE,',
  ' size_bytes INTEGER NOT NULL DEFAULT 0,',
  ' status TEXT NOT NULL,',
  " source TEXT NOT NULL DEFAULT 'nanocontrol',",
  " drive_status TEXT NOT NULL DEFAULT 'pending',",
  ' error TEXT,',
  ' created_at TEXT NOT NULL,',
  ' downloaded_at TEXT',
  ');',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE INDEX IF NOT EXISTS idx_backups_application_created ON backups(application_id, created_at DESC);',
  'CREATE INDEX IF NOT EXISTS idx_applications_schedule ON applications(schedule_enabled, next_backup_at);'
].join('\n'));

function tableColumns(table) {
  return new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
}

function ensureColumn(table, name, definition) {
  const columns = tableColumns(table);
  if (!columns.has(name)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
}

ensureColumn('applications', 'schedule_type', "TEXT NOT NULL DEFAULT 'interval'");
ensureColumn('applications', 'schedule_time', "TEXT NOT NULL DEFAULT '03:00'");
ensureColumn('applications', 'schedule_days', "TEXT NOT NULL DEFAULT ''");
ensureColumn('applications', 'schedule_day_of_month', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('applications', 'schedule_once_at', 'TEXT');
ensureColumn('applications', 'schedule_timezone', "TEXT NOT NULL DEFAULT '" + defaultTimeZone.replaceAll("'", "''") + "'");
ensureColumn('applications', 'last_schedule_run_at', 'TEXT');
ensureColumn('applications', 'last_schedule_error', 'TEXT');
ensureColumn('backups', 'drive_error', 'TEXT');
ensureColumn('backups', 'drive_attempted_at', 'TEXT');
ensureColumn('backups', 'trigger_type', "TEXT NOT NULL DEFAULT 'manual'");

db.exec('PRAGMA optimize;');

const now = () => new Date().toISOString();
const slugify = value => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48);

const q = {
  seed: db.prepare('INSERT OR IGNORE INTO applications (name,slug,url,health_url,container_names,db_type,db_host,db_port,env_file,db_name_key,db_user_key,db_password_key,sqlite_path,legacy_backup_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  apps: db.prepare([
    'SELECT a.*,',
    "(SELECT b.created_at FROM backups b WHERE b.application_id=a.id AND b.status='ready' ORDER BY b.created_at DESC LIMIT 1) last_backup_at,",
    "(SELECT b.downloaded_at FROM backups b WHERE b.application_id=a.id AND b.status='ready' AND b.downloaded_at IS NOT NULL ORDER BY b.downloaded_at DESC LIMIT 1) last_downloaded_at,",
    "(SELECT b.drive_status FROM backups b WHERE b.application_id=a.id AND b.status='ready' ORDER BY b.created_at DESC LIMIT 1) last_drive_status,",
    "(SELECT b.drive_error FROM backups b WHERE b.application_id=a.id AND b.status='ready' ORDER BY b.created_at DESC LIMIT 1) last_drive_error,",
    "(SELECT b.trigger_type FROM backups b WHERE b.application_id=a.id ORDER BY b.created_at DESC LIMIT 1) last_trigger_type",
    'FROM applications a ORDER BY a.name'
  ].join(' ')),
  app: db.prepare('SELECT * FROM applications WHERE id=?'),
  due: db.prepare("SELECT id FROM applications WHERE schedule_enabled=1 AND next_backup_at IS NOT NULL AND next_backup_at<=? ORDER BY next_backup_at"),
  backups: db.prepare('SELECT b.*,a.name application_name FROM backups b JOIN applications a ON a.id=b.application_id ORDER BY b.created_at DESC LIMIT 80'),
  backup: db.prepare('SELECT b.*,a.name application_name FROM backups b JOIN applications a ON a.id=b.application_id WHERE b.id=?'),
  insertApp: db.prepare('INSERT INTO applications (name,slug,url,health_url,container_names,db_type,db_host,db_port,env_file,db_name_key,db_user_key,db_password_key,sqlite_path,legacy_backup_path,schedule_enabled,interval_hours,next_backup_at,drive_enabled,schedule_type,schedule_time,schedule_days,schedule_day_of_month,schedule_once_at,schedule_timezone,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  insertBackup: db.prepare('INSERT OR IGNORE INTO backups (application_id,filename,file_path,size_bytes,status,source,drive_status,drive_error,drive_attempted_at,trigger_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  readyBackup: db.prepare("UPDATE backups SET status='ready',size_bytes=?,drive_status=?,drive_error=?,drive_attempted_at=?,error=NULL WHERE id=?"),
  failBackup: db.prepare("UPDATE backups SET status='failed',error=? WHERE id=?"),
  driveResult: db.prepare('UPDATE backups SET drive_status=?,drive_error=?,drive_attempted_at=? WHERE id=?'),
  downloaded: db.prepare('UPDATE backups SET downloaded_at=? WHERE id=?'),
  updateSchedule: db.prepare('UPDATE applications SET schedule_enabled=?,interval_hours=?,next_backup_at=?,drive_enabled=?,schedule_type=?,schedule_time=?,schedule_days=?,schedule_day_of_month=?,schedule_once_at=?,schedule_timezone=?,last_schedule_error=NULL WHERE id=?'),
  scheduleRun: db.prepare('UPDATE applications SET next_backup_at=?,last_schedule_run_at=?,last_schedule_error=? WHERE id=?'),
  disableOnce: db.prepare('UPDATE applications SET schedule_enabled=0,next_backup_at=NULL,last_schedule_run_at=?,last_schedule_error=? WHERE id=?'),
  deleteApp: db.prepare('DELETE FROM applications WHERE id=?'),
  setting: db.prepare('SELECT value FROM settings WHERE key=?'),
  upsertSetting: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
};

for (const app of seedApps) {
  const [name, slug, url, ...rest] = app;
  q.seed.run(name, slug, url, url, ...rest, now());
}

if (!q.setting.get('drive_backups_enabled')) q.upsertSetting.run('drive_backups_enabled','0');

function globalDriveEnabled() {
  return q.setting.get('drive_backups_enabled')?.value === '1';
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hourCycle:'h23'
  }).formatToParts(date);
  const result = {};
  for (const item of parts) if (item.type !== 'literal') result[item.type] = Number(item.value);
  return result;
}

function zoneOffsetMs(date, timeZone) {
  const p = localParts(date, timeZone);
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second) - date.getTime();
}

function zonedToUtc(year, month, day, hour, minute, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  const corrected = new Date(naive - zoneOffsetMs(result, timeZone));
  if (corrected.getTime() !== result.getTime()) result = corrected;
  return result;
}

function addCalendarDays(parts, amount) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate() };
}

function validCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function parseTime(value) {
  const match = String(value || '03:00').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error('La hora debe tener formato HH:MM');
  return { hour:Number(match[1]), minute:Number(match[2]), text:match[1] + ':' + match[2] };
}

function parseOnce(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('La fecha programada no es válida');
  return { year:Number(match[1]), month:Number(match[2]), day:Number(match[3]), hour:Number(match[4]), minute:Number(match[5]) };
}

function normalizeDays(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const days = [...new Set(raw.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a,b) => a-b);
  return days;
}

function nextScheduleAt(app, from = new Date()) {
  if (!app.schedule_enabled) return null;
  const type = app.schedule_type || 'interval';
  const timeZone = app.schedule_timezone || defaultTimeZone;

  if (type === 'interval') {
    const hours = Math.max(1, Math.min(720, Number(app.interval_hours) || 24));
    return new Date(from.getTime() + hours * 3600000).toISOString();
  }

  if (type === 'once') {
    if (!app.schedule_once_at) return null;
    const p = parseOnce(app.schedule_once_at);
    const candidate = zonedToUtc(p.year,p.month,p.day,p.hour,p.minute,timeZone);
    return candidate > from ? candidate.toISOString() : null;
  }

  const time = parseTime(app.schedule_time || '03:00');
  const current = localParts(from, timeZone);
  const base = { year:current.year, month:current.month, day:current.day };

  if (type === 'daily') {
    for (let offset = 0; offset <= 2; offset++) {
      const d = addCalendarDays(base, offset);
      const candidate = zonedToUtc(d.year,d.month,d.day,time.hour,time.minute,timeZone);
      if (candidate > from) return candidate.toISOString();
    }
  }

  if (type === 'weekly') {
    const allowed = normalizeDays(app.schedule_days);
    if (!allowed.length) throw new Error('Elegí al menos un día para la programación semanal');
    for (let offset = 0; offset <= 14; offset++) {
      const d = addCalendarDays(base, offset);
      const weekday = new Date(Date.UTC(d.year,d.month-1,d.day)).getUTCDay();
      if (!allowed.includes(weekday)) continue;
      const candidate = zonedToUtc(d.year,d.month,d.day,time.hour,time.minute,timeZone);
      if (candidate > from) return candidate.toISOString();
    }
  }

  if (type === 'monthly') {
    const day = Math.max(1, Math.min(31, Number(app.schedule_day_of_month) || 1));
    for (let offset = 0; offset <= 24; offset++) {
      const monthDate = new Date(Date.UTC(base.year, base.month - 1 + offset, 1));
      const year = monthDate.getUTCFullYear();
      const month = monthDate.getUTCMonth() + 1;
      if (!validCalendarDate(year, month, day)) continue;
      const candidate = zonedToUtc(year,month,day,time.hour,time.minute,timeZone);
      if (candidate > from) return candidate.toISOString();
    }
  }

  return null;
}

function normalizedSchedule(input, current) {
  const enabled = !!input.enabled;
  const type = ['interval','daily','weekly','monthly','once'].includes(input.type) ? input.type : (current.schedule_type || 'interval');
  const intervalHours = Math.max(1, Math.min(720, Number(input.intervalHours) || Number(current.interval_hours) || 24));
  const scheduleTime = parseTime(input.time || current.schedule_time || '03:00').text;
  const scheduleDays = normalizeDays(input.days ?? current.schedule_days).join(',');
  const dayOfMonth = Math.max(1, Math.min(31, Number(input.dayOfMonth) || Number(current.schedule_day_of_month) || 1));
  const onceAt = input.onceAt ? String(input.onceAt).slice(0,16) : (current.schedule_once_at || null);
  const timeZone = String(input.timeZone || current.schedule_timezone || defaultTimeZone);

  try { new Intl.DateTimeFormat('en-US',{timeZone}).format(new Date()); }
  catch { throw new Error('Zona horaria inválida'); }

  if (enabled && type === 'weekly' && !scheduleDays) throw new Error('Elegí al menos un día');
  if (enabled && type === 'once') parseOnce(onceAt);

  const result = {
    schedule_enabled: enabled ? 1 : 0,
    schedule_type: type,
    interval_hours: intervalHours,
    schedule_time: scheduleTime,
    schedule_days: scheduleDays,
    schedule_day_of_month: dayOfMonth,
    schedule_once_at: onceAt,
    schedule_timezone: timeZone,
    drive_enabled: input.driveEnabled === false ? 0 : 1
  };
  result.next_backup_at = enabled ? nextScheduleAt(result, new Date()) : null;
  if (enabled && !result.next_backup_at) throw new Error('No se pudo calcular la próxima ejecución');
  return result;
}

const backupExtensions = ['.sql','.sql.gz','.dump','.sqlite','.sqlite.gz'];

async function scanFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const found = [];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const full = path.join(dir,entry.name);
    if (entry.isDirectory()) found.push(...await scanFiles(full));
    else if (backupExtensions.some(ext => entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}

async function importLegacyBackups() {
  for (const app of q.apps.all()) {
    for (const filePath of await scanFiles(app.legacy_backup_path)) {
      const info = await stat(filePath);
      q.insertBackup.run(app.id,path.basename(filePath),filePath,info.size,'ready','existing','unknown',null,null,'legacy',info.mtime.toISOString());
    }
  }
}
await importLegacyBackups();
db.prepare("UPDATE backups SET status='failed',error='Proceso interrumpido' WHERE status='running'").run();

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const sendJson = (res,status,value) => {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
};

const safeEqual = (a,b) => {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa,bb);
};

function authorized(req) {
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return process.env.NODE_ENV !== 'production';
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6),'base64').toString();
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return safeEqual(decoded.slice(0,separator),user) && safeEqual(decoded.slice(separator+1),pass);
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1000000) throw new Error('Solicitud demasiado grande');
  }
  return raw ? JSON.parse(raw) : {};
}

function scrubOutput(value) {
  return String(value || '')
    .replace(/(access_token|refresh_token|client_secret|password)\s*[:=]\s*[^\s,}]+/gi,'$1=[OCULTO]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,'Bearer [OCULTO]')
    .trim()
    .slice(-6000);
}

function friendlyDriveError(value) {
  const detail = scrubOutput(value);
  const lower = detail.toLowerCase();

  if (lower.includes('invalid_client') || lower.includes('client secret is invalid')) {
    return {
      code:'invalid_client',
      summary:'Credencial OAuth inválida: el client_secret configurado en Google ya no es válido.',
      action:'Actualizá el OAuth Client de Google y volvé a autorizar nanolabs-drive.',
      detail
    };
  }

  if (lower.includes('invalid_grant') || lower.includes('token has been expired or revoked') || lower.includes('token expired')) {
    return {
      code:'invalid_grant',
      summary:'La autorización de Google venció o fue revocada.',
      action:'Volvé a autorizar nanolabs-drive.',
      detail
    };
  }

  if (lower.includes('access_denied')) {
    return {
      code:'access_denied',
      summary:'Google rechazó la autorización de acceso a Drive.',
      action:'Revisá el usuario autorizado y aceptá los permisos solicitados.',
      detail
    };
  }

  if (lower.includes('insufficient permission') || lower.includes('insufficientpermissions') || lower.includes('403 forbidden')) {
    return {
      code:'permission_denied',
      summary:'La cuenta autorizada no tiene permisos suficientes sobre Google Drive.',
      action:'Revisá el scope de Drive y el acceso a la carpeta raíz configurada.',
      detail
    };
  }

  if (lower.includes('root_folder_id') || lower.includes('directory not found') || lower.includes('404 not found')) {
    return {
      code:'root_not_found',
      summary:'No se pudo acceder a la carpeta raíz configurada en Google Drive.',
      action:'Revisá root_folder_id y que la cuenta autorizada tenga acceso a esa carpeta.',
      detail
    };
  }

  const firstUseful = detail.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(-1)[0] || 'Error desconocido de Google Drive';
  return {
    code:'drive_error',
    summary:firstUseful.slice(0,350),
    action:'Revisá el detalle técnico y la configuración de rclone.',
    detail
  };
}

function run(command,args,options={}) {
  return new Promise((resolve,reject) => {
    const child = spawn(command,args,{
      shell:false,
      timeout:options.timeout || 1800000,
      killSignal:'SIGKILL',
      env:{...childEnv,...(options.env||{})},
      stdio:['ignore','pipe','pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data',d => { stdout += d.toString(); if (stdout.length > 12000) stdout = stdout.slice(-12000); });
    child.stderr.on('data',d => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.once('error',error => {
      const failure = new Error('No se pudo ejecutar ' + command + ': ' + error.message);
      failure.details = scrubOutput(stderr || error.message);
      reject(failure);
    });
    child.once('close',code => {
      if (code === 0) return resolve({stdout:scrubOutput(stdout),stderr:scrubOutput(stderr)});
      const details = scrubOutput(stderr || stdout);
      const failure = new Error(command + ' falló (código ' + code + ')' + (details ? ': ' + details : ''));
      failure.details = details;
      failure.exitCode = code;
      reject(failure);
    });
  });
}

async function runDump(command,args,env,filePath,gzip) {
  const child = spawn(command,args,{
    shell:false,
    timeout:1800000,
    killSignal:'SIGKILL',
    env:{...childEnv,...env},
    stdio:['ignore','pipe','pipe']
  });
  let stderr = '';
  child.stderr.on('data',d => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
  const output = gzip ? createGzip({level:3}) : undefined;
  const streamTask = gzip ? pipeline(child.stdout,output,createWriteStream(filePath)) : pipeline(child.stdout,createWriteStream(filePath));
  const processTask = new Promise((resolve,reject) => {
    child.once('error',error => reject(new Error('No se pudo ejecutar ' + command + ': ' + error.message)));
    child.once('close',code => {
      if (code === 0) return resolve();
      const details = scrubOutput(stderr);
      reject(new Error(command + ' falló (código ' + code + ')' + (details ? ': ' + details : '')));
    });
  });
  try {
    await Promise.all([streamTask,processTask]);
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled([streamTask,processTask]);
    throw error;
  }
}

async function readEnv(filePath) {
  if (!filePath) return {};
  const content = await readFile(filePath,'utf8');
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    values[match[1]] = value;
  }
  return values;
}

function driveConfig() {
  const config = process.env.RCLONE_CONFIG || '/run/secrets/rclone.conf';
  const remote = process.env.RCLONE_REMOTE || '';
  const folder = (process.env.RCLONE_PATH || 'Backups sistemas').replace(/^\/+|\/+$/g,'');
  return {config,remote,folder,configured:!!remote && existsSync(config)};
}

function readDriveHealth() {
  const row = q.setting.get('drive_health');
  if (!row) return {status:'unknown',error:null,action:null,technical:null,code:null,checkedAt:null,stage:null};
  try { return JSON.parse(row.value); }
  catch { return {status:'unknown',error:'Estado de Drive inválido',action:'Volvé a ejecutar la prueba de Drive.',technical:null,code:'state_invalid',checkedAt:null,stage:null}; }
}

function recordDriveHealth(status,error=null,stage=null) {
  const parsed = error ? friendlyDriveError(error) : null;
  const value = {
    status,
    error:parsed?.summary || null,
    action:parsed?.action || null,
    technical:parsed?.detail || null,
    code:parsed?.code || null,
    stage,
    checkedAt:now()
  };
  q.upsertSetting.run('drive_health',JSON.stringify(value));
  return value;
}

function driveFailure(stage,error) {
  const failure = new Error(error?.message || 'Error desconocido de Google Drive');
  failure.stage = stage;
  failure.details = scrubOutput(error?.details || error?.message || '');
  return failure;
}

async function uploadDrive(filePath,filename,appName) {
  const cfg = driveConfig();
  if (!cfg.remote) throw driveFailure('configuration',new Error('RCLONE_REMOTE no está definido'));
  if (!existsSync(cfg.config)) throw driveFailure('configuration',new Error('No existe ' + cfg.config));

  const appFolder = appName.normalize('NFC').replace(/[/\\\x00-\x1f]/g,'_').trim();
  if (!appFolder || appFolder === '.' || appFolder === '..') throw driveFailure('configuration',new Error('Nombre de carpeta inválido'));

  const base = cfg.remote + ':' + (cfg.folder ? cfg.folder + '/' : '') + appFolder;
  try {
    await run('rclone',['--config',cfg.config,'mkdir',base],{timeout:120000});
  } catch (error) {
    const failure = driveFailure('mkdir',error);
    recordDriveHealth('failed',failure.details || failure.message,'mkdir');
    throw failure;
  }

  try {
    await run('rclone',['--config',cfg.config,'copyto',filePath,base + '/' + filename,'--checksum','--immutable'],{timeout:1800000});
    recordDriveHealth('connected',null,'upload');
    return 'uploaded';
  } catch (error) {
    const failure = driveFailure('upload',error);
    recordDriveHealth('failed',failure.details || failure.message,'upload');
    throw failure;
  }
}

async function testDriveConnection() {
  const cfg = driveConfig();
  if (!cfg.remote) throw driveFailure('configuration',new Error('Falta RCLONE_REMOTE en .env.production'));
  if (!existsSync(cfg.config)) throw driveFailure('configuration',new Error('No se encontró rclone.conf en ' + cfg.config));

  try {
    await run('rclone',['--config',cfg.config,'listremotes'],{timeout:30000});
  } catch (error) {
    throw driveFailure('configuration',error);
  }

  const filename = 'conexion-drive_' + now().replace(/[:.]/g,'-') + '.txt';
  const filePath = path.join(backupDir,filename);
  await writeFile(filePath,'Prueba de conexión NanoControl. No contiene datos productivos.\n',{flag:'wx',mode:0o600});
  try {
    await uploadDrive(filePath,filename,'NanoControl');
    return {status:'connected',filename,folder:'NanoControl',checkedAt:now()};
  } finally {
    await rm(filePath,{force:true}).catch(()=>{});
  }
}

let backupBusy = false;
let activeBackup = null;

async function createBackup(appId, triggerType='manual') {
  if (backupBusy) {
    const suffix = activeBackup ? ' (' + activeBackup.appName + ')' : '';
    throw new Error('Ya hay un backup en curso' + suffix + '. Esperá a que termine.');
  }
  const app = q.app.get(appId);
  if (!app) throw new Error('Aplicación no encontrada');
  backupBusy = true;
  activeBackup = {appId,appName:app.name,triggerType,startedAt:now()};
  try { return await performBackup(app,triggerType); }
  finally { backupBusy = false; activeBackup = null; }
}

async function performBackup(app,triggerType) {
  if (app.db_type === 'none') throw new Error('No hay una base configurada');
  const disk = await statfs(backupDir);
  if (disk.bavail * disk.bsize < 10 * 1024 ** 3) throw new Error('Se requieren al menos 10 GB libres para iniciar un backup');

  const stamp = now().replace(/[:.]/g,'-');
  const extension = app.db_type === 'postgres' ? '.dump' : app.db_type === 'sqlite' ? '.sqlite' : '.sql.gz';
  const appDir = path.join(backupDir,app.slug);
  await mkdir(appDir,{recursive:true});
  const filename = app.slug + '_' + stamp + extension;
  const filePath = path.join(appDir,filename);
  const shouldUploadToDrive = globalDriveEnabled() && !!app.drive_enabled;
  const inserted = q.insertBackup.run(
    app.id,filename,filePath,0,'running','nanocontrol',
    shouldUploadToDrive ? 'pending' : 'disabled',
    null,null,triggerType,now()
  );
  const backupId = Number(inserted.lastInsertRowid);
  const partialPath = filePath + '.partial';

  try {
    if (app.db_type === 'sqlite') {
      const source = path.resolve(sourceRoot,app.sqlite_path.replace(/^[/\\]+/,''));
      if (!(source === sourceRoot || source.startsWith(sourceRoot + path.sep))) throw new Error('Ruta SQLite fuera del directorio permitido');
      await run('sqlite3',['-readonly',source,".backup '" + partialPath.replaceAll("'","''") + "'"]);
    } else {
      const values = await readEnv(app.env_file);
      const dbName = values[app.db_name_key], dbUser = values[app.db_user_key], dbPassword = values[app.db_password_key];
      if (!dbName || !dbUser || !dbPassword) throw new Error('Faltan variables de conexión en el archivo de entorno montado');

      if (app.db_type === 'postgres') {
        await run('pg_dump',[
          '--host',app.db_host,
          '--port',String(app.db_port || 5432),
          '--username',dbUser,
          '--dbname',dbName,
          '--format=custom',
          '--no-owner','--no-acl',
          '--lock-wait-timeout=5s',
          '--file',partialPath
        ],{env:{PGPASSWORD:dbPassword,PGCONNECT_TIMEOUT:'10'}});
      } else {
        await runDump('mariadb-dump',[
          '--host=' + app.db_host,
          '--port=' + (app.db_port || 3306),
          '--user=' + dbUser,
          '--single-transaction','--quick','--skip-lock-tables','--no-tablespaces',
          '--routines','--triggers','--events','--hex-blob',
          '--default-character-set=utf8mb4',dbName
        ],{MYSQL_PWD:dbPassword},partialPath,true);
      }
    }

    if (!(await stat(partialPath)).size) throw new Error('El backup está vacío');
    await rename(partialPath,filePath);
    const info = await stat(filePath);

    let driveStatus = shouldUploadToDrive ? 'pending' : 'disabled';
    let driveError = null;
    let driveAttemptedAt = null;

    if (shouldUploadToDrive) {
      driveAttemptedAt = now();
      try {
        driveStatus = await uploadDrive(filePath,filename,app.name);
      } catch (error) {
        driveStatus = 'failed';
        const parsed = friendlyDriveError(error.details || error.message);
        driveError = parsed.summary + ' ' + parsed.action;
        console.error('Drive [' + (error.stage || 'unknown') + ']:',parsed.detail);
      }
    }

    q.readyBackup.run(info.size,driveStatus,driveError,driveAttemptedAt,backupId);
    return q.backup.get(backupId);
  } catch (error) {
    await rm(partialPath,{force:true}).catch(()=>{});
    q.failBackup.run(String(error.message).slice(0,1000),backupId);
    throw error;
  }
}

async function retryDrive(backupId) {
  if (!globalDriveEnabled()) throw new Error('Google Drive está desactivado en Configuración.');
  const backup = q.backup.get(backupId);
  if (!backup || backup.status !== 'ready' || !existsSync(backup.file_path)) throw new Error('Backup no disponible');
  try {
    const status = await uploadDrive(backup.file_path,backup.filename,backup.application_name);
    q.driveResult.run(status,null,now(),backup.id);
  } catch (error) {
    const parsed = friendlyDriveError(error.details || error.message);
    const message = parsed.summary + ' ' + parsed.action;
    q.driveResult.run('failed',message,now(),backup.id);
    console.error('Drive retry [' + (error.stage || 'unknown') + ']:',parsed.detail);
    throw new Error(message);
  }
  return q.backup.get(backup.id);
}

async function getJson(url) {
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(5000)});
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function health(url) {
  if (!url) return 'unknown';
  try {
    const response = await fetch(url,{signal:AbortSignal.timeout(7000),redirect:'follow'});
    return response.ok ? 'online' : response.status < 500 ? 'degraded' : 'offline';
  } catch { return 'offline'; }
}

async function monitor() {
  if (!glancesUrl) return null;
  const [containers,cpu,mem,system,uptime] = await Promise.all(
    ['containers','cpu','mem','system','uptime'].map(plugin => getJson(glancesUrl + '/api/4/' + plugin))
  );
  return {containers:Array.isArray(containers)?containers:[],cpu,mem,system,uptime};
}

function usageFor(containerNames,containers) {
  const wanted = containerNames.split(',').map(v=>v.trim()).filter(Boolean);
  const rows = containers.filter(c=>wanted.includes(c.name));
  if (!rows.length) return null;
  return {
    cpu:Number(rows.reduce((sum,c)=>sum+Number(c.cpu_percent||c.cpu?.total||0),0).toFixed(1)),
    memoryBytes:rows.reduce((sum,c)=>sum+Number(c.memory_usage||c.memory?.usage||0),0),
    containers:rows.map(c=>({name:c.name,status:c.status||'unknown'}))
  };
}

function scheduleDescription(app) {
  if (!app.schedule_enabled) return 'Manual';
  const time = app.schedule_time || '03:00';
  if (app.schedule_type === 'interval') return 'Cada ' + app.interval_hours + ' h';
  if (app.schedule_type === 'daily') return 'Diario · ' + time;
  if (app.schedule_type === 'weekly') return 'Semanal · ' + time;
  if (app.schedule_type === 'monthly') return 'Día ' + app.schedule_day_of_month + ' · ' + time;
  if (app.schedule_type === 'once') return 'Una vez · ' + (app.schedule_once_at || 'sin fecha');
  return 'Automático';
}

async function dashboard() {
  const telemetry = await monitor();
  const rows = q.apps.all();
  const apps = await Promise.all(rows.map(async app => {
    const usage = usageFor(app.container_names,telemetry?.containers||[]);
    const httpHealth = await health(app.health_url||app.url);
    const containersRunning = usage?.containers?.length && usage.containers.every(container=>container.status==='running');
    return {
      ...app,
      schedule_enabled:!!app.schedule_enabled,
      drive_enabled:!!app.drive_enabled,
      schedule_days:normalizeDays(app.schedule_days),
      schedule_description:scheduleDescription(app),
      health:httpHealth,
      containersRunning:!!containersRunning,
      usage
    };
  }));

  const total = Number(telemetry?.mem?.total || os.totalmem());
  const available = Number(telemetry?.mem?.available || os.freemem());
  const drive = driveConfig();
  const driveHealth = readDriveHealth();

  return {
    version:APP_VERSION,
    server:{
      hostname:telemetry?.system?.hostname || os.hostname(),
      uptime:telemetry?.uptime || null,
      uptimeSeconds:os.uptime(),
      telemetryAvailable:!!telemetry?.cpu,
      cpuPercent:telemetry?.cpu ? Number(telemetry.cpu.total) : null,
      cpuCount:Number(telemetry?.cpu?.cpucore || os.cpus().length),
      memoryUsed:total-available,
      memoryTotal:total
    },
    automation:{
      activeBackup,
      enabledCount:apps.filter(app=>app.schedule_enabled).length,
      timeZone:defaultTimeZone
    },
    drive:{
      enabled:globalDriveEnabled(),
      configured:drive.configured,
      remote:drive.remote || null,
      path:drive.folder || '/',
      ...driveHealth
    },
    apps,
    backups:q.backups.all(),
    updatedAt:now()
  };
}

function normalizedApp(input) {
  const name = String(input.name||'').trim();
  if (!name) throw new Error('El nombre es obligatorio');
  const dbType = ['postgres','mysql','mariadb','sqlite','none'].includes(input.dbType) ? input.dbType : 'none';
  return {
    name,
    slug:slugify(input.slug||name),
    url:String(input.url||'').trim(),
    containerNames:String(input.containerNames||'').trim(),
    dbType,
    dbHost:String(input.dbHost||'').trim(),
    dbPort:Number(input.dbPort)||null,
    driveEnabled:input.driveEnabled !== false ? 1 : 0
  };
}

async function api(req,res,url) {
  if (req.method === 'GET' && url.pathname === '/api/healthz') return sendJson(res,200,{ok:true,version:APP_VERSION});
  if (req.method === 'GET' && url.pathname === '/api/dashboard') return sendJson(res,200,await dashboard());

  if (req.method === 'PUT' && url.pathname === '/api/settings/drive') {
    try {
      const input = await bodyJson(req);
      q.upsertSetting.run('drive_backups_enabled',input.enabled ? '1' : '0');
      return sendJson(res,200,{enabled:globalDriveEnabled()});
    } catch (error) {
      return sendJson(res,400,{error:error.message});
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/drive/test') {
    try {
      const result = await testDriveConnection();
      recordDriveHealth('connected',null,'test');
      return sendJson(res,200,result);
    } catch (error) {
      const parsed = friendlyDriveError(error.details || error.message);
      const health = recordDriveHealth('failed',parsed.detail,error.stage || 'test');
      return sendJson(res,503,{
        error:parsed.summary,
        action:parsed.action,
        code:parsed.code,
        stage:error.stage || 'test',
        details:health.technical
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/apps') {
    try {
      const a = normalizedApp(await bodyJson(req));
      const result = q.insertApp.run(
        a.name,a.slug,a.url,a.url,a.containerNames,a.dbType,a.dbHost,a.dbPort,
        '','','','', '', '',
        0,24,null,a.driveEnabled,
        'daily','03:00','',1,null,defaultTimeZone,now()
      );
      return sendJson(res,201,q.app.get(Number(result.lastInsertRowid)));
    } catch (error) {
      return sendJson(res,400,{error:error.message});
    }
  }

  let match = url.pathname.match(/^\/api\/apps\/(\d+)\/backup$/);
  if (req.method === 'POST' && match) {
    try { return sendJson(res,201,await createBackup(Number(match[1]),'manual')); }
    catch (error) { return sendJson(res,500,{error:error.message}); }
  }

  match = url.pathname.match(/^\/api\/apps\/(\d+)\/schedule$/);
  if (req.method === 'PUT' && match) {
    try {
      const id = Number(match[1]);
      const current = q.app.get(id);
      if (!current) return sendJson(res,404,{error:'Aplicación no encontrada'});
      const schedule = normalizedSchedule(await bodyJson(req),current);
      q.updateSchedule.run(
        schedule.schedule_enabled,
        schedule.interval_hours,
        schedule.next_backup_at,
        schedule.drive_enabled,
        schedule.schedule_type,
        schedule.schedule_time,
        schedule.schedule_days,
        schedule.schedule_day_of_month,
        schedule.schedule_once_at,
        schedule.schedule_timezone,
        id
      );
      return sendJson(res,200,q.app.get(id));
    } catch (error) {
      return sendJson(res,400,{error:error.message});
    }
  }

  match = url.pathname.match(/^\/api\/apps\/(\d+)$/);
  if (req.method === 'DELETE' && match) {
    q.deleteApp.run(Number(match[1]));
    res.writeHead(204).end();
    return;
  }

  match = url.pathname.match(/^\/api\/backups\/(\d+)\/retry-drive$/);
  if (req.method === 'POST' && match) {
    try { return sendJson(res,200,await retryDrive(Number(match[1]))); }
    catch (error) { return sendJson(res,503,{error:error.message}); }
  }

  match = url.pathname.match(/^\/api\/backups\/(\d+)\/download$/);
  if (req.method === 'GET' && match) {
    const backup = q.backup.get(Number(match[1]));
    if (!backup || backup.status !== 'ready' || !existsSync(backup.file_path)) return sendJson(res,404,{error:'Backup no disponible'});
    res.once('finish',()=>q.downloaded.run(now(),backup.id));
    res.writeHead(200,{
      'content-type':'application/octet-stream',
      'content-length':backup.size_bytes,
      'content-disposition':'attachment; filename="' + backup.filename.replace(/"/g,'') + '"'
    });
    await pipeline(createReadStream(backup.file_path),res);
    return;
  }

  return sendJson(res,404,{error:'Ruta no encontrada'});
}

const server = http.createServer(async(req,res) => {
  if (!authorized(req)) {
    res.writeHead(401,{'www-authenticate':'Basic realm="Nanocontrol"','x-content-type-options':'nosniff'}).end('Autenticación requerida');
    return;
  }

  const url = new URL(req.url,'http://localhost');
  try {
    if (!['GET','HEAD'].includes(req.method)) {
      if (req.headers['x-nanocontrol-request'] !== '1') return sendJson(res,403,{error:'Solicitud no permitida'});
      if (req.headers.origin && ![process.env.APP_ORIGIN,'http://127.0.0.1:4173','http://localhost:4173'].includes(req.headers.origin)) {
        return sendJson(res,403,{error:'Origen no permitido'});
      }
    }

    if (url.pathname.startsWith('/api/')) return await api(req,res,url);

    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const publicRoot = path.resolve(root,'public');
    const filePath = path.resolve(publicRoot,requested);
    if (!(filePath === publicRoot || filePath.startsWith(publicRoot+path.sep))) return res.writeHead(403).end('Prohibido');
    const content = await readFile(filePath);
    res.writeHead(200,{
      'content-type':mime[path.extname(filePath)]||'application/octet-stream',
      'cache-control':'no-cache',
      'x-content-type-options':'nosniff',
      'x-frame-options':'DENY',
      'referrer-policy':'no-referrer'
    });
    res.end(content);
  } catch (error) {
    if (!res.headersSent) sendJson(res,error.code==='ENOENT'?404:500,{error:error.message});
    else res.end();
  }
});

async function runScheduledBackup(appId) {
  const before = q.app.get(appId);
  if (!before || !before.schedule_enabled) return;
  let scheduleError = null;
  try {
    await createBackup(appId,'scheduled');
  } catch (error) {
    scheduleError = String(error.message).slice(0,1000);
    console.error('Backup automático ' + before.name + ':',scheduleError);
  }

  const current = q.app.get(appId);
  const runAt = now();

  if (current.schedule_type === 'once') {
    q.disableOnce.run(runAt,scheduleError,current.id);
    return;
  }

  try {
    const next = nextScheduleAt(current,new Date());
    q.scheduleRun.run(next,runAt,scheduleError,current.id);
  } catch (error) {
    q.scheduleRun.run(null,runAt,String(error.message).slice(0,1000),current.id);
  }
}

let schedulerBusy = false;
setInterval(async() => {
  if (schedulerBusy || backupBusy) return;
  schedulerBusy = true;
  try {
    for (const row of q.due.all(now())) await runScheduledBackup(row.id);
  } finally {
    schedulerBusy = false;
  }
},30000).unref();

server.listen(port,'0.0.0.0',()=>console.log('NanoControl ' + APP_VERSION + ': http://0.0.0.0:' + port));
