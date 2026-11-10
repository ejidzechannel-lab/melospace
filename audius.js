/* Public Audius discovery. Audio stays with Audius; no catalogue files enter Supabase. */
(() => {
 'use strict';
 const API='https://api.audius.co/v1',APP='MeloSpace';
 let ids=[],offset=0,more=false,busy=false,sequence=0,controller,timer;
 const $a=s=>document.querySelector(s);
 function allowed(t){return !!t&&typeof t.id==='string'&&/^[A-Za-z0-9]+$/.test(t.id)&&t.is_streamable===true&&t.is_available!==false&&!t.is_stream_gated&&!t.stream_conditions&&!t.is_unlisted&&!t.is_delete&&!t.is_scheduled_release}
 function sourceLink(t){return typeof t.permalink==='string'&&/^\/(?!\/)/.test(t.permalink)?'https://audius.co'+t.permalink:'https://audius.co/'}
 function mapTrack(t){return{id:'audius:'+t.id,audius:true,audiusId:t.id,title:String(t.title||'Без названия'),artist:String(t.user?.name||t.user?.handle||'Audius'),duration:Number(t.duration)||0,cover:typeof t.artwork?.['150x150']==='string'&&t.artwork['150x150'].startsWith('https://')?t.artwork['150x150']:'',source:sourceLink(t),favorite:false,playlists:[],url:''}}
 let preferred='https://api.audius.co/v1';
 const PROXY='https://jpqvcbchqqygwhpgwoyi.supabase.co/functions/v1/melospace-api/catalog';
 async function attempt(url,options,signal,ms=7000){
  if(signal?.aborted)throw new Error('CANCELLED');
  const control=new AbortController();const stop=()=>control.abort();signal?.addEventListener('abort',stop,{once:true});const timer=setTimeout(stop,ms);
  try{const response=await fetch(url,{...options,signal:control.signal});if(response.status===429)throw new Error('RATE_LIMIT');if(response.status===401||response.status===403)throw new Error('ACCESS_DENIED');if(!response.ok)throw new Error('HTTP_'+response.status);const result=await response.json();if(!result||!('data'in result))throw new Error('INVALID_RESPONSE');return result}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop)}
 }
 async function get(path,params={},signal){
  const hosts=[preferred,...['https://api.audius.co/v1','https://discoveryprovider.audius.co/v1'].filter(h=>h!==preferred)];
  let last;
  for(const host of hosts){const url=new URL(host+path);url.searchParams.set('app_name',APP);for(const[k,v]of Object.entries(params))if(v!==''&&v!=null)url.searchParams.set(k,String(v));
   try{const result=await attempt(url,{},signal);preferred=host;return result}catch(error){last=error;if(signal?.aborted)throw new Error('CANCELLED');if(error.message==='RATE_LIMIT'||error.message==='ACCESS_DENIED')throw error}
  }
  try{return await attempt(PROXY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,params})},signal,18000)}
  catch(error){if(signal?.aborted)throw new Error('CANCELLED');if(error.message==='RATE_LIMIT'||error.message==='ACCESS_DENIED')throw error;throw new Error('CATALOG_CONNECTION_FAILED')}
 }
 function note(text){$a('#catalogStatus').textContent=text}
 function renderCatalog(){const list=$a('#catalogTracks');if(!list)return;list.replaceChildren();for(const id of ids){const t=tracks.find(t=>t.id===id);if(!t)continue;const row=element('div','track'+(id===current?' active':''));const cover=button(id===current&&!audio.paused?'Ⅱ':'▶︎','Слушать '+t.title,()=>play(t.id,[...ids]),'cover audius-cover');if(t.cover){const img=document.createElement('img');img.src=t.cover;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';img.onerror=()=>img.remove();cover.prepend(img)}const info=button('','Слушать '+t.title,()=>play(t.id,[...ids]),'track-info');info.append(element('b','track-title',t.title),element('small','',t.artist));const duration=element('small','catalog-duration',fmt(t.duration));const source=document.createElement('a');source.textContent='Audius ↗';source.href=t.source;source.target='_blank';source.rel='noopener noreferrer';source.className='audius-source';source.setAttribute('aria-label','Открыть '+t.title+' на Audius');row.append(cover,info,duration,source);list.append(row)}$a('#catalogMore').hidden=!more;$a('#catalogMore').disabled=busy;$a('#catalogRetry').hidden=!$a('#catalogStatus').dataset.error}
 async function load(reset=true){const ticket=++sequence;controller?.abort();controller=new AbortController();const own=controller;const timeout=setTimeout(()=>own.abort(),34000);busy=true;$a('#catalogStatus').dataset.error='';if(reset){offset=0;ids=[];more=false;renderCatalog()}note('Ищем музыку на Audius…');const q=$a('#catalogSearch').value.trim(),genre=$a('#catalogGenre').value;
 try{const data=await get(q?'/tracks/search':'/tracks/trending',{query:q,genre,limit:30,offset},own.signal);if(ticket!==sequence)return;if(!Array.isArray(data.data))throw new Error('INVALID_RESPONSE');const rows=data.data;offset+=rows.length;more=rows.length===30;const existing=new Map(tracks.map(t=>[t.id,t]));for(const row of rows.filter(allowed)){const mapped=mapTrack(row);if(!existing.has(mapped.id)){tracks.push(mapped);existing.set(mapped.id,mapped)}else Object.assign(existing.get(mapped.id),mapped);if(!ids.includes(mapped.id))ids.push(mapped.id)}note(ids.length?`${q?'Поиск':'Популярное'}${genre?' · '+genre:''} · ${ids.length} треков. Источник: Audius.`:'Доступных треков пока нет. Попробуй другой запрос или жанр.');renderCatalog();}
 catch(error){if(ticket!==sequence)return;$a('#catalogStatus').dataset.error='true';note(error.message==='RATE_LIMIT'?'Audius временно ограничил запросы. Попробуй позже.':error.message==='ACCESS_DENIED'?'Audius отклонил доступ. Код: ACCESS_DENIED.':'Нет соединения с Audius. Код: CATALOG_CONNECTION_FAILED. Если повторяется — нужно обновить melospace-api до версии 6.');}
 finally{clearTimeout(timeout);if(ticket===sequence){busy=false;renderCatalog()}}
 }
 async function prepare(t){const result=await get('/tracks/'+encodeURIComponent(t.audiusId));if(!allowed(result.data))throw new Error('TRACK_UNAVAILABLE');const stream=result.data.stream?.url;let usable=false;try{usable=!!stream&&new URL(stream).protocol==='https:'}catch{}t.url=usable?stream:preferred+'/tracks/'+encodeURIComponent(t.audiusId)+'/stream?app_name='+APP}
 window.AudiusCatalog={open(){if(!ids.length&&!busy)load(true);else renderCatalog()},render:renderCatalog,prepare,allowed,mapTrack};
 document.addEventListener('DOMContentLoaded',()=>{
  $a('#catalogSearch').addEventListener('input',()=>{clearTimeout(timer);controller?.abort();sequence++;timer=setTimeout(()=>load(true),450)});
  $a('#catalogSearch').addEventListener('keydown',e=>{if(e.key==='Enter'){clearTimeout(timer);load(true)}});
  $a('#catalogGenre').onchange=()=>{clearTimeout(timer);load(true)};
  $a('#catalogMore').onclick=()=>load(false);$a('#catalogRetry').onclick=()=>load(ids.length===0);
 });
})();
