'use strict';
const $=s=>document.querySelector(s), audio=$('#audio');
let db, tracks=[],playlists=[],current=null,queue=[],view='home',shuffled=false,repeated=false,toastTimer;
const CLOUD_API='https://jpqvcbchqqygwhpgwoyi.supabase.co/functions/v1/melospace-api/library';
let cloudBusy=false,cloudStatus='';
let cloudReady=false,cloudWrites=0;
async function collections(){const p=[],m=[];let offset=0;while(true){const data=await cloudCall('collections',{offset});if(!Array.isArray(data.playlists)||!Array.isArray(data.memberships))throw new Error('UPDATE_BACKEND');p.push(...data.playlists);m.push(...data.memberships);if(!data.hasMore)break;offset+=100}return{playlists:p,memberships:m}}
async function setMembership(t,id,add){
  if(t.saving||cloudBusy)return;
  if(!t.cloud){const old=[...t.playlists];t.playlists=add?[...t.playlists,id]:t.playlists.filter(x=>x!==id);try{await saveTrack(t)}catch{t.playlists=old;toast('Не удалось сохранить плейлист')}render();return}
  if(!cloudReady){toast('Сначала обнови серверную медиатеку');return}
  t.saving=true;cloudWrites++;try{await cloudCall('membership',{trackId:t.serverId,playlistId:id,add});t.playlists=add?[...new Set([...t.playlists,id])]:t.playlists.filter(x=>x!==id);toast('Плейлист синхронизирован')}catch{toast('Не удалось сохранить. Проверь подключение и попробуй снова.')}finally{t.saving=false;cloudWrites--;render()}
}
async function migrateCollections(){
 if(!cloudReady||cloudBusy||cloudWrites)return;
 cloudWrites++;$('#cloudImport').disabled=true;let success=false;
 try{
  const mapping=new Map();
  for(const p of playlists.filter(p=>!p.cloud)){const result=await cloudCall('playlist_create',{name:p.name,clientKey:'legacy:'+p.id});mapping.set(p.id,result.playlist.id)}
  for(const t of tracks.filter(t=>t.cloud)){
   const prefs=cloudPreferences(t);
   if(prefs.favorite)await cloudCall('favorite',{trackId:t.serverId,favorite:true});
   for(const id of Array.isArray(prefs.playlists)?prefs.playlists:[]){if(mapping.has(id))await cloudCall('membership',{trackId:t.serverId,playlistId:mapping.get(id),add:true})}
  }
  // Clear legacy cloud preferences only after the entire import succeeds.
  for(const t of tracks.filter(t=>t.cloud)){try{localStorage.removeItem(preferenceKey(t))}catch{}}
  success=true;toast('Коллекции с устройства перенесены на сервер');
 }catch{toast('Перенос не завершён. Данные на устройстве сохранены — можно повторить.')}finally{cloudWrites--;$('#cloudImport').disabled=false;if(success)await loadCloud()}
}

