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

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const sourceRoot = path.resolve(process.env.BACKUP_SOURCE_ROOT || '/sources');
const glancesUrl = (process.env.GLANCES_URL || '').replace(/\/$/, '');
const port = Number(process.env.PORT || 4173);
if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_USER||!process.env.ADMIN_PASSWORD))throw new Error('Credenciales administrativas obligatorias');
const childEnv = {PATH:process.env.PATH, LANG:'C.UTF-8', HOME:'/tmp'};
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
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL DEFAULT '',
    health_url TEXT NOT NULL DEFAULT '',
    container_names TEXT NOT NULL DEFAULT '',
    db_type TEXT NOT NULL CHECK (db_type IN ('postgres','mysql','mariadb','sqlite','none')),
    db_host TEXT NOT NULL DEFAULT '',
    db_port INTEGER,
    env_file TEXT NOT NULL DEFAULT '',
    db_name_key TEXT NOT NULL DEFAULT '',
    db_user_key TEXT NOT NULL DEFAULT '',
    db_password_key TEXT NOT NULL DEFAULT '',
    sqlite_path TEXT NOT NULL DEFAULT '',
    legacy_backup_path TEXT NOT NULL DEFAULT '',
    schedule_enabled INTEGER NOT NULL DEFAULT 0,
    interval_hours INTEGER NOT NULL DEFAULT 24,
    next_backup_at TEXT,
    drive_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'nanocontrol',
    drive_status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    downloaded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_backups_application_created ON backups(application_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_applications_schedule ON applications(schedule_enabled, next_backup_at);
  PRAGMA optimize;
`);

const now = () => new Date().toISOString();
const nextDate = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const slugify = (value) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48);
const q = {
  seed: db.prepare(`INSERT OR IGNORE INTO applications (name,slug,url,health_url,container_names,db_type,db_host,db_port,env_file,db_name_key,db_user_key,db_password_key,sqlite_path,legacy_backup_path,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  apps: db.prepare(`SELECT a.*, (SELECT b.created_at FROM backups b WHERE b.application_id=a.id AND b.status='ready' ORDER BY b.created_at DESC LIMIT 1) last_backup_at, (SELECT b.downloaded_at FROM backups b WHERE b.application_id=a.id AND b.status='ready' AND b.downloaded_at IS NOT NULL ORDER BY b.downloaded_at DESC LIMIT 1) last_downloaded_at, (SELECT b.drive_status FROM backups b WHERE b.application_id=a.id AND b.status='ready' ORDER BY b.created_at DESC LIMIT 1) last_drive_status FROM applications a ORDER BY a.name`),
  app: db.prepare('SELECT * FROM applications WHERE id=?'),
  appBySlug: db.prepare('SELECT * FROM applications WHERE slug=?'),
  due: db.prepare("SELECT id FROM applications WHERE schedule_enabled=1 AND (next_backup_at IS NULL OR next_backup_at<=?)"),
  backups: db.prepare(`SELECT b.*,a.name application_name FROM backups b JOIN applications a ON a.id=b.application_id ORDER BY b.created_at DESC LIMIT 50`),
  backup: db.prepare('SELECT * FROM backups WHERE id=?'),
  insertApp: db.prepare(`INSERT INTO applications (name,slug,url,health_url,container_names,db_type,db_host,db_port,env_file,db_name_key,db_user_key,db_password_key,sqlite_path,legacy_backup_path,schedule_enabled,interval_hours,next_backup_at,drive_enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  insertBackup: db.prepare(`INSERT OR IGNORE INTO backups (application_id,filename,file_path,size_bytes,status,source,drive_status,created_at) VALUES (?,?,?,?,?,?,?,?)`),
  readyBackup: db.prepare("UPDATE backups SET status='ready',size_bytes=?,drive_status=?,error=NULL WHERE id=?"),
  failBackup: db.prepare("UPDATE backups SET status='failed',error=? WHERE id=?"),
  downloaded: db.prepare('UPDATE backups SET downloaded_at=? WHERE id=?'),
  nextRun: db.prepare('UPDATE applications SET next_backup_at=? WHERE id=?'),
  schedule: db.prepare('UPDATE applications SET schedule_enabled=?,interval_hours=?,next_backup_at=?,drive_enabled=? WHERE id=?'),
  deleteApp: db.prepare('DELETE FROM applications WHERE id=?'),
};
for (const app of seedApps) {
  const [name, slug, url, ...rest] = app;
  q.seed.run(name, slug, url, url, ...rest, now());
}

const backupExtensions = ['.sql','.sql.gz','.dump','.sqlite','.sqlite.gz'];
async function scanFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const found=[];
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const full=path.join(dir,entry.name);
    if (entry.isDirectory()) found.push(...await scanFiles(full));
    else if (backupExtensions.some(ext=>entry.name.endsWith(ext))) found.push(full);
  }
  return found;
}
async function importLegacyBackups() {
  for (const app of q.apps.all()) {
    for (const filePath of await scanFiles(app.legacy_backup_path)) {
      const info=await stat(filePath);
      q.insertBackup.run(app.id,path.basename(filePath),filePath,info.size,'ready','existing','unknown',info.mtime.toISOString());
    }
  }
}
await importLegacyBackups();
db.prepare("UPDATE backups SET status='failed',error='Proceso interrumpido' WHERE status='running'").run();

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const sendJson=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
const safeEqual=(a,b)=>{const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb)};
function authorized(req){const user=process.env.ADMIN_USER,pass=process.env.ADMIN_PASSWORD;if(!user||!pass)return process.env.NODE_ENV!=='production';const header=req.headers.authorization||'';if(!header.startsWith('Basic '))return false;const decoded=Buffer.from(header.slice(6),'base64').toString();const separator=decoded.indexOf(':');if(separator<0)return false;const u=decoded.slice(0,separator),p=decoded.slice(separator+1);return safeEqual(u,user)&&safeEqual(p,pass)}
async function bodyJson(req){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw new Error('Solicitud demasiado grande')}return raw?JSON.parse(raw):{}}

function run(command,args,options={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{shell:false,timeout:1_800_000,killSignal:'SIGKILL',env:{...childEnv,...(options.env||{})},stdio:['ignore',options.capture?'pipe':'ignore','pipe']});
    let stderr='';child.stderr.on('data',d=>{stderr+=d.toString();if(stderr.length>8000)stderr=stderr.slice(-8000)});
    child.once('error',()=>reject(new Error(`No se pudo ejecutar ${command}`)));child.once('close',code=>code===0?resolve():reject(new Error(`${command} falló (código ${code}); revisar conexión y permisos`)));
  });
}
async function runDump(command,args,env,filePath,gzip){
  const child=spawn(command,args,{shell:false,timeout:1_800_000,killSignal:'SIGKILL',env:{...childEnv,...env},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',d=>{stderr+=d.toString();if(stderr.length>8000)stderr=stderr.slice(-8000)});
  const output=gzip?createGzip({level:3}):undefined;
  const streamTask=gzip?pipeline(child.stdout,output,createWriteStream(filePath)):pipeline(child.stdout,createWriteStream(filePath));
  const processTask=new Promise((resolve,reject)=>{child.once('error',()=>reject(new Error(`No se pudo ejecutar ${command}`)));child.once('close',code=>code===0?resolve():reject(new Error(`${command} falló (código ${code}); revisar conexión y permisos`)))});
  try{await Promise.all([streamTask,processTask])}catch(error){child.kill('SIGKILL');await Promise.allSettled([streamTask,processTask]);throw error}
}
async function readEnv(filePath){
  if(!filePath) return {};
  const content=await readFile(filePath,'utf8');const values={};
  for(const line of content.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);if(!match)continue;let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);values[match[1]]=value}
  return values;
}
async function uploadDrive(filePath,filename,appName){
  const config=process.env.RCLONE_CONFIG||'/run/secrets/rclone.conf';
  const remote=process.env.RCLONE_REMOTE;if(!remote||!existsSync(config))return 'not_configured';
  const folder=(process.env.RCLONE_PATH||'Backups sistemas').replace(/^\/+|\/+$/g,'');
  const appFolder=appName.normalize('NFC').replace(/[/\\\x00-\x1f]/g,'_').trim();
  if(!appFolder||appFolder==='.'||appFolder==='..')throw new Error('Nombre de carpeta inválido');
  const destination=`${remote}:${folder}/${appFolder}`;
  await run('rclone',['--config',config,'mkdir',destination]);
  await run('rclone',['--config',config,'copyto',filePath,`${destination}/${filename}`,'--checksum','--immutable']);return 'uploaded';
}
let backupBusy=false;
async function createBackup(appId){
  if(backupBusy)throw new Error('Ya hay un backup en curso. Esperá a que termine.');
  backupBusy=true;
  try{return await performBackup(appId)}finally{backupBusy=false}
}
async function performBackup(appId){
  const app=q.app.get(appId);if(!app)throw new Error('Aplicación no encontrada');if(app.db_type==='none')throw new Error('No hay una base configurada');
  const disk=await statfs(backupDir);if(disk.bavail*disk.bsize<10*1024**3)throw new Error('Se requieren al menos 10 GB libres para iniciar un backup');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');const extension=app.db_type==='postgres'?'.dump':app.db_type==='sqlite'?'.sqlite':'.sql.gz';
  const appDir=path.join(backupDir,app.slug);await mkdir(appDir,{recursive:true});const filename=`${app.slug}_${stamp}${extension}`;const filePath=path.join(appDir,filename);
  const inserted=q.insertBackup.run(app.id,filename,filePath,0,'running','nanocontrol',app.drive_enabled?'pending':'disabled',now());const backupId=Number(inserted.lastInsertRowid);
  const partialPath=filePath+'.partial';
  try{
    if(app.db_type==='sqlite'){
      const source=path.resolve(sourceRoot,app.sqlite_path.replace(/^[/\\]+/,''));if(!(source===sourceRoot||source.startsWith(sourceRoot+path.sep)))throw new Error('Ruta SQLite fuera del directorio permitido');
      await run('sqlite3',['-readonly',source,`.backup '${partialPath.replaceAll("'","''")}'`]);
    }else{
      const values=await readEnv(app.env_file);const dbName=values[app.db_name_key],dbUser=values[app.db_user_key],dbPassword=values[app.db_password_key];if(!dbName||!dbUser||!dbPassword)throw new Error('Faltan variables de conexión en el archivo de entorno montado');
      if(app.db_type==='postgres')await run('pg_dump',['--host',app.db_host,'--port',String(app.db_port||5432),'--username',dbUser,'--dbname',dbName,'--format=custom','--no-owner','--no-acl','--lock-wait-timeout=5s','--file',partialPath],{env:{PGPASSWORD:dbPassword,PGCONNECT_TIMEOUT:'10'}});
      else await runDump('mariadb-dump',[`--host=${app.db_host}`,`--port=${app.db_port||3306}`,`--user=${dbUser}`,'--single-transaction','--quick','--skip-lock-tables','--no-tablespaces','--routines','--triggers','--events','--hex-blob','--default-character-set=utf8mb4',dbName],{MYSQL_PWD:dbPassword},partialPath,true);
    }
    if(!(await stat(partialPath)).size)throw new Error('El backup está vacío');
    await rename(partialPath,filePath);
    const info=await stat(filePath);let driveStatus=app.drive_enabled?'pending':'disabled';if(app.drive_enabled){try{driveStatus=await uploadDrive(filePath,filename,app.name)}catch(error){driveStatus='failed';console.error('Drive:',error.message)}}
    q.readyBackup.run(info.size,driveStatus,backupId);q.nextRun.run(nextDate(app.interval_hours),app.id);return q.backup.get(backupId);
  }catch(error){await rm(partialPath,{force:true}).catch(()=>{});q.failBackup.run(String(error.message).slice(0,1000),backupId);q.nextRun.run(nextDate(app.interval_hours),app.id);throw error}
}

