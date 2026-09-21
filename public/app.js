const state={data:null,filter:'all',loadingBackups:new Set(),loadingDrive:new Set()};
const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const escapeHtml=(value='')=>String(value).replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const bytes=(value=0)=>{if(!value)return'—';const units=['B','KB','MB','GB','TB'];const index=Math.min(Math.floor(Math.log(value)/Math.log(1024)),units.length-1);return (value/1024**index).toFixed(index>1?1:0)+' '+units[index]};
const relative=value=>{if(!value)return'Nunca';const seconds=Math.round((new Date(value)-Date.now())/1000);const formatter=new Intl.RelativeTimeFormat('es',{numeric:'auto'});const ranges=[['year',31536000],['month',2592000],['day',86400],['hour',3600],['minute',60]];for(const [unit,size] of ranges){if(Math.abs(seconds)>=size)return formatter.format(Math.round(seconds/size),unit)}return formatter.format(seconds,'second')};
const dateTime=value=>value?new Intl.DateTimeFormat('es-AR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'Nunca';
const duration=seconds=>{if(!seconds)return'—';const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600);return days?days+'d '+hours+'h':hours+'h'};
const pct=(used,total)=>total?Math.round(used/total*100):0;
const dayNames=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

function toast(message,type='ok'){
  const element=$('#toast');
  element.textContent=message;
  element.className='toast show '+type;
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>element.className='toast',5000);
}

async function request(url,options={}){
  const response=await fetch(url,{
    headers:{'content-type':'application/json','x-nanocontrol-request':'1',...(options.headers||{})},
    ...options
  });
  let payload=null;
  try{payload=await response.json()}catch{}
  if(!response.ok){
    let message=payload?.error||('Error '+response.status);
    if(payload?.details&&payload.details!==message)message+=': '+payload.details;
    throw new Error(message);
  }
  return response.status===204?null:payload;
}

function renderMetrics(data){
  const online=data.apps.filter(app=>app.health==='online').length;
  const recent=data.backups.filter(item=>item.status==='ready'&&Date.now()-new Date(item.created_at).getTime()<86400000).length;
  $('#nav-count').textContent=data.apps.length;
  $('#all-count').textContent=data.apps.length;
  $('#online-count').textContent=online;
  $('#alert-count').textContent=data.apps.length-online;
  $('#apps-value').textContent=online+'/'+data.apps.length;
  $('#online-trend').textContent=data.apps.length?Math.round(online/data.apps.length*100)+'% online':'Sin aplicaciones';

  const cpu=data.server.telemetryAvailable?Math.round(data.server.cpuPercent):'—';
  $('#cpu-value').innerHTML=cpu+'<span>%</span>';
  $('#cpu-detail').textContent=(data.server.cpuCount||'—')+' vCPU';
  $('#cpu-meter').style.width=Math.min(Number(cpu)||0,100)+'%';

  const memory=pct(data.server.memoryUsed,data.server.memoryTotal);
  $('#memory-value').innerHTML=memory+'<span>%</span>';
  $('#memory-detail').textContent=bytes(data.server.memoryTotal-data.server.memoryUsed)+' libres';
  $('#memory-meter').style.width=memory+'%';

  $('#backup-value').innerHTML=recent+'<span> hoy</span>';
  $('#backup-trend').textContent=recent?'Actividad reciente':'Sin backups recientes';
  $('#backup-trend').className='trend '+(recent?'good':'warn');
  $('#server-state').textContent=data.server.telemetryAvailable?'Servidor operativo':'Métricas no disponibles';
  $('#server-uptime').textContent=data.server.uptime||duration(data.server.uptimeSeconds);
  $('#server-host').textContent=data.server.hostname||'NanoLabs';
  $('#app-version').textContent='v'+(data.version||'—');
  $('#updated').textContent='Actualizado '+relative(data.updatedAt);
}

function appStatus(app){
  if(app.health==='online')return['Operativa','online'];
  if(app.health==='degraded')return['Degradada','degraded'];
  if(app.health==='offline')return['Sin respuesta','offline'];
  return['Sin health check','unknown'];
}

