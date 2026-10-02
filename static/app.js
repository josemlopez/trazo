'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sid = location.pathname.match(/^\/s\/([a-f0-9]{32})$/)?.[1];
const draftKey = `trazo-draft-${sid}`;
const tablet = new URLSearchParams(location.search).get('surface') === 'tablet' || /iPad|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const clientId = [...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
let session, baseImage, editing = tablet || new URLSearchParams(location.search).get('mode') === 'edit';
let tool = 'pen', color = '#ea5b38', zoom = 1, annotations = [], notes = '', history = [], future = [];
let dirty = false, saving = false, conflict = false, saveTimer, changeNumber = 0, currentStroke = null;
let activePointer = null, touches = new Map(), gesture = null, pan = null, recovered = null;
let connectionOK = true, fetching = false, finishing = false;
let camera = {x:0,y:0}, pixelRatio = 1, lastPenTime = -Infinity, viewSize = null;
let liveSocket, liveTimer, remotePreview = null, livePeers = [], liveStrokeTimer, lastLiveStroke = 0;
const WORLD_LIMIT = 16384;
const canvas = $('#canvas'), ctx = canvas.getContext('2d'), viewport = $('#viewport');
document.body.classList.toggle('tablet',tablet);

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4000); }
function state(message, error=false) { $('#save-state').textContent = message; $('#save-state').classList.toggle('error', error); }
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
async function api(path, options={}) {
  const response = await fetch(path, {...options, signal: AbortSignal.timeout(15000)});
  if (!response.ok) {
    let message = `Error ${response.status}`;
    try { message = (await response.json()).detail || message; } catch {}
    const error = new Error(typeof message === 'string' ? message : 'No se pudo guardar la sesión.'); error.status = response.status; throw error;
  }
  return response.json();
}
function remember(item) {
  const recent = readStorage('trazo-recent', []).filter(s => s.id !== item.id);
  recent.unshift({id:item.id,title:item.title,status:item.status}); store('trazo-recent', recent.slice(0,30));
}
async function upload(file) {
  if (!file || upload.busy) return;
  if (file.size > 25 * 1024 * 1024) { toast('La imagen debe ocupar menos de 25 MB.'); return; }
  upload.busy = true; $('#upload-status').textContent = 'Creando tu sesión…'; $('#file').disabled = true;
  const body = new FormData(); body.append('file', file, file.name || 'captura.png');
  try { const created = await api('/api/sessions', {method:'POST',body}); remember(created); location.href = `/s/${created.id}?share=1`; }
  catch (e) { $('#upload-status').textContent = e.message; upload.busy = false; $('#file').disabled = false; }
}
function initHome() {
  $('#home').hidden = false;
  $('#file').onchange = e => upload(e.target.files[0]);
  const dropzone = $('#dropzone');
  for (const event of ['dragenter','dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.add('dragging'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
  dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragging'); upload(e.dataTransfer.files[0]); });
  document.addEventListener('paste', e => { const file = [...e.clipboardData.items].find(i => i.type.startsWith('image/'))?.getAsFile(); if (file) { e.preventDefault(); upload(file); } });
  const recent = readStorage('trazo-recent', []);
  if (!recent.length) { const empty = document.createElement('div'); empty.className = 'recent-empty'; empty.textContent = 'Las imágenes que subas aparecerán aquí. Empieza con tu primera captura.'; $('#recent').append(empty); }
  for (const item of recent) {
    const card = document.createElement('a'); card.className = 'recent-card'; card.href = `/s/${item.id}`;
    const image = document.createElement('img'); image.src = `/api/sessions/${item.id}/image`; image.alt = ''; image.loading = 'lazy';
    const text = document.createElement('div'), title = document.createElement('strong'), small = document.createElement('small');
    title.textContent = item.title; small.textContent = 'Abrir sesión →'; text.append(title, small); card.append(image,text); $('#recent').append(card);
  }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function liveSend(message) {
  if(liveSocket?.readyState===WebSocket.OPEN && liveSocket.bufferedAmount < 2*1024*1024) liveSocket.send(JSON.stringify(message));
}
function sendDraft() {
  if(!session||!editing)return;
  liveSend({type:'draft',draft:{version:session.version,annotations,notes,status:session.status}});
}
function streamStroke(force=false) {
  if(!session||!editing)return;
  if(force || performance.now()-lastLiveStroke>=70){
    clearTimeout(liveStrokeTimer);liveStrokeTimer=null;lastLiveStroke=performance.now();
    liveSend({type:'stroke',version:session.version,stroke:currentStroke});
  } else if(!liveStrokeTimer){liveStrokeTimer=setTimeout(()=>{liveStrokeTimer=null;streamStroke(true);},70);}
}
function acceptSaved(remote) {
  if(dirty||saving||currentStroke||remote.version<session.version)return;
  if(remotePreview && remote.version>remotePreview.version)remotePreview=null;
  if(remote.version!==session.version){
    session=remote;annotations=clone(remote.annotations);notes=remote.notes;$('#notes').value=notes;
    history=[];future=[];renderPins();draw();updateUndo();
  }
  if(!remotePreview)state(session.status==='ready'?'✓ Listo para el agente':'✓ Guardado en el PC');
}
function connectLive() {
  clearTimeout(liveTimer);
  liveSocket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/sessions/${sid}/live?client=${clientId}`);
  liveSocket.onopen=()=>{
    liveSend({type:'hello',tablet,editing});refresh();
    if(dirty)sendDraft();updateConnection();
  };
  liveSocket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.type==='presence'){
      livePeers=message.peers.filter(p=>p.client!==clientId);
      if(!tablet && livePeers.some(p=>p.tablet&&p.editing) && $('#share-dialog').open)$('#share-dialog').close();
      if(editing && dirty)sendDraft();
      updateConnection();return;
    }
    if(message.client===clientId)return;
    if(message.type==='saved'){acceptSaved(message.session);return;}
    if(dirty||saving||currentStroke)return;
    if(message.type==='draft' && message.draft.version>=session.version){
      remotePreview={...message.draft,client:message.client,stroke:null,seen:Date.now()};
      // Preview changes do not mutate the durable local revision.
      if(document.activeElement!==$('#notes'))$('#notes').value=remotePreview.notes;
      renderPins();draw();state('● Cambios en directo · guardando');
    } else if(message.type==='stroke' && message.version>=session.version){
      if(!remotePreview||remotePreview.client!==message.client)remotePreview={version:message.version,annotations:clone(annotations),notes,client:message.client};
      remotePreview.stroke=message.stroke;remotePreview.seen=Date.now();draw();
      state(message.stroke?'● Dibujando en directo':'● Cambios en directo · guardando');
    }
  };
  liveSocket.onclose=()=>{livePeers=[];updateConnection();liveTimer=setTimeout(connectLive,1500);};
  liveSocket.onerror=()=>liveSocket.close();
}
function checkpoint() { history.push(clone(annotations)); if (history.length > 50) history.shift(); future = []; }
function updateUndo() { $('#undo').disabled = !editing || !history.length; $('#redo').disabled = !editing || !future.length; }
function saveDraft() {
  if (!session) return;
  const ok = store(draftKey, {version:session.version,annotations,notes,status:session.status});
  if (!ok) { notice('El navegador no tiene espacio para un borrador local. Mantén esta página abierta hasta que indique «Guardado en el PC».'); $('#draft').hidden = false; }
}
function changed() {
  dirty = true; changeNumber++; session.status = 'editing'; state('Cambios sin guardar');
  remotePreview=null;saveDraft();clearTimeout(saveTimer);saveTimer=setTimeout(save,350);updateUndo();sendDraft();
}
async function save() {
  clearTimeout(saveTimer);
  if (!dirty || saving || conflict || !session) return;
  saving = true; const number = changeNumber;
  state('Guardando en el PC…');
  const body = JSON.stringify({version:session.version, annotations, notes, status:session.status});
  try {
    const saved = await api(`/api/sessions/${sid}`, {method:'PUT',headers:{'Content-Type':'application/json','X-Trazo-Client':clientId},body});
    session.version = saved.version; session.updated = saved.updated; connectionOK = true;
    if (number === changeNumber) {
      dirty = false; session.status = saved.status;
      try { localStorage.removeItem(draftKey); } catch {}
      state(saved.status === 'ready' ? '✓ Listo para el agente' : '✓ Guardado en el PC');
    } else { saveDraft(); }
    remember(session);
  } catch (e) {
    connectionOK = false; state('No se ha guardado', true); saveDraft();
    if (e.status === 409) {
      conflict = true; notice(e.message); $('#draft').hidden = false;
      const reload = document.createElement('button'); reload.textContent = 'Guardar borrador y cargar versión del PC';
      reload.onclick = async () => {
        downloadDraft();
        try {
          const remote = await api(`/api/sessions/${sid}`);
          session = remote; annotations = clone(remote.annotations); notes = remote.notes;
          $('#notes').value = notes; dirty = false; conflict = false; connectionOK = true;
          history = []; future = []; try { localStorage.removeItem(draftKey); } catch {}
          notice(''); $('#draft').hidden = true; renderPins(); draw(); updateUndo();
          state('✓ Versión del PC cargada');
        } catch (error) { toast(error.message); }
      };
      $('#notice').append(reload);
    }
    else { notice(`${e.message} Tus cambios siguen en este navegador. Volveremos a intentar guardarlos.`); }
  } finally {
    saving = false;
    if (dirty && !conflict) saveTimer = setTimeout(save, connectionOK ? 100 : 4000);
    updateConnection();
  }
}
function renderPins() {
  const previewing=!!remotePreview;
  const pins = (remotePreview?.annotations || annotations).filter(a=>a.kind==='pin'); $('#pin-count').textContent = pins.length; $('#empty-pins').hidden = !!pins.length; $('#pins').replaceChildren();
  pins.forEach((a,index) => {
    const card = document.createElement('div'); card.className = 'pin-card';
    const head = document.createElement('div'); head.className = 'pin-heading';
    const number = document.createElement('span'); number.className = 'pin-number'; number.style.background = a.color; number.textContent = index+1;
    const label = document.createElement('span'); label.textContent = `Zona ${index+1}`; head.append(number,label);
    if (editing && !previewing) {
      const remove = document.createElement('button'); remove.className='pin-delete'; remove.textContent='×'; remove.title='Eliminar esta zona';
      remove.onclick = () => { checkpoint(); annotations.splice(annotations.indexOf(a),1); changed(); renderPins(); draw(); }; head.append(remove);
    }
    const textarea = document.createElement('textarea'); textarea.rows = 2; textarea.maxLength=4000; textarea.placeholder='¿Qué cambio quieres aquí?'; textarea.value=a.text || ''; textarea.disabled=!editing||previewing; textarea.dataset.pin=index;
    textarea.addEventListener('input', () => { a.text=textarea.value; changed(); }); card.append(head,textarea); $('#pins').append(card);
  });
}
function drawAnnotation(a, pinIndex) {
  const points = a.points, [x,y] = points[0], end = points.at(-1);
  ctx.strokeStyle=a.color; ctx.fillStyle=a.color; ctx.lineWidth=a.width; ctx.lineCap='round'; ctx.lineJoin='round';
  if(a.kind==='pen') {
    ctx.beginPath(); ctx.moveTo(x,y); for(const p of points.slice(1)) ctx.lineTo(...p); ctx.stroke();
    if(points.length===1){ctx.beginPath();ctx.arc(x,y,a.width/2,0,Math.PI*2);ctx.fill();}
  } else if(a.kind==='rect') { ctx.strokeRect(x,y,end[0]-x,end[1]-y); }
  else if(a.kind==='arrow') {
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(...end);ctx.stroke();
    const angle=Math.atan2(end[1]-y,end[0]-x),len=Math.max(a.width*4,session.width*.018);
    ctx.beginPath();ctx.moveTo(...end);for(const d of [-.5,.5])ctx.lineTo(end[0]-len*Math.cos(angle+d),end[1]-len*Math.sin(angle+d));ctx.closePath();ctx.fill();
  } else if(a.kind==='pin') {
    const radius=Math.max(12,session.width*.014);ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();ctx.strokeStyle='white';ctx.lineWidth=Math.max(1,radius/8);ctx.stroke();
    ctx.fillStyle='white';ctx.font=`bold ${radius*1.2}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(pinIndex,x,y+radius*.035);
  }
}
function draw() {
  if(!baseImage)return;
  ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#fffefa';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.setTransform(pixelRatio*zoom,0,0,pixelRatio*zoom,-camera.x*pixelRatio*zoom,-camera.y*pixelRatio*zoom);
  ctx.fillStyle='white';ctx.fillRect(0,0,session.width,session.height);ctx.drawImage(baseImage,0,0);
  ctx.strokeStyle='#cbd3c6';ctx.lineWidth=1/zoom;ctx.strokeRect(0,0,session.width,session.height);
  let pin=0;
  for(const a of (remotePreview?.annotations || annotations)){if(a.kind==='pin')pin++;drawAnnotation(a,pin);}
  if(remotePreview?.stroke)drawAnnotation(remotePreview.stroke,pin+1);
  if(currentStroke)drawAnnotation(currentStroke,pin+1);
}
function resizeCanvas() {
  const size={width:viewport.clientWidth,height:viewport.clientHeight};
  if(viewSize){camera.x+=(viewSize.width-size.width)/(2*zoom);camera.y+=(viewSize.height-size.height)/(2*zoom);}
  viewSize=size;
  pixelRatio=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.max(1,Math.round(viewport.clientWidth*pixelRatio));
  canvas.height=Math.max(1,Math.round(viewport.clientHeight*pixelRatio));draw();
}
function setZoom(value, anchor) {
  const old=zoom; zoom=Math.max(.05,Math.min(6,value));
  const ax=anchor?.[0] ?? viewport.clientWidth/2, ay=anchor?.[1] ?? viewport.clientHeight/2;
  camera.x+=ax/old-ax/zoom;camera.y+=ay/old-ay/zoom;
  $('#zoom-label').textContent=`${Math.round(zoom*100)}%`;
  draw();
}
function fit() {
  const margin=Math.max(180,Math.max(session.width,session.height)*.25);
  zoom=Math.max(.05,Math.min(viewport.clientWidth/(session.width+margin*2),viewport.clientHeight/(session.height+margin*2),1));
  camera={x:session.width/2-viewport.clientWidth/(2*zoom),y:session.height/2-viewport.clientHeight/(2*zoom)};
  $('#zoom-label').textContent=`${Math.round(zoom*100)}%`;draw();
}
function fitAll() {
  let left=0,top=0,right=session.width,bottom=session.height;
  for(const a of (remotePreview?.annotations||annotations)){
    const padding=Math.max(a.width*5,session.width*.025,24);
    for(const [x,y] of a.points){left=Math.min(left,x-padding);top=Math.min(top,y-padding);right=Math.max(right,x+padding);bottom=Math.max(bottom,y+padding);}
  }
  zoom=Math.max(.01,Math.min((viewport.clientWidth-50)/(right-left),(viewport.clientHeight-50)/(bottom-top),1));
  camera={x:(left+right)/2-viewport.clientWidth/(2*zoom),y:(top+bottom)/2-viewport.clientHeight/(2*zoom)};
  $('#zoom-label').textContent=`${Math.round(zoom*100)}%`;draw();
}
function imagePoint(e) { const r=canvas.getBoundingClientRect();return [Math.max(-WORLD_LIMIT,Math.min(WORLD_LIMIT,camera.x+(e.clientX-r.left)/zoom)),Math.max(-WORLD_LIMIT,Math.min(WORLD_LIMIT,camera.y+(e.clientY-r.top)/zoom))]; }
function selectTool(value) {tool=value;$$('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));canvas.style.cursor=tool==='pan'?'grab':editing?'crosshair':'default';}

function pointerDown(e) {
  if(e.button!==0)return;
  e.preventDefault();
  // Ignore palm contacts while a pen is active. Fingers can pan/zoom otherwise.
  if(e.pointerType==='touch' && (activePointer!==null || performance.now()-lastPenTime<600))return;
  if(e.pointerType==='pen'){lastPenTime=performance.now();touches.clear();pan=null;gesture=null;}
  if(e.pointerType==='touch') touches.set(e.pointerId,[e.clientX,e.clientY]);
  if(touches.size>=2){const p=[...touches.values()],r=viewport.getBoundingClientRect(),mx=(p[0][0]+p[1][0])/2-r.left,my=(p[0][1]+p[1][1])/2-r.top;gesture={distance:Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1]),zoom,worldX:camera.x+mx/zoom,worldY:camera.y+my/zoom};pan=null;viewport.setPointerCapture(e.pointerId);return;}
  const fingerPan=e.pointerType==='touch' && $('#pencil-only').checked;
  // In Pencil mode, two fingers move the page; a resting palm never pans it.
  if(fingerPan && tablet){viewport.setPointerCapture(e.pointerId);return;}
  if(tool==='pan'||fingerPan||!editing){pan={id:e.pointerId,x:e.clientX,y:e.clientY,left:camera.x,top:camera.y};viewport.setPointerCapture(e.pointerId);return;}
  if(e.target!==canvas || finishing)return;
  if(activePointer!==null)return;
  if(remotePreview){toast('Espera al guardado del otro editor antes de dibujar aquí.');return;}
  if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
  const point=imagePoint(e);activePointer=e.pointerId;canvas.setPointerCapture(e.pointerId);
  currentStroke={kind:tool,color,width:Number($('#width').value)*Math.max(1,session.width/1200),points:[point],text:''};
  draw();streamStroke(true);
}
function pointerMove(e) {
  e.preventDefault();
  if(e.pointerId===activePointer&&e.pointerType==='pen')lastPenTime=performance.now();
  if(touches.has(e.pointerId))touches.set(e.pointerId,[e.clientX,e.clientY]);
  if(gesture&&touches.size>=2){const p=[...touches.values()],r=viewport.getBoundingClientRect();zoom=Math.max(.05,Math.min(6,gesture.zoom*Math.hypot(p[1][0]-p[0][0],p[1][1]-p[0][1])/Math.max(gesture.distance,1)));camera.x=gesture.worldX-((p[0][0]+p[1][0])/2-r.left)/zoom;camera.y=gesture.worldY-((p[0][1]+p[1][1])/2-r.top)/zoom;$('#zoom-label').textContent=`${Math.round(zoom*100)}%`;draw();return;}
  if(pan?.id===e.pointerId){camera.x=pan.left+(pan.x-e.clientX)/zoom;camera.y=pan.top+(pan.y-e.clientY)/zoom;draw();return;}
  if(e.pointerId!==activePointer||!currentStroke)return;
  const events=e.getCoalescedEvents?.()||[e];
  for(const item of events.length?events:[e]){
    const p=imagePoint(item);
    if(currentStroke.kind==='pen') { if(currentStroke.points.length<24900)currentStroke.points.push(p); }
    else if(currentStroke.kind!=='pin')currentStroke.points=[currentStroke.points[0],p];
  }
  draw();streamStroke();
}
function pointerUp(e) {
  e.preventDefault();if(e.pointerType==='pen')lastPenTime=performance.now();
  touches.delete(e.pointerId);if(touches.size<2)gesture=null;if(pan?.id===e.pointerId)pan=null;
  if(e.pointerId!==activePointer)return;
  activePointer=null;
  if(!currentStroke)return;
  // Keep collected ink even if Safari interrupts pointer capture.
  checkpoint();const isPin=currentStroke.kind==='pin';annotations.push(currentStroke);currentStroke=null;draw();changed();renderPins();
  streamStroke(true);
  if(isPin)selectTool('pen');
}
function configureEditing() {
  $('#mode-label').textContent=editing?'MODO ANOTACIÓN':'VISTA DEL PC';$('#toggle-edit').textContent=editing?'Solo ver':'Editar aquí';
  $('#notes').disabled=!editing;$('#finish').disabled=!editing;$('#finish').title=editing?'Guardar y marcar como terminado':'Marca la sesión como terminada desde el editor';
  for(const b of $$('[data-tool],[data-color],#width'))b.disabled=!editing&&b.dataset.tool!=='pan';
  renderPins();updateUndo();selectTool(editing?'pen':'pan');
  liveSend({type:'hello',tablet,editing});
  if(editing)heartbeat();
}
function updateConnection() {
  const tabletConnected=livePeers.some(p=>p.tablet&&p.editing);
  const online=connectionOK&&(editing||session.editor_online||tabletConnected);
  $('#connection-dot').classList.toggle('online',online);
  $('#connection-title').textContent=!connectionOK?'Conexión interrumpida':tabletConnected?'iPad conectado · en directo':editing?'Editando esta sesión':session.editor_online?'Editor conectado':'Esperando al editor';
  $('#connection-detail').textContent=!connectionOK?'Los cambios pendientes siguen en este navegador.':liveSocket?.readyState===WebSocket.OPEN?'Los trazos se comparten mientras dibujas.':'Actualización periódica; reconectando el directo.';
}
async function heartbeat() { if(!editing||document.hidden)return;try{await api(`/api/sessions/${sid}/heartbeat`,{method:'POST'});}catch{} }
async function refresh() {
  if(fetching||document.hidden||!session)return;fetching=true;
  try{
    const remote=await api(`/api/sessions/${sid}`);connectionOK=true;
    session.editor_online=remote.editor_online;
    if(remotePreview && Date.now()-remotePreview.seen>10000){remotePreview=null;$('#notes').value=notes;renderPins();draw();}
    acceptSaved(remote);
  }catch{connectionOK=false;state('Sin conexión con el PC',true);}finally{fetching=false;updateConnection();}
}
async function clipboard(text) {
  try {if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return;}}catch{}
  const textarea=document.createElement('textarea');textarea.value=text;textarea.style.position='fixed';textarea.style.top='0';textarea.style.opacity='0';
  // Keep the fallback inside the modal when it is open, so Safari can focus it.
  ($('#share-dialog').open?$('#share-dialog'):document.body).append(textarea);textarea.focus();textarea.select();textarea.setSelectionRange(0,text.length);
  const copied=document.execCommand('copy');textarea.remove();if(!copied)throw new Error('Selecciona y copia el enlace manualmente.');
}
function share() { $('#qr').src=`/api/sessions/${sid}/qr`;$('#session-url').value=session.url;$('#share-dialog').showModal(); }
function downloadDraft() {
  const blob=new Blob([JSON.stringify({session:sid,version:session.version,annotations,notes},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='borrador-local.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
async function finish() {
  if(finishing||conflict)return;
  finishing=true;$('#finish').disabled=true;
  try{
    if(saving){toast('Espera a que termine el guardado y vuelve a pulsar.');return;}
    session.status='ready';dirty=true;changeNumber++;saveDraft();await save();
    if(dirty)throw new Error('Todavía hay cambios sin guardar. Espera a recuperar la conexión.');
    // Generate the deliverable on the PC when marking ready.
    const response=await fetch(`/api/sessions/${sid}/export/zip`,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('Sesión guardada; no se pudo generar el paquete. Usa «Descargar paquete».');
    await response.arrayBuffer();toast('Listo. El paquete para tu agente ya está guardado en el PC.');
  }catch(e){toast(e.message);}finally{finishing=false;$('#finish').disabled=!editing;}
}
async function previewForAgent() {
  if(dirty)await save();
  if(dirty||saving||currentStroke||remotePreview){toast('Espera a que termine el trazo y aparezca «Guardado en el PC».');return;}
  const button=$('#preview-agent');button.disabled=true;
  try{
    const response=await fetch(`/api/sessions/${sid}/export/png`,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('No se pudo generar la vista del agente.');
    const image=$('#agent-image');if(image.dataset.blob)URL.revokeObjectURL(image.dataset.blob);
    image.dataset.blob=URL.createObjectURL(await response.blob());image.src=image.dataset.blob;
    $('#agent-preview').showModal();
  }catch(e){toast(e.message);}finally{button.disabled=false;}
}

async function initSession() {
  $('#workspace').hidden=false;
  try {
    session=await api(`/api/sessions/${sid}`);annotations=clone(session.annotations);notes=session.notes;remember(session);
    $('#title').textContent=session.title;document.title=`${session.title} · Trazo`;$('#dimensions').textContent=`${session.width} × ${session.height} px · sesión compartida`;
    $('#notes').value=notes;
    baseImage=new Image();baseImage.src=`/api/sessions/${sid}/image`;await baseImage.decode();$('#loading-canvas').hidden=true;
    for(const type of ['png','md','zip'])$('#download-'+type).href=`/api/sessions/${sid}/export/${type}`;
    recovered=readStorage(draftKey,null);
    if(recovered){
      if(recovered.version===session.version){editing=true;annotations=recovered.annotations;notes=recovered.notes;$('#notes').value=notes;dirty=true;changeNumber++;notice('Se ha recuperado tu borrador local. Se guardará automáticamente en el PC.');saveTimer=setTimeout(save,1000);}
      else {notice('Hay un borrador local y una versión más reciente en el PC. Puedes descargar el borrador antes de continuar.');$('#draft').hidden=false;$('#draft').onclick=()=>{const original=annotations,originalNotes=notes;annotations=recovered.annotations;notes=recovered.notes;downloadDraft();annotations=original;notes=originalNotes;};}
    }
    configureEditing();resizeCanvas();if(tablet)fit();else fitAll();state(dirty?'Borrador recuperado':'✓ Guardado en el PC');connectLive();updateConnection();
    new ResizeObserver(resizeCanvas).observe(viewport);
    if(!tablet&&new URLSearchParams(location.search).get('share')==='1')share();
    setInterval(refresh,2000);setInterval(heartbeat,5000);
  } catch(e) {state('No se pudo abrir',true);notice(e.message);$('#loading-canvas').textContent='No se pudo cargar la imagen.';return;}
  $('#share').onclick=share;$('#close-share').onclick=()=>$('#share-dialog').close();
  $('#panel-toggle').onclick=()=>{const open=document.body.classList.toggle('panel-open');$('#panel-toggle').setAttribute('aria-expanded',open);};
  $('#tools-toggle').onclick=()=>{const open=document.body.classList.toggle('tools-open');$('#tools-toggle').setAttribute('aria-expanded',open);};
  $('#copy-link').onclick=async()=>{try{await clipboard(session.url);toast('Enlace copiado');}catch(e){toast(e.message);}};
  $('#toggle-edit').onclick=async()=>{if(dirty||saving){await save();if(dirty||saving){toast('Espera a que se guarden los cambios.');return;}}editing=!editing;const url=new URL(location.href);url.searchParams.set('mode',editing?'edit':'view');url.searchParams.delete('share');window.history.replaceState(null,'',url);configureEditing();updateConnection();};
  $('#notes').oninput=()=>{notes=$('#notes').value;changed();};
  $$('[data-tool]').forEach(b=>b.onclick=()=>selectTool(b.dataset.tool));
  $$('[data-color]').forEach(b=>b.onclick=()=>{color=b.dataset.color;$$('[data-color]').forEach(c=>c.classList.toggle('active',c===b));});
  $('#undo').onclick=()=>{if(!history.length||!editing)return;future.push(clone(annotations));annotations=history.pop();changed();renderPins();draw();};
  $('#redo').onclick=()=>{if(!future.length||!editing)return;history.push(clone(annotations));annotations=future.pop();changed();renderPins();draw();};
  $('#fit').onclick=fit;$('#fit-all').onclick=fitAll;$('#zoom-in').onclick=()=>setZoom(zoom*1.25);$('#zoom-out').onclick=()=>setZoom(zoom/1.25);
  $('#preview-agent').onclick=previewForAgent;$('#close-agent-preview').onclick=()=>$('#agent-preview').close();
  $('#finish').onclick=finish;if(!$('#draft').onclick)$('#draft').onclick=downloadDraft;
  $('#copy-prompt').onclick=async()=>{
    const pins=annotations.filter(a=>a.kind==='pin');
    const text=[`Quiero modificar la imagen «${session.title}». Revisa original, anotada.png e instrucciones.md del paquete adjunto. Lee también la escritura a mano y las flechas en los márgenes, fuera de la imagen original; forman parte de las instrucciones.`,notes,...pins.map((a,i)=>`Zona ${i+1}: ${a.text||'Ver marca en la imagen.'}`),'Aplica los cambios indicados y pregunta si alguna marca es ambigua.'].filter(Boolean).join('\n\n');
    try{await clipboard(text);toast('Mensaje copiado. Adjunta el paquete o la imagen a tu agente.');}catch(e){toast(e.message);}
  };
  for(const a of $$('.export-section a'))a.addEventListener('click',async e=>{if(dirty||saving){e.preventDefault();await save();if(dirty||saving)toast('El paquete todavía no incluye los cambios pendientes. Espera al guardado.');else location.href=a.href;}});
  viewport.addEventListener('pointerdown',pointerDown);viewport.addEventListener('pointermove',pointerMove);viewport.addEventListener('pointerup',pointerUp);viewport.addEventListener('pointercancel',pointerUp);
  canvas.addEventListener('lostpointercapture',e=>{if(e.pointerId===activePointer)pointerUp(e);});
  viewport.addEventListener('contextmenu',e=>e.preventDefault());
  viewport.addEventListener('touchstart',e=>e.preventDefault(),{passive:false});
  viewport.addEventListener('touchmove',e=>e.preventDefault(),{passive:false});
  viewport.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();const r=viewport.getBoundingClientRect();setZoom(zoom*Math.exp(-e.deltaY*.01),[e.clientX-r.left,e.clientY-r.top]);}},{passive:false});
  window.addEventListener('beforeunload',e=>{if(dirty||saving){saveDraft();e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&dirty){saveDraft();save();}else{refresh();heartbeat();}});
  document.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName))return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();(e.shiftKey?$('#redo'):$('#undo')).click();}else if(editing){const key={l:'pen',f:'arrow',r:'rect',n:'pin',m:'pan'}[e.key.toLowerCase()];if(key)selectTool(key);}});
}
if(sid)initSession();else initHome();