async function getJson(url){try{const response=await fetch(url,{signal:AbortSignal.timeout(5000)});return response.ok?await response.json():null}catch{return null}}
async function health(url){if(!url)return'unknown';try{const response=await fetch(url,{signal:AbortSignal.timeout(7000),redirect:'follow'});return response.ok?'online':response.status<500?'degraded':'offline'}catch{return'offline'}}
async function monitor(){
  if(!glancesUrl)return null;
  const [containers,cpu,mem,system,uptime]=await Promise.all(['containers','cpu','mem','system','uptime'].map(plugin=>getJson(`${glancesUrl}/api/4/${plugin}`)));
  return{containers:Array.isArray(containers)?containers:[],cpu,mem,system,uptime};
}
function usageFor(containerNames,containers){const wanted=containerNames.split(',').map(v=>v.trim()).filter(Boolean);const rows=containers.filter(c=>wanted.includes(c.name));if(!rows.length)return null;return{cpu:Number(rows.reduce((sum,c)=>sum+Number(c.cpu_percent||c.cpu?.total||0),0).toFixed(1)),memoryBytes:rows.reduce((sum,c)=>sum+Number(c.memory_usage||c.memory?.usage||0),0),containers:rows.map(c=>({name:c.name,status:c.status||'unknown'}))}}
async function dashboard(){
  const telemetry=await monitor();const rows=q.apps.all();const apps=await Promise.all(rows.map(async app=>{const usage=usageFor(app.container_names,telemetry?.containers||[]);const httpHealth=await health(app.health_url||app.url);const containersRunning=usage?.containers?.length&&usage.containers.every(container=>container.status==='running');return{...app,schedule_enabled:!!app.schedule_enabled,drive_enabled:!!app.drive_enabled,health:httpHealth,containersRunning:!!containersRunning,usage}}));
  const total=Number(telemetry?.mem?.total||os.totalmem()),available=Number(telemetry?.mem?.available||os.freemem());
  return{server:{hostname:telemetry?.system?.hostname||os.hostname(),uptime:telemetry?.uptime||null,uptimeSeconds:os.uptime(),telemetryAvailable:!!telemetry?.cpu,cpuPercent:telemetry?.cpu?Number(telemetry.cpu.total):null,cpuCount:Number(telemetry?.cpu?.cpucore||os.cpus().length),memoryUsed:total-available,memoryTotal:total},drive:{configured:!!process.env.RCLONE_REMOTE&&existsSync(process.env.RCLONE_CONFIG||'/run/secrets/rclone.conf'),remote:process.env.RCLONE_REMOTE||null,path:process.env.RCLONE_PATH||'Nanolabs/Backups'},apps,backups:q.backups.all(),updatedAt:now()};
}
function normalizedApp(input){const name=String(input.name||'').trim();if(!name)throw new Error('El nombre es obligatorio');const dbType=['postgres','mysql','mariadb','sqlite','none'].includes(input.dbType)?input.dbType:'none';return{name,slug:slugify(input.slug||name),url:String(input.url||'').trim(),containerNames:String(input.containerNames||'').trim(),dbType,dbHost:String(input.dbHost||'').trim(),dbPort:Number(input.dbPort)||null,scheduleEnabled:0,intervalHours:Math.max(1,Math.min(720,Number(input.intervalHours)||24)),driveEnabled:input.driveEnabled!==false?1:0}}