function scheduleDetail(app){
  if(!app.schedule_enabled)return '<span class="automation-badge manual">Manual</span><small>Sin automatización</small>';
  const next=app.next_backup_at?'Próximo '+dateTime(app.next_backup_at):'Sin próxima ejecución';
  return '<span class="automation-badge automatic">Automático</span><small>'+escapeHtml(app.schedule_description)+' · '+escapeHtml(next)+'</small>';
}

function backupDetail(app){
  if(!app.last_backup_at)return'Sin backups';
  if(app.last_drive_status==='failed'){
    const error=app.last_drive_error?' · '+app.last_drive_error:'';
    return '<span class="failed" title="'+escapeHtml(app.last_drive_error||'Fallo no detallado')+'">Drive falló'+escapeHtml(error)+'</span>';
  }
  if(app.last_drive_status==='uploaded')return'<span class="cloud">☁ Copiado a Drive</span>';
  if(app.last_drive_status==='disabled')return'<span class="muted-pill">Solo local</span>';
  if(app.last_downloaded_at)return'<span class="downloaded">Descargado '+escapeHtml(relative(app.last_downloaded_at))+'</span>';
  return'<span class="muted-pill">Disponible localmente</span>';
}

function renderApps(data){
  let apps=data.apps;
  if(state.filter==='online')apps=apps.filter(app=>app.health==='online');
  if(state.filter==='alert')apps=apps.filter(app=>app.health!=='online');

  const rows=apps.map(app=>{
    const [label,status]=appStatus(app);
    const usage=app.usage;
    const initial=escapeHtml(app.name.slice(0,1));
    const busy=state.loadingBackups.has(app.id);
    return '<div class="app-row">'+
      '<div class="app-name"><span class="app-logo color-'+(app.id%5)+'">'+initial+'</span><div><strong>'+escapeHtml(app.name)+'</strong><small>'+escapeHtml(app.url.replace(/^https?:\/\//,''))+'</small></div></div>'+
      '<span class="status '+status+'"><i></i>'+label+'</span>'+
      '<div class="usage"><span>CPU '+(usage?usage.cpu+'%':'—')+'</span><span>RAM '+(usage?bytes(usage.memoryBytes):'—')+'</span></div>'+
      '<div class="automation-cell">'+scheduleDetail(app)+'</div>'+
      '<div class="backup-date"><strong>'+dateTime(app.last_backup_at)+'</strong><small>'+backupDetail(app)+'</small></div>'+
      '<div class="row-actions"><button class="backup-button" data-backup="'+app.id+'" '+(busy||app.db_type==='none'?'disabled':'')+'>'+(busy?'◌ Generando…':'↻ Backup ahora')+'</button><button class="menu-button" data-schedule="'+app.id+'" title="Configurar automatización">⌁</button></div>'+
    '</div>';
  }).join('');

  $('#app-table').innerHTML=
    '<div class="app-row app-header"><span>APLICACIÓN</span><span>ESTADO</span><span>CONSUMO</span><span>AUTOMATIZACIÓN</span><span>ÚLTIMO BACKUP</span><span></span></div>'+
    (rows||'<div class="empty">No hay aplicaciones para este filtro.</div>');
}

function driveLabel(item){
  if(item.drive_status==='uploaded')return'<span class="cloud">☁ En Drive</span>';
  if(item.drive_status==='failed')return'<span class="failed" title="'+escapeHtml(item.drive_error||'Sin detalle')+'">! Drive falló</span>';
  if(item.drive_status==='disabled')return'<span class="muted-pill">Solo local</span>';
  if(item.drive_status==='pending')return'<span class="muted-pill">Drive pendiente</span>';
  return'<span class="muted-pill">Existente</span>';
}

function renderBackups(data){
  const items=data.backups.slice(0,12).map(item=>{
    const running=item.status==='running';
    const failed=item.status==='failed';
    const retry= item.status==='ready'&&item.drive_status==='failed'
      ? '<button class="retry-drive" data-retry-drive="'+item.id+'" '+(state.loadingDrive.has(item.id)?'disabled':'')+'>'+(state.loadingDrive.has(item.id)?'Reintentando…':'Reintentar Drive')+'</button>'
      : '';
    const error=item.drive_status==='failed'&&item.drive_error
      ? '<small class="backup-error">'+escapeHtml(item.drive_error)+'</small>'
      : failed&&item.error
        ? '<small class="backup-error">'+escapeHtml(item.error)+'</small>'
        : '';
    const trigger=item.trigger_type==='scheduled'?'Automático':item.trigger_type==='manual'?'Manual':'Histórico';
    const action=item.status==='ready'
      ? '<a class="download" href="/api/backups/'+item.id+'/download" title="Descargar" data-download="'+item.id+'">↓</a>'
      : '<span class="backup-state">'+(running?'Generando…':'Falló')+'</span>';

    return '<div class="backup-item">'+
      '<span class="file-icon">▱</span>'+
      '<div class="backup-main"><strong>'+escapeHtml(item.filename)+'</strong><small>'+escapeHtml(item.application_name)+' · '+bytes(item.size_bytes)+' · '+dateTime(item.created_at)+' · '+trigger+'</small>'+error+'</div>'+
      '<div class="backup-cloud">'+driveLabel(item)+retry+'</div>'+
      action+
    '</div>';
  }).join('');
  $('#backup-list').innerHTML=items||'<div class="empty">Todavía no hay archivos de backup registrados.</div>';
}

function scheduleLongLabel(app){
  if(!app.schedule_enabled)return'Manual';
  if(app.schedule_type==='weekly'&&app.schedule_days?.length){
    return app.schedule_days.map(day=>dayNames[day]).join(', ')+' · '+app.schedule_time;
  }
  return app.schedule_description;
}

function renderAutomation(data){
  const scheduled=data.apps.filter(app=>app.schedule_enabled).sort((a,b)=>(a.next_backup_at||'').localeCompare(b.next_backup_at||''));
  $('#automation-toggle').className='toggle '+(scheduled.length?'on':'');
  $('#schedule-time').textContent=scheduled.length;
  $('#schedule-title').textContent=scheduled.length===1?'1 proceso automatizado':scheduled.length+' procesos automatizados';
  const next=scheduled.map(app=>app.next_backup_at).filter(Boolean).sort()[0];
  $('#schedule-next').textContent=next?'Próxima ejecución '+dateTime(next):'Configurá cada aplicación';

  $('#schedule-list').innerHTML=scheduled.length
    ? scheduled.map(app=>
      '<button class="schedule-row" data-schedule="'+app.id+'"><span><strong>'+escapeHtml(app.name)+'</strong><small>'+escapeHtml(scheduleLongLabel(app))+'</small></span><span class="schedule-next">'+(app.next_backup_at?relative(app.next_backup_at):'—')+'</span></button>'
    ).join('')
    : '<div class="empty small-empty">Ninguna aplicación tiene backup automático.</div>';

  const drive=data.drive;
  const configured=drive.configured;
  const failed=drive.status==='failed';
  const connected=drive.status==='connected';

  $('#drive-title').textContent=!configured?'Google Drive no configurado':failed?'Google Drive con error':connected?'Google Drive conectado':'Google Drive configurado';
  $('#drive-path').textContent=configured
    ? (drive.remote+': '+(drive.path||'/')+(drive.checkedAt?' · probado '+relative(drive.checkedAt):' · sin prueba reciente'))
    : 'Falta remote o rclone.conf';
  $('#drive-ok').textContent=connected?'✓':failed?'×':'!';
  $('#drive-ok').className=connected?'ok':failed?'danger-icon':'warn-icon';

  const error=$('#drive-error');
  if(failed&&drive.error){
    error.textContent=(drive.stage?'Etapa '+drive.stage+': ':'')+drive.error;
    error.classList.remove('hidden');
  }else{
    error.textContent='';
    error.classList.add('hidden');
  }
}

function render(){
  if(!state.data)return;
  renderMetrics(state.data);
  renderApps(state.data);
  renderBackups(state.data);
  renderAutomation(state.data);
}

async function load(silent=false){
  try{
    if(!silent)$('#refresh').classList.add('spinning');
    state.data=await request('/api/dashboard');
    $('#notice').classList.add('hidden');
    render();
  }catch(error){
    $('#server-state').textContent='Sin conexión';
    $('#notice').textContent='No se pudieron cargar los datos: '+error.message;
    $('#notice').classList.remove('hidden');
  }finally{
    $('#refresh').classList.remove('spinning');
  }
}

async function backup(appId){
  const app=state.data.apps.find(item=>item.id===appId);
  if(!app)return;
  if(!confirm('Se generará un backup consistente de '+app.name+'. ¿Continuar?'))return;
  state.loadingBackups.add(appId);
  renderApps(state.data);
  try{
    await request('/api/apps/'+appId+'/backup',{method:'POST'});
    toast('Backup de '+app.name+' terminado');
    await load(true);
  }catch(error){
    toast(error.message,'error');
  }finally{
    state.loadingBackups.delete(appId);
    renderApps(state.data);
  }
}

function updateScheduleFields(){
  const type=$('#schedule-type').value;
  $$('[data-schedule-field]').forEach(field=>field.classList.add('hidden'));
  if(type==='interval')$('[data-schedule-field="interval"]').classList.remove('hidden');
  if(type==='daily')$('[data-schedule-field="time"]').classList.remove('hidden');
  if(type==='weekly'){
    $('[data-schedule-field="time"]').classList.remove('hidden');
    $('[data-schedule-field="weekly"]').classList.remove('hidden');
  }
  if(type==='monthly'){
    $('[data-schedule-field="time"]').classList.remove('hidden');
    $('[data-schedule-field="monthly"]').classList.remove('hidden');
  }
  if(type==='once')$('[data-schedule-field="once"]').classList.remove('hidden');
  updateSchedulePreview();
}

function updateSchedulePreview(){
  const form=$('#schedule-form');
  const enabled=form.elements.enabled.checked;
  const type=form.elements.type.value;
  if(!enabled){
    $('#schedule-preview').textContent='Proceso manual';
    return;
  }
  let text='Se calculará al guardar';
  if(type==='interval')text='Cada '+form.elements.intervalHours.value+' horas';
  if(type==='daily')text='Todos los días a las '+form.elements.time.value;
  if(type==='weekly'){
    const days=[...form.querySelectorAll('input[name="days"]:checked')].map(input=>dayNames[Number(input.value)]);
    text=(days.length?days.join(', '):'Elegí días')+' a las '+form.elements.time.value;
  }
  if(type==='monthly')text='Día '+form.elements.dayOfMonth.value+' de cada mes a las '+form.elements.time.value;
  if(type==='once')text=form.elements.onceAt.value?new Date(form.elements.onceAt.value).toLocaleString('es-AR'):'Elegí fecha y hora';
  $('#schedule-preview').textContent=text;
}

function openSchedule(appId){
  const app=state.data.apps.find(item=>item.id===appId);
  if(!app)return;
  const form=$('#schedule-form');
  form.elements.appId.value=app.id;
  form.elements.enabled.checked=!!app.schedule_enabled;
  form.elements.type.value=app.schedule_type||'daily';
  form.elements.intervalHours.value=app.interval_hours||24;
  form.elements.time.value=app.schedule_time||'03:00';
  form.elements.dayOfMonth.value=app.schedule_day_of_month||1;
  form.elements.onceAt.value=app.schedule_once_at||'';
  form.elements.driveEnabled.checked=!!app.drive_enabled;
  form.querySelectorAll('input[name="days"]').forEach(input=>input.checked=(app.schedule_days||[]).includes(Number(input.value)));
  $('#schedule-dialog-title').textContent='Automatización · '+app.name;
  $('#schedule-dialog-subtitle').textContent=app.schedule_enabled?'Actualmente '+scheduleLongLabel(app):'Actualmente solo manual';
  $('#schedule-timezone').textContent='Zona horaria: '+(app.schedule_timezone||state.data.automation.timeZone);
  updateScheduleFields();
  if(app.schedule_enabled&&app.next_backup_at)$('#schedule-preview').textContent='Actual: '+dateTime(app.next_backup_at);
  $('#schedule-dialog').showModal();
}

async function retryDrive(backupId){
  state.loadingDrive.add(backupId);
  renderBackups(state.data);
  try{
    await request('/api/backups/'+backupId+'/retry-drive',{method:'POST'});
    toast('Backup copiado a Google Drive');
    await load(true);
  }catch(error){
    toast(error.message,'error');
    await load(true);
  }finally{
    state.loadingDrive.delete(backupId);
    renderBackups(state.data);
  }
}

async function testDrive(){
  const button=$('#test-drive');
  button.disabled=true;
  button.textContent='Probando…';
  try{
    const result=await request('/api/drive/test',{method:'POST'});
    toast('Google Drive operativo · '+result.filename);
  }catch(error){
    toast(error.message,'error');
  }finally{
    button.disabled=false;
    button.textContent='Probar';
    await load(true);
  }
}

document.addEventListener('click',event=>{
  const backupButton=event.target.closest('[data-backup]');
  if(backupButton)backup(Number(backupButton.dataset.backup));

  const scheduleButton=event.target.closest('[data-schedule]');
  if(scheduleButton)openSchedule(Number(scheduleButton.dataset.schedule));

  const retryButton=event.target.closest('[data-retry-drive]');
  if(retryButton)retryDrive(Number(retryButton.dataset.retryDrive));

  const download=event.target.closest('[data-download]');
  if(download)setTimeout(()=>load(true),800);
});

$$('.filter').forEach(button=>button.addEventListener('click',()=>{
  $$('.filter').forEach(item=>item.classList.remove('active'));
  button.classList.add('active');
  state.filter=button.dataset.filter;
  renderApps(state.data);
}));

$$('a[href^="#"]').forEach(link=>link.addEventListener('click',()=>{
  $$('.nav-item').forEach(item=>item.classList.remove('active'));
  link.classList.add('active');
}));

$('#refresh').addEventListener('click',()=>load());
$('#open-app').addEventListener('click',()=>$('#app-dialog').showModal());
$('#test-drive').addEventListener('click',testDrive);
$('#schedule-type').addEventListener('change',updateScheduleFields);
$('#schedule-form').addEventListener('input',updateSchedulePreview);

$('#schedule-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(event.submitter?.value==='cancel'){
    $('#schedule-dialog').close();
    return;
  }
  const form=event.currentTarget;
  const appId=Number(form.elements.appId.value);
  const input={
    enabled:form.elements.enabled.checked,
    type:form.elements.type.value,
    intervalHours:Number(form.elements.intervalHours.value||24),
    time:form.elements.time.value||'03:00',
    days:[...form.querySelectorAll('input[name="days"]:checked')].map(input=>Number(input.value)),
    dayOfMonth:Number(form.elements.dayOfMonth.value||1),
    onceAt:form.elements.onceAt.value||null,
    driveEnabled:form.elements.driveEnabled.checked,
    timeZone:state.data.apps.find(app=>app.id===appId)?.schedule_timezone||state.data.automation.timeZone
  };
  try{
    await request('/api/apps/'+appId+'/schedule',{method:'PUT',body:JSON.stringify(input)});
    $('#schedule-dialog').close();
    toast(input.enabled?'Automatización guardada':'Backup automático desactivado');
    await load(true);
  }catch(error){
    toast(error.message,'error');
  }
});

$('#app-form').addEventListener('submit',async event=>{
  event.preventDefault();
  if(event.submitter?.value==='cancel'){
    $('#app-dialog').close();
    return;
  }
  const form=new FormData(event.currentTarget);
  const input=Object.fromEntries(form.entries());
  input.driveEnabled=form.has('driveEnabled');
  try{
    await request('/api/apps',{method:'POST',body:JSON.stringify(input)});
    $('#app-dialog').close();
    event.currentTarget.reset();
    toast('Aplicación agregada. Configurá su automatización desde ⌁');
    await load(true);
  }catch(error){
    toast(error.message,'error');
  }
});

if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  Promise.resolve(document.modelContext.registerTool({
    name:'refresh_infrastructure_status',
    title:'Actualizar estado',
    description:'Actualiza el estado, consumo y backups visibles del servidor NanoLabs.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:{readOnlyHint:true,untrustedContentHint:false},
    async execute(){
      await load(true);
      return{updatedAt:state.data?.updatedAt,applications:state.data?.apps?.length||0};
    }
  },{signal:lifecycle.signal})).catch(()=>{});
}

load();
setInterval(()=>load(true),60000);