function cloudNote(text){cloudStatus=text;const el=$('#cloudStatus');if(el)el.textContent=text}
function preferenceKey(t){return `melospace-cloud:${window.Telegram?.WebApp?.initDataUnsafe?.user?.id||'unknown'}:${t.serverId}`}
function cloudPreferences(t){try{return JSON.parse(localStorage.getItem(preferenceKey(t))||'{}')}catch{return {}}}
async function cloudCall(action,extra={}){
  const initData=window.Telegram?.WebApp?.initData;
  if(!initData)throw new Error('OPEN_IN_TELEGRAM');
  const response=await fetch(CLOUD_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,initData,...extra}),signal:AbortSignal.timeout(20000)});
  let data;try{data=await response.json()}catch{throw new Error('UPDATE_BACKEND')}
  if(!response.ok)throw new Error(data.error||'LIBRARY_UNAVAILABLE');
  return data;
}
async function loadCloud(){
  if(cloudBusy||cloudWrites)return;
  if(!window.Telegram?.WebApp?.initData){cloudNote('Серверная музыка доступна при запуске через кнопку бота в Telegram.');return}
  cloudBusy=true;$('#cloudRefresh').disabled=true;cloudNote('Загружаем музыку из бота…');
  try{
    const rows=[];let offset=0;
    while(true){const data=await cloudCall('list',{offset});if(!Array.isArray(data.tracks))throw new Error('UPDATE_BACKEND');rows.push(...data.tracks);if(!data.hasMore)break;offset+=data.tracks.length;if(!data.tracks.length)break}
    const groups=await collections();
    const old=new Map(tracks.filter(t=>t.cloud).map(t=>[t.id,t]));
    const remote=rows.map(row=>{const id='cloud:'+row.id;const previous=old.get(id);const t={id,serverId:row.id,cloud:true,title:row.title,artist:row.artist,url:previous?.url||'',expiresAt:previous?.expiresAt||0};return {...t,favorite:!!row.favorite,playlists:groups.memberships.filter(m=>m.track_id===row.id).map(m=>m.playlist_id)}});
    tracks=[...tracks.filter(t=>!t.cloud),...remote];
    playlists=[...playlists.filter(p=>!p.cloud),...groups.playlists.map(p=>({...p,cloud:true}))];cloudReady=true;
    $('#cloudImport').hidden=!playlists.some(p=>!p.cloud)&&!remote.some(t=>{const prefs=cloudPreferences(t);return prefs.favorite||prefs.playlists?.length});
    queue=queue.filter(id=>tracks.some(t=>t.id===id));
    cloudNote(`Из бота: ${remote.length} треков. Отправь аудио в чат бота и нажми «Обновить». Избранное и серверные плейлисты синхронизируются. На другом устройстве нажми «Обновить».`);render();
  }catch(error){
    cloudReady=false;
    const text=error.message==='TELEGRAM_AUTH_REQUIRED'?'Сессия Telegram истекла. Закрой Mini App и открой заново через бота.':error.message==='UPDATE_BACKEND'?'Нужно обновить функцию melospace-api до версии 5.':'Не удалось загрузить музыку из бота. Проверь подключение и обновление серверной функции.';
    cloudNote(text);
  }finally{cloudBusy=false;$('#cloudRefresh').disabled=false}
}
let playRequest=0;
async function cloudUrl(t){if(t.url&&t.expiresAt>Date.now())return;const data=await cloudCall('stream',{trackId:t.serverId});t.url=data.url;t.expiresAt=data.expiresAt}

let meloTimer, meloSpeechTimer, meloGreetingTimer;
let transitionTimer=null;
const reducedMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
function meloSay(text,reset=true){const bubble=$('#meloSpeech');if(bubble)bubble.textContent=text;clearTimeout(meloSpeechTimer);if(reset)meloSpeechTimer=setTimeout(()=>{if(bubble)bubble.textContent=audio.paused?'Я рядом. Выбирай, что послушаем.':'Хороший трек. Ты умеешь выбирать.'},4200)}
function meloSwitch(direction=1){clearTimeout(meloTimer);document.body.classList.remove('melo-switching');void document.body.offsetWidth;document.body.classList.add('melo-switching');window.MeloMotion?.play('switch');meloSay(direction<0?'Ещё раз? Возвращаю предыдущий.':'Следующий трек? Сейчас, лапку протяну.');meloTimer=setTimeout(()=>document.body.classList.remove('melo-switching'),reducedMotion()?250:1220)}
function cancelMeloTransition(){if(transitionTimer!==null){clearTimeout(transitionTimer);transitionTimer=null}}
function greetMelo(){if(transitionTimer!==null)return;clearTimeout(meloGreetingTimer);document.body.classList.remove('melo-greeting');void document.body.offsetWidth;document.body.classList.remove('melo-switching');document.body.classList.add('melo-greeting');window.MeloMotion?.play('wave');meloSay('Я Melo. Музыку не ворую. Только сердечки ♡');meloGreetingTimer=setTimeout(()=>document.body.classList.remove('melo-greeting'),1620)}
function demoMelo(){if(transitionTimer!==null)return;meloSwitch();$('#meloAnnouncement').textContent='Melo показывает, как нажимает кнопку следующего трека.'}
$('#meetMelo').onclick=greetMelo;$('#demoMelo').onclick=demoMelo;
function syncMelo(){document.body.classList.toggle('is-playing',!audio.paused)}