async function api(req,res,url){
  if(req.method==='POST'&&url.pathname==='/api/drive/test'){
    const filename=`conexion-drive_${now().replace(/[:.]/g,'-')}.txt`;
    const filePath=path.join(backupDir,filename);
    await writeFile(filePath,'Prueba de conexión NanoControl. No contiene datos productivos.\n',{flag:'wx',mode:0o600});
    const status=await uploadDrive(filePath,filename,'NanoControl');
    if(status!=='uploaded')return sendJson(res,503,{error:'Drive no configurado'});
    return sendJson(res,200,{status,filename,folder:'NanoControl'});
  }
  if(req.method==='GET'&&url.pathname==='/api/healthz')return sendJson(res,200,{ok:true});
  if(req.method==='GET'&&url.pathname==='/api/dashboard')return sendJson(res,200,await dashboard());
  if(req.method==='POST'&&url.pathname==='/api/apps'){try{const a=normalizedApp(await bodyJson(req));const result=q.insertApp.run(a.name,a.slug,a.url,a.url,a.containerNames,a.dbType,a.dbHost,a.dbPort,'','','','', '', '',a.scheduleEnabled,a.intervalHours,a.scheduleEnabled?nextDate(a.intervalHours):null,a.driveEnabled,now());return sendJson(res,201,q.app.get(Number(result.lastInsertRowid)))}catch(error){return sendJson(res,400,{error:error.message})}}
  let match=url.pathname.match(/^\/api\/apps\/(\d+)\/backup$/);if(req.method==='POST'&&match){try{return sendJson(res,201,await createBackup(Number(match[1])))}catch(error){return sendJson(res,500,{error:error.message})}}
  match=url.pathname.match(/^\/api\/apps\/(\d+)\/schedule$/);if(req.method==='PUT'&&match){try{const input=await bodyJson(req);const hours=Math.max(1,Math.min(720,Number(input.intervalHours)||24));q.schedule.run(input.enabled?1:0,hours,input.enabled?nextDate(hours):null,input.driveEnabled?1:0,Number(match[1]));return sendJson(res,200,q.app.get(Number(match[1])))}catch(error){return sendJson(res,400,{error:error.message})}}
  match=url.pathname.match(/^\/api\/apps\/(\d+)$/);if(req.method==='DELETE'&&match){q.deleteApp.run(Number(match[1]));res.writeHead(204).end();return}
  match=url.pathname.match(/^\/api\/backups\/(\d+)\/download$/);if(req.method==='GET'&&match){const backup=q.backup.get(Number(match[1]));if(!backup||backup.status!=='ready'||!existsSync(backup.file_path))return sendJson(res,404,{error:'Backup no disponible'});res.once('finish',()=>q.downloaded.run(now(),backup.id));res.writeHead(200,{'content-type':'application/octet-stream','content-length':backup.size_bytes,'content-disposition':`attachment; filename="${backup.filename.replace(/"/g,'')}"`});await pipeline(createReadStream(backup.file_path),res);return}
  return sendJson(res,404,{error:'Ruta no encontrada'});
}