const fmt=s=>Number.isFinite(s)?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`:'0:00';
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4200)}
function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function write(store,value,remove=false){return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');const object=tx.objectStore(store);remove?object.delete(value):object.put(value);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
async function init(){try{const open=indexedDB.open('melospace-v2',1);open.onupgradeneeded=()=>{open.result.createObjectStore('tracks',{keyPath:'id'});open.result.createObjectStore('playlists',{keyPath:'id'})};db=await request(open);const tx=db.transaction(['tracks','playlists']);[tracks,playlists]=await Promise.all([request(tx.objectStore('tracks').getAll()),request(tx.objectStore('playlists').getAll())]);tracks.forEach(t=>t.url=URL.createObjectURL(t.blob));render()}catch(e){toast('Локальное хранилище недоступно. Серверная медиатека продолжит работать.')}finally{await loadCloud()}}
function visible(){const q=$('#search').value.trim().toLowerCase(),filter=$('#filter').value;return tracks.filter(t=>(view!=='favorites'||t.favorite)&&(filter==='all'||t.playlists.includes(filter))&&`${t.title} ${t.artist}`.toLowerCase().includes(q))}
function element(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function button(label,title,action,cls=''){const b=element('button',cls,label);b.type='button';b.title=title;b.setAttribute('aria-label',title);b.onclick=action;return b}
function render(){const selected=$('#filter').value;$('#filter').replaceChildren(new Option('Все треки','all'),...playlists.map(p=>new Option(p.name,p.id)));$('#filter').value=playlists.some(p=>p.id===selected)?selected:'all';$('#tracks').replaceChildren();visible().forEach(t=>{const row=element('div',`track${current===t.id?' active':''}`);const cover=button(current===t.id&&!audio.paused?'Ⅱ':'▶︎','Воспроизвести '+t.title,()=>play(t.id),'cover');const info=button('','Воспроизвести '+t.title,()=>play(t.id),'track-info');info.append(element('b','track-title',t.title),element('small','',t.artist));const fav=button(t.favorite?'♥':'♡','Добавить или убрать из избранного',()=>favorite(t),t.favorite?'liked':'');const add=element('select');add.setAttribute('aria-label','Добавить в плейлист: '+t.title);add.append(new Option('＋ Плейлист',''),...playlists.filter(p=>!!p.cloud===!!t.cloud).map(p=>new Option((t.playlists.includes(p.id)?'✓ ':'')+p.name,p.id)));add.onchange=()=>{const id=add.value;if(id)setMembership(t,id,!t.playlists.includes(id))};row.append(cover,info,fav,add);if(!t.cloud)row.append(button('×','Удалить трек',()=>removeTrack(t)));else row.append(element('small','cloud-badge','☁'));$('#tracks').append(row)});const isEmpty=visible().length===0;$('#empty').hidden=!isEmpty;$('#empty h3').textContent=tracks.length?'Здесь пока тихо':'Здесь начинается твоя музыка';$('#empty p').textContent=tracks.length?'Попробуй другой поиск или добавь треки в эту коллекцию.':'Добавь аудиофайлы — они сохранятся на этом устройстве.';$('#favCount').textContent=tracks.filter(t=>t.favorite).length+' треков';$('#totalCount').textContent=tracks.length+' треков';syncPlayer()}
async function saveTrack(t){if(t.cloud)throw new Error('USE_CLOUD_MUTATION');const {url,...stored}=t;await write('tracks',stored)}
async function favorite(t){
 if(t.saving||cloudBusy)return;
 const value=!t.favorite;
 if(t.cloud){if(!cloudReady){toast('Сначала обнови медиатеку');return}t.saving=true;cloudWrites++;try{await cloudCall('favorite',{trackId:t.serverId,favorite:value});t.favorite=value}catch{toast('Избранное не сохранено. Проверь подключение.')}finally{t.saving=false;cloudWrites--;render()}return}
 const previous=t.favorite;t.favorite=value;try{await saveTrack(t)}catch{t.favorite=previous;toast('Не удалось сохранить избранное')}render();
}
async function removeTrack(t){try{await write('tracks',t.id,true);if(current===t.id){audio.pause();audio.removeAttribute('src');audio.load();current=null}URL.revokeObjectURL(t.url);tracks=tracks.filter(x=>x.id!==t.id);queue=queue.filter(id=>id!==t.id);render()}catch{toast('Не удалось удалить трек')}}
async function play(id,newQueue){cancelMeloTransition();const previousId=current;const t=tracks.find(x=>x.id===id);if(!t)return;if(newQueue)queue=[...newQueue];else if(!queue.includes(id))queue=visible().map(x=>x.id);if(current===id&&!audio.paused&&audio.getAttribute('src')){audio.pause();return}const ticket=++playRequest;try{if(t.cloud)await cloudUrl(t);if(ticket!==playRequest)return;if(current!==id||audio.getAttribute('src')!==t.url){current=id;audio.src=t.url}await audio.play();syncMelo();if(previousId!==id){$('#meloAnnouncement').textContent='Melo включил: '+t.title;meloSay('Сейчас играет: '+t.title)}}catch(e){toast('Не удалось воспроизвести файл. Попробуй MP3, M4A или WAV.')}render();if('mediaSession'in navigator){navigator.mediaSession.metadata=new MediaMetadata({title:t.title,artist:t.artist,album:'MeloSpace'})}}
function syncPlayer(){syncMelo();const t=tracks.find(x=>x.id===current);$('#nowTitle').textContent=t?.title||'Твоя музыка ждёт';$('#nowArtist').textContent=t?.artist||'Добавь первый трек';$('#play').textContent=audio.paused?'▶︎':'Ⅱ';$('#play').setAttribute('aria-label',audio.paused?'Воспроизвести':'Пауза');$('#nowFav').textContent=t?.favorite?'♥':'♡';$('#nowFav').classList.toggle('liked',!!t?.favorite);$('#elapsed').textContent=fmt(audio.currentTime);$('#duration').textContent=fmt(audio.duration);$('#seek').value=Number.isFinite(audio.duration)&&audio.duration>0?audio.currentTime/audio.duration*1000:0}
function performStep(delta){if(!tracks.length){toast('Сначала добавь музыку');return}if(!queue.length)queue=tracks.map(t=>t.id);const at=queue.indexOf(current);let next;if(shuffled&&queue.length>1){const others=queue.filter(id=>id!==current);next=others[Math.floor(Math.random()*others.length)]}else next=queue[(at+delta+queue.length)%queue.length];if(current===next){audio.currentTime=0;if(tracks.find(t=>t.id===current)?.cloud){const t=tracks.find(t=>t.id===current);t.expiresAt=0;audio.removeAttribute('src');play(current)}else audio.play().catch(()=>toast('Не удалось воспроизвести трек'))}else play(next)}
function step(delta){
 if(!tracks.length){toast('Сначала добавь музыку');meloSay('Пришли музыку в бот, а дальше я помогу.');return}
 cancelMeloTransition();++playRequest;meloSwitch(delta);
 transitionTimer=setTimeout(()=>{transitionTimer=null;performStep(delta)},reducedMotion()?0:600);
}
function navigate(next){view=next;$('#home').hidden=next!=='home';const titles={home:'Твоя музыка. Твой Melo.',search:'Найди свой звук.',library:'Твоя медиатека.',favorites:'Мне нравится.'};$('#heading').textContent=titles[next];$('#listHeading').textContent=next==='favorites'?'Любимые треки':next==='search'?'Результаты поиска':'Моя музыка';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===next));$('#filter').value='all';$('#search').value='';render();if(next==='search')$('#search').focus()}
function newId(){return globalThis.crypto?.randomUUID?.()||`track-${Date.now()}-${Math.random().toString(36).slice(2)}`}
async function importAudio(e){
  const input=e.target, files=Array.from(input.files||[]);
  if(!files.length)return;
  if(!db){toast('Хранилище недоступно. Открой приложение в обычном браузере и попробуй снова.');input.value='';return}
  let added=0,skipped=0,failed=false;
  toast('Добавляем музыку…');
  for(const file of files){
    if(!file.type.startsWith('audio/')&&!/\.(mp3|wav|ogg|m4a|flac|aac|opus|oga|weba|aiff|aif)$/i.test(file.name)){skipped++;continue}
    try{
      const name=file.name.replace(/\.[^.]+$/,''),parts=name.split(' - ');
      const t={id:newId(),title:parts.length>1?parts.slice(1).join(' - '):name,artist:parts.length>1?parts[0]:'Моя музыка',blob:file,favorite:false,playlists:[]};
      await saveTrack(t);t.url=URL.createObjectURL(file);tracks.push(t);added++;
    }catch{failed=true;break}
  }
  input.value='';render();
  if(failed)toast(`Добавлено: ${added}. Не удалось сохранить следующий файл. Проверь свободную память или открой приложение в браузере.`);
  else if(added)toast(`Добавлено треков: ${added}${skipped?' · Пропущено неаудиофайлов: '+skipped:''}`);
  else toast('Аудиофайлы не найдены. Выбери MP3, M4A, WAV, OGG или FLAC в папке «Загрузки».');
}
$('#cloudImport').onclick=migrateCollections;$('#cloudRefresh').onclick=loadCloud;$('#botUpload').onclick=()=>{if(window.Telegram?.WebApp?.initData)window.Telegram.WebApp.openTelegramLink('https://t.me/MeloSpaceMusicBot');else window.open('https://t.me/MeloSpaceMusicBot','_blank','noopener')};
document.querySelectorAll('[data-audio-input]').forEach(input=>input.addEventListener('change',importAudio));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>navigate(b.dataset.view));$('#search').oninput=render;$('#filter').onchange=render;
$('#play').onclick=()=>current?play(current):visible()[0]?play(visible()[0].id):toast('Сначала добавь музыку');$('#next').onclick=()=>step(1);$('#prev').onclick=()=>audio.currentTime>3?audio.currentTime=0:step(-1);$('#nowFav').onclick=()=>{const t=tracks.find(x=>x.id===current);if(t)favorite(t)};
$('#shuffle').onclick=()=>{shuffled=!shuffled;$('#shuffle').classList.toggle('liked',shuffled);$('#shuffle').setAttribute('aria-pressed',String(shuffled))};$('#repeat').onclick=()=>{repeated=!repeated;$('#repeat').classList.toggle('liked',repeated);$('#repeat').setAttribute('aria-pressed',String(repeated))};$('#wave').onclick=()=>{if(!tracks.length){toast('Добавь треки, чтобы запустить свою волну');$('#files').click();return}shuffled=true;$('#shuffle').classList.add('liked');$('#shuffle').setAttribute('aria-pressed','true');play(tracks[Math.floor(Math.random()*tracks.length)].id,tracks.map(t=>t.id))};
audio.volume=.8;$('#volume').oninput=e=>audio.volume=Number(e.target.value);$('#seek').oninput=e=>{if(Number.isFinite(audio.duration))audio.currentTime=audio.duration*Number(e.target.value)/1000};audio.ontimeupdate=syncPlayer;audio.onloadedmetadata=syncPlayer;audio.onplay=render;audio.onpause=()=>{render();if(transitionTimer===null)document.body.classList.remove('is-playing')};audio.onended=()=>{if(repeated){audio.currentTime=0;audio.play().catch(()=>toast('Нажми воспроизведение, чтобы продолжить'))}else step(1)};audio.onerror=()=>toast('Этот аудиофайл не поддерживается или повреждён.');
function openPlaylist(){$('#playlistDialog').showModal();$('#playlistName').focus()}$('#playlistNew').onclick=openPlaylist;$('#newPlaylist').onclick=openPlaylist;$('#playlistForm').onsubmit=async e=>{e.preventDefault();const name=$('#playlistName').value.trim();if(!name||cloudBusy||cloudWrites)return;
 const useCloud=!!window.Telegram?.WebApp?.initData;
 if(useCloud&&!cloudReady){toast('Дождись загрузки медиатеки. Проверь обновление серверной функции.');return}
 const p={id:newId(),name};cloudWrites++;
 try{if(useCloud){const result=await cloudCall('playlist_create',{name,clientKey:p.id});playlists.push({...result.playlist,cloud:true})}else{await write('playlists',p);playlists.push(p)}$('#playlistName').value='';$('#playlistDialog').close();render();toast(useCloud?'Плейлист сохранён на сервере':'Плейлист сохранён на устройстве')}
 catch{toast('Не удалось сохранить плейлист')}finally{cloudWrites--}};

function showQueue(){$('#queueList').replaceChildren();const ids=queue.length?queue:tracks.map(t=>t.id);if(!ids.length)$('#queueList').append(element('p','','Добавь музыку — здесь появится очередь.'));ids.forEach(id=>{const t=tracks.find(x=>x.id===id);if(!t)return;const b=button((id===current?'▶︎ ':'')+t.artist+' — '+t.title,'Воспроизвести '+t.title,()=>{play(id);$('#queueDialog').close()},'track');$('#queueList').append(b)});$('#queueDialog').showModal()}$('#queueBtn').onclick=showQueue;$('#nowCover').onclick=showQueue;document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>document.getElementById(b.dataset.close).close());
const tg=window.Telegram?.WebApp;if(tg?.initData){try{tg.ready();tg.expand();tg.setHeaderColor('#100e17');tg.setBackgroundColor('#100e17')}catch{}}if('mediaSession'in navigator){for(const [action,handler]of Object.entries({play:()=>audio.play().catch(()=>{}),pause:()=>audio.pause(),previoustrack:()=>step(-1),nexttrack:()=>step(1)})){try{navigator.mediaSession.setActionHandler(action,handler)}catch{}}}render();init();