const server=http.createServer(async(req,res)=>{
  if(!authorized(req)){res.writeHead(401,{'www-authenticate':'Basic realm="Nanocontrol"','x-content-type-options':'nosniff'}).end('Autenticación requerida');return}
  const url=new URL(req.url,'http://localhost');try{
    if(!['GET','HEAD'].includes(req.method)){
      if(req.headers['x-nanocontrol-request']!=='1')return sendJson(res,403,{error:'Solicitud no permitida'});
      if(req.headers.origin && ![process.env.APP_ORIGIN,'http://127.0.0.1:4173','http://localhost:4173'].includes(req.headers.origin))return sendJson(res,403,{error:'Origen no permitido'});
    }
if(url.pathname.startsWith('/api/'))return await api(req,res,url);const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));const publicRoot=path.resolve(root,'public');const filePath=path.resolve(publicRoot,requested);if(!(filePath===publicRoot||filePath.startsWith(publicRoot+path.sep)))return res.writeHead(403).end('Prohibido');const content=await readFile(filePath);res.writeHead(200,{'content-type':mime[path.extname(filePath)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer'});res.end(content)}catch(error){if(!res.headersSent)sendJson(res,error.code==='ENOENT'?404:500,{error:error.message});else res.end()}
});
let schedulerBusy=false;setInterval(async()=>{if(schedulerBusy)return;schedulerBusy=true;try{for(const row of q.due.all(now())){try{await createBackup(row.id)}catch(error){console.error('Backup automático:',error.message)}}}finally{schedulerBusy=false}},60_000).unref();
server.listen(port,'0.0.0.0',()=>console.log(`Nanocontrol: http://0.0.0.0:${port}`));
