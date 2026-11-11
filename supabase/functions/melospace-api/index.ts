import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'melospace-audio';
const MAX_BYTES = 20_000_000;
const FORMATS = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac', aiff: 'audio/aiff',
};

function reply(chatId, text) {
  return Response.json({ method: 'sendMessage', chat_id: chatId, text });
}

// Check actual bytes as well as Telegram's advertised size.
async function readAudio(response) {
  if (!response.ok || !response.body) throw new Error('download');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error('size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('empty');
  return new Blob(chunks);
}

const WEB_ORIGIN = 'https://ejidzechannel-lab.github.io';
const CORS = {
  'Access-Control-Allow-Origin': WEB_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin',
  'Cache-Control': 'no-store',
};
function apiJson(body, status = 200) {
  return Response.json(body, { status, headers: CORS });
}
async function authenticateInitData(raw, token) {
  if (typeof raw !== 'string' || raw.length > 16384 || !token) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  const seen = new Set();
  for (const [key] of params) {
    if (seen.has(key)) return null;
    seen.add(key);
  }
  params.delete('hash');
  const data = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const encoder = new TextEncoder();
  async function hmac(key, message) {
    const imported = await crypto.subtle.importKey('raw', key,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message)));
  }
  const key = await hmac(encoder.encode('WebAppData'), token);
  const expected = await hmac(key, data);
  const supplied = Uint8Array.from(hash.match(/../g), byte => parseInt(byte, 16));
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ supplied[i];
  if (difference) return null;
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 86400) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user.id : null;
  } catch { return null; }
}
async function handleLibrary(req) {
  if (req.headers.get('Origin') && req.headers.get('Origin') !== WEB_ORIGIN) {
    return apiJson({ error: 'ORIGIN_DENIED' }, 403);
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return apiJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
  let body;
  try { body = await req.json(); } catch { return apiJson({ error: 'INVALID_JSON' }, 400); }
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim();
  const userId = await authenticateInitData(body?.initData, token);
  if (!userId) return apiJson({ error: 'TELEGRAM_AUTH_REQUIRED' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return apiJson({ error: 'SERVER_NOT_CONFIGURED' }, 503);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (body.action === 'collections') {
      const offset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
      const p = await db.from('music_playlists').select('id,name').eq('telegram_user_id', userId)
        .order('created_at').order('id').range(offset, offset + 99);
      const m = await db.from('music_playlist_tracks').select('playlist_id,track_id')
        .eq('telegram_user_id', userId).order('playlist_id').order('track_id').range(offset, offset + 99);
      if (p.error || m.error) throw new Error('collections');
      return apiJson({ playlists: p.data, memberships: m.data, hasMore: p.data.length === 100 || m.data.length === 100 });
    }
    if (body.action === 'playlist_create') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 60 || typeof body.clientKey !== 'string' || body.clientKey.length > 120 || !body.clientKey) {
        return apiJson({ error: 'INVALID_PLAYLIST' }, 400);
      }
      const result = await db.from('music_playlists').upsert({
        telegram_user_id: userId, client_key: body.clientKey, name,
      }, { onConflict: 'telegram_user_id,client_key' }).select('id,name').single();
      if (result.error) throw new Error('playlist_create');
      return apiJson({ playlist: result.data });
    }
    if (body.action === 'favorite' || body.action === 'membership') {
      if (typeof body.trackId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.trackId)) return apiJson({ error: 'INVALID_TRACK' }, 400);
      const track = await db.from('music_tracks').select('id').eq('telegram_user_id', userId).eq('id', body.trackId).maybeSingle();
      if (track.error) throw new Error('track_lookup');
      if (!track.data) return apiJson({ error: 'TRACK_NOT_FOUND' }, 404);
      if (body.action === 'favorite') {
        if (typeof body.favorite !== 'boolean') return apiJson({ error: 'INVALID_FAVORITE' }, 400);
        const result = await db.from('music_tracks').update({ favorite: body.favorite }).eq('telegram_user_id', userId).eq('id', body.trackId);
        if (result.error) throw new Error('favorite');
        return apiJson({ ok: true });
      }
      if (typeof body.playlistId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.playlistId) || typeof body.add !== 'boolean') {
        return apiJson({ error: 'INVALID_MEMBERSHIP' }, 400);
      }
      const playlist = await db.from('music_playlists').select('id').eq('telegram_user_id', userId).eq('id', body.playlistId).maybeSingle();
      if (playlist.error) throw new Error('playlist_lookup');
      if (!playlist.data) return apiJson({ error: 'PLAYLIST_NOT_FOUND' }, 404);
      const result = body.add
        ? await db.from('music_playlist_tracks').upsert({ telegram_user_id: userId, playlist_id: body.playlistId, track_id: body.trackId }, { onConflict: 'telegram_user_id,playlist_id,track_id' })
        : await db.from('music_playlist_tracks').delete().eq('telegram_user_id', userId).eq('playlist_id', body.playlistId).eq('track_id', body.trackId);
      if (result.error) throw new Error('membership');
      return apiJson({ ok: true });
    }

    if (body.action === 'list') {
      const offset = Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
      const { data, error } = await db.from('music_tracks')
        .select('id,title,artist,favorite,duration_seconds,created_at')
        .eq('telegram_user_id', userId).order('created_at', { ascending: false })
        .order('id', { ascending: false }).range(offset, offset + 99);
      if (error) throw new Error('list');
      return apiJson({ tracks: data, hasMore: data.length === 100 });
    }
    if (body.action === 'stream' && typeof body.trackId === 'string') {
      const { data, error } = await db.from('music_tracks').select('storage_path')
        .eq('telegram_user_id', userId).eq('id', body.trackId).maybeSingle();
      if (error) throw new Error('lookup');
      if (!data) return apiJson({ error: 'TRACK_NOT_FOUND' }, 404);
      const signed = await db.storage.from(BUCKET).createSignedUrl(data.storage_path, 3600);
      if (signed.error || !signed.data?.signedUrl) throw new Error('sign');
      return apiJson({ url: signed.data.signedUrl, expiresAt: Date.now() + 3500000 });
    }
    return apiJson({ error: 'UNKNOWN_ACTION' }, 400);
  } catch {
    console.error('MeloSpace library operation failed');
    return apiJson({ error: 'LIBRARY_UNAVAILABLE' }, 503);
  }
}

async function handleCatalog(req) {
  if (req.headers.get('Origin') && req.headers.get('Origin') !== WEB_ORIGIN) return apiJson({ error: 'ORIGIN_DENIED' }, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return apiJson({ error: 'METHOD_NOT_ALLOWED' }, 405);
  let body;
  try { body = await req.json(); } catch { return apiJson({ error: 'INVALID_JSON' }, 400); }
  const path = body?.path;
  if (typeof path !== 'string' || !/^\/tracks\/(trending|search|[A-Za-z0-9]{1,32})$/.test(path)) return apiJson({ error: 'INVALID_PATH' }, 400);
  const params = body.params || {};
  const query = typeof params.query === 'string' ? params.query.trim().slice(0, 200) : '';
  const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? Math.min(params.offset, 10000) : 0;
  const genres = ['Electronic','Hip-Hop/Rap','Pop','Rock','Ambient','House','Techno','Dubstep','Jazz','Classical'];
  const url = new URL('https://api.audius.co/v1' + path);
  url.searchParams.set('app_name', 'MeloSpace');url.searchParams.set('limit', '30');url.searchParams.set('offset', String(offset));
  if (query) url.searchParams.set('query', query);
  if (genres.includes(params.genre)) url.searchParams.set('genre', params.genre);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return apiJson({ error: response.status === 429 ? 'RATE_LIMIT' : 'AUDIUS_UPSTREAM_ERROR' }, response.status === 429 ? 429 : 502);
    const data = await response.json();
    if (!data || !('data' in data)) return apiJson({ error: 'AUDIUS_INVALID_RESPONSE' }, 502);
    return apiJson({ data: data.data });
  } catch { return apiJson({ error: 'AUDIUS_UPSTREAM_UNAVAILABLE' }, 502); }
}

async function handleSocial(req) {
 if(req.headers.get('Origin') && req.headers.get('Origin')!==WEB_ORIGIN)return apiJson({error:'ORIGIN_DENIED'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
 if(req.method!=='POST')return apiJson({error:'METHOD_NOT_ALLOWED'},405);
 let body;try{body=await req.json()}catch{return apiJson({error:'INVALID_JSON'},400)}
 const userId=await authenticateInitData(body?.initData,Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim());
 const readable=['feed','comments','stream'].includes(body?.action);
 if(!userId&&(!readable||body?.initData))return apiJson({error:'TELEGRAM_AUTH_REQUIRED'},401);
 const user=userId?JSON.parse(new URLSearchParams(body.initData).get('user')):{};
 const label=String(user.first_name||user.username||'Участник MeloSpace').trim().slice(0,60)||'Участник MeloSpace';
 const db=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
 const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
 try{
  if(body.action==='feed'){
   if(body.postId&&!uuid(body.postId))return apiJson({error:'INVALID_POST'},400);
   const offset=Number.isSafeInteger(body.offset)&&body.offset>=0?body.offset:0;
   const r=await db.rpc('melo_social_feed',{viewer:userId,page_offset:offset,selected_post:body.postId||null});if(r.error)throw Error('db');
   return apiJson({posts:r.data,hasMore:r.data.length===20});
  }
  if(body.action==='publish'){
   if(!uuid(body.trackId)||body.rightsConfirmed!==true||typeof body.caption!=='string'||body.caption.trim().length>280)return apiJson({error:'PUBLICATION_CONFIRMATION_REQUIRED'},400);
   const track=await db.from('music_tracks').select('id').eq('id',body.trackId).eq('telegram_user_id',userId).maybeSingle();if(track.error)throw Error('db');if(!track.data)return apiJson({error:'TRACK_NOT_FOUND'},404);
   const old=await db.from('music_posts').select('id,status').eq('track_id',body.trackId).eq('telegram_user_id',userId).maybeSingle();if(old.error)throw Error('db');
   if(old.data?.status==='hidden')return apiJson({error:'POST_MODERATED'},403);
   const record={track_id:body.trackId,telegram_user_id:userId,author_label:label,caption:body.caption.trim(),rights_confirmed:true,status:'published'};
   const result=old.data?await db.from('music_posts').update(record).eq('id',old.data.id).eq('telegram_user_id',userId).neq('status','hidden').select('id').single():await db.from('music_posts').insert(record).select('id').single();
   if(result.error)throw Error('publish');return apiJson({postId:result.data.id});
  }
  if(!uuid(body.postId))return apiJson({error:'INVALID_POST'},400);
  const p=await db.from('music_posts').select('id,track_id,telegram_user_id,status').eq('id',body.postId).maybeSingle();if(p.error)throw Error('db');
  if(!p.data||p.data.status!=='published')return apiJson({error:'POST_NOT_FOUND'},404);
  if(body.action==='withdraw'||body.action==='moderate'){
   const admin=String(userId)===Deno.env.get('MELO_ADMIN_USER_ID');
   if(body.action==='moderate'?!admin:p.data.telegram_user_id!==userId)return apiJson({error:'FORBIDDEN'},403);
   const r=await db.from('music_posts').update({status:body.action==='moderate'?'hidden':'withdrawn'}).eq('id',body.postId);if(r.error)throw Error('db');return apiJson({ok:true});
  }
  if(body.action==='stream'){
   const t=await db.from('music_tracks').select('storage_path').eq('id',p.data.track_id).maybeSingle();if(t.error||!t.data)throw Error('track');
   const r=await db.storage.from(BUCKET).createSignedUrl(t.data.storage_path,300);if(r.error)throw Error('sign');return apiJson({url:r.data.signedUrl,expiresAt:Date.now()+270000});
  }
  if(body.action==='like'||body.action==='repost'){
   if(typeof body.enabled!=='boolean')return apiJson({error:'INVALID_STATE'},400);
   const table=body.action==='like'?'music_post_likes':'music_post_reposts';
   const value={post_id:body.postId,telegram_user_id:userId,...(body.action==='repost'?{author_label:label}:{})};
   const r=body.enabled?await db.from(table).upsert(value,{onConflict:'post_id,telegram_user_id',ignoreDuplicates:true}):await db.from(table).delete().eq('post_id',body.postId).eq('telegram_user_id',userId);
   if(r.error)throw Error('db');return apiJson({ok:true});
  }
  if(body.action==='comments'){
   const offset=Number.isSafeInteger(body.offset)&&body.offset>=0?Math.min(body.offset,10000):0;
   const r=await db.from('music_post_comments').select('id,author_label,body,created_at,telegram_user_id').eq('post_id',body.postId).eq('deleted',false).order('created_at',{ascending:false}).order('id').range(offset,offset+19);
   if(r.error)throw Error('db');return apiJson({comments:r.data.map(({telegram_user_id,...c})=>({...c,mine:telegram_user_id===userId})),hasMore:r.data.length===20});
  }
  if(body.action==='comment'){
   const text=typeof body.text==='string'?body.text.trim():'';if(!text||text.length>500)return apiJson({error:'INVALID_COMMENT'},400);
   const recent=await db.from('music_post_comments').select('id').eq('telegram_user_id',userId).gte('created_at',new Date(Date.now()-10000).toISOString()).limit(1);
   if(recent.error)throw Error('db');if(recent.data.length)return apiJson({error:'COMMENT_TOO_FAST'},429);
   const r=await db.from('music_post_comments').insert({post_id:body.postId,telegram_user_id:userId,author_label:label,body:text});if(r.error)throw Error('db');return apiJson({ok:true});
  }
  if(body.action==='comment_delete'){
   if(!uuid(body.commentId))return apiJson({error:'INVALID_COMMENT'},400);
   const r=await db.from('music_post_comments').update({deleted:true}).eq('id',body.commentId).eq('post_id',body.postId).eq('telegram_user_id',userId).select('id');if(r.error)throw Error('db');if(!r.data.length)return apiJson({error:'FORBIDDEN'},403);return apiJson({ok:true});
  }
  if(body.action==='report'){
   const text=typeof body.reason==='string'?body.reason.trim():'';if(!text||text.length>500)return apiJson({error:'INVALID_REPORT'},400);
   const r=await db.from('music_post_reports').upsert({post_id:body.postId,telegram_user_id:userId,reason:text},{onConflict:'post_id,telegram_user_id'});if(r.error)throw Error('db');return apiJson({ok:true});
  }
  return apiJson({error:'UNKNOWN_ACTION'},400);
 }catch{console.error('MeloSpace social operation failed');return apiJson({error:'SOCIAL_UNAVAILABLE'},503)}
}

const ENGLISH_PREMIUM=[
{id:'travel-airport',name:'В аэропорту',tip:'Boarding pass — посадочный талон. Gate — выход на посадку. I would like… — вежливая просьба.',phrases:[['Where is the check-in desk?','Где стойка регистрации?','Check-in desk — стойка регистрации.'],['Here is my passport.','Вот мой паспорт.','Here is… — «Вот…».'],['I have one bag.','У меня одна сумка.','One bag — одна сумка.'],['Where is gate twelve?','Где двенадцатый выход на посадку?','Gate — выход на посадку, twelve — двенадцать.'],['What time is boarding?','Во сколько посадка?','What time…? — «В какое время…?».'],['My flight is delayed.','Мой рейс задерживается.','Delayed — задержан.']]},
{id:'travel-hotel',name:'Заселяемся в отель',tip:'I have a reservation — у меня есть бронь. Could I…? — вежливая просьба.',phrases:[['I have a reservation.','У меня есть бронь.','Reservation — бронь.'],['My name is Anna.','Меня зовут Анна.','Так можно назвать имя, на которое оформлена бронь.'],['Could I check in, please?','Можно заселиться, пожалуйста?','Check in — зарегистрироваться при заселении.'],['Is breakfast included?','Завтрак включён?','Included — включён в стоимость.'],['What is the Wi-Fi password?','Какой пароль от Wi-Fi?','Password — пароль.'],['Could I have another towel?','Можно ещё одно полотенце?','Another — ещё один.']]},
{id:'travel-cafe',name:'Кофе и что-нибудь вкусное',tip:'I would like… — я бы хотел. Could we have…? — можно нам…?',phrases:[['A table for two, please.','Столик на двоих, пожалуйста.','A table for two — столик для двух человек.'],['Could we see the menu?','Можно посмотреть меню?','Could we…? — вежливый вопрос.'],['I would like a coffee.','Я бы хотел чашку кофе.','A coffee означает порцию кофе.'],['Does this contain nuts?','Здесь есть орехи?','Contain — содержать. При аллергии уточняй состав у персонала.'],['Could we have the bill?','Можно нам счёт?','Bill — счёт в ресторане.'],['The food is delicious.','Еда очень вкусная.','Delicious — очень вкусный.']]},
{id:'travel-transport',name:'Поезд, автобус и такси',tip:'A single ticket — билет в одну сторону. A return ticket — билет туда и обратно.',phrases:[['A single ticket, please.','Билет в одну сторону, пожалуйста.','Single — в одну сторону.'],['Which platform do I need?','Какая платформа мне нужна?','Which — какой из вариантов.'],['Does this bus go to the centre?','Этот автобус едет в центр?','Вопрос Present Simple: does + основная форма go.'],['How long does it take?','Сколько времени это занимает?','How long — вопрос о длительности.'],['Please stop here.','Остановитесь здесь, пожалуйста.','Stop here — остановитесь здесь.'],['Is this seat free?','Это место свободно?','Seat — место для сидения.']]},
{id:'travel-shop',name:'Покупки в поездке',tip:'Try on — примерить одежду. Receipt — кассовый чек.',phrases:[['Can I try this on?','Можно это примерить?','Try this on — примерить это.'],['Do you have a larger size?','У вас есть размер побольше?','Larger — больше.'],['I am looking for a gift.','Я ищу подарок.','Look for — искать.'],['Can I have a receipt?','Можно чек?','Receipt — чек, буква p не произносится.'],['I will take this one.','Я возьму вот это.','Will здесь выражает решение в момент речи.'],['Where is the fitting room?','Где примерочная?','Fitting room — примерочная.']]},
{id:'travel-help',name:'Когда нужна помощь',tip:'Could you…? — вежливая просьба. I need… — мне нужно.',phrases:[['Could you help me?','Не могли бы вы мне помочь?','Could you…? — вежливая форма просьбы.'],['I am lost.','Я заблудился.','Lost — потерявшийся.'],['Could you speak more slowly?','Не могли бы вы говорить медленнее?','More slowly — медленнее.'],['Please write it down.','Запишите это, пожалуйста.','Write down — записать.'],['I need a doctor.','Мне нужен врач.','Doctor — врач.'],['Where is the nearest pharmacy?','Где ближайшая аптека?','Nearest — ближайший, pharmacy — аптека.']]}
];

const ENGLISH_FREE_IDS=['hello','people','things','questions','family','food','routine','negative','city','shopping','now','plans'];
const ENGLISH_ALL_IDS=[...ENGLISH_FREE_IDS,...ENGLISH_PREMIUM.map(l=>l.id)];
function englishDb(){return createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})}
async function englishTelegram(method,body){const token=Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim();const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)});const data=await response.json();if(!response.ok||!data.ok)throw Error('TELEGRAM_ERROR');return data.result}
function cleanEnglishProgress(raw){const p=raw&&typeof raw==='object'?raw:{};const completed={},attempts={},daily={},mistakes={};for(const[id,value]of Object.entries(p.completed||{})){if(ENGLISH_ALL_IDS.includes(id)&&value&&Number(value.accuracy)>=60)completed[id]={accuracy:Math.min(100,Math.max(60,Math.round(Number(value.accuracy)))),date:typeof value.date==='string'?value.date.slice(0,10):''}}for(const[id,value]of Object.entries(p.attempts||{}))if(ENGLISH_ALL_IDS.includes(id))attempts[id]=Math.max(0,Math.min(10000,Math.round(Number(value)||0)));for(const[day,value]of Object.entries(p.daily||{}).slice(-5000))if(/^\d{4}-\d{2}-\d{2}$/.test(day))daily[day]=Math.max(0,Math.min(1000,Math.round(Number(value)||0)));const validWord=id=>typeof id==='string'&&ENGLISH_ALL_IDS.includes(id.split(':')[0])&&/:[0-5]$/.test(id);for(const[id,value]of Object.entries(p.mistakes||{}))if(validWord(id))mistakes[id]={wordId:id,count:Math.min(1000,Math.max(1,Number(value?.count)||1)),correctRun:Math.min(1,Math.max(0,Number(value?.correctRun)||0))};return{version:1,completed,attempts,daily,mistakes,seen:[...new Set((Array.isArray(p.seen)?p.seen:[]).filter(validWord))],dates:[...new Set((Array.isArray(p.dates)?p.dates:[]).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].slice(-5000),goal:[20,40,60].includes(p.goal)?p.goal:20,onboarded:!!p.onboarded,hearts:Math.min(5,Math.max(0,Number(p.hearts)||0)),heartAt:Math.min(Date.now(),Number(p.heartAt)||Date.now()),speech:p.speech!==false,sound:p.sound!==false,updatedAt:Math.min(Date.now(),Number(p.updatedAt)||0)}}
function mergeEnglish(a,b){const result={...a,completed:{...a.completed},daily:{...a.daily},attempts:{...a.attempts}};for(const[id,value]of Object.entries(b.completed))if(!result.completed[id]||result.completed[id].accuracy<value.accuracy)result.completed[id]=value;for(const[day,value]of Object.entries(b.daily))result.daily[day]=Math.max(result.daily[day]||0,value);for(const[id,value]of Object.entries(b.attempts))result.attempts[id]=Math.max(result.attempts[id]||0,value);result.seen=[...new Set([...a.seen,...b.seen])];result.dates=[...new Set([...a.dates,...b.dates])].sort();if(b.updatedAt>a.updatedAt)for(const key of ['mistakes','goal','hearts','heartAt','speech','sound','onboarded','updatedAt'])result[key]=b[key];return result}
async function englishAccess(db,userId){const r=await db.from('english_unlocks').select('pack_id').eq('telegram_user_id',userId).eq('pack_id','travel').maybeSingle();if(r.error)throw Error('DATABASE_NOT_READY');return !!r.data}
async function handleEnglish(req){
 if(req.headers.get('Origin')&&req.headers.get('Origin')!==WEB_ORIGIN)return apiJson({error:'ORIGIN_DENIED'},403);
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});if(req.method!=='POST')return apiJson({error:'METHOD_NOT_ALLOWED'},405);
 let body;try{body=await req.json()}catch{return apiJson({error:'INVALID_JSON'},400)}
 const userId=await authenticateInitData(body?.initData,Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim());if(!userId)return apiJson({error:'TELEGRAM_AUTH_REQUIRED'},401);
 try{const db=englishDb();
 if(body.action==='sync'){
  const saved=await db.rpc('melo_english_sync',{buyer:userId,incoming:cleanEnglishProgress(body.progress)});if(saved.error||!saved.data)throw Error('db');
  const progress=saved.data;
  const unlocked=await englishAccess(db,userId);let ready=false;
  if(Deno.env.get('MELO_ENGLISH_SALES_ENABLED')==='true'&&Deno.env.get('MELO_SUPPORT_CONTACT')){try{const info=await englishTelegram('getWebhookInfo',{});ready=!!info.allowed_updates?.includes('pre_checkout_query')}catch{}}
  return apiJson({progress,shop:{ready,unlocked,isAdmin:String(userId)===Deno.env.get('MELO_ADMIN_USER_ID'),words:unlocked?ENGLISH_PREMIUM.flatMap(l=>l.phrases.map((p,i)=>({id:l.id+':'+i,lessonId:l.id,en:p[0],ru:p[1],explanation:p[2]}))).filter(w=>progress.seen.includes(w.id)):[],support:Deno.env.get('MELO_SUPPORT_CONTACT')||'',lessons:unlocked?ENGLISH_PREMIUM.map(l=>({id:l.id,name:l.name})):[]}});
 }
 if(body.action==='lesson'){
  const lesson=ENGLISH_PREMIUM.find(l=>l.id===body.lessonId);if(!lesson)return apiJson({error:'LESSON_NOT_FOUND'},404);if(!await englishAccess(db,userId))return apiJson({error:'PURCHASE_REQUIRED'},403);return apiJson({lesson});
 }
 if(body.action==='invoice'){
  if(body.packId!=='travel'||Deno.env.get('MELO_ENGLISH_SALES_ENABLED')!=='true'||!Deno.env.get('MELO_SUPPORT_CONTACT'))return apiJson({error:'SALES_DISABLED'},409);
  const info=await englishTelegram('getWebhookInfo',{});if(!info.allowed_updates?.includes('pre_checkout_query'))return apiJson({error:'PAYMENTS_NOT_CONFIGURED'},409);
  if(await englishAccess(db,userId))return apiJson({error:'ALREADY_PURCHASED'},409);
  const order=await db.from('english_orders').insert({telegram_user_id:userId,pack_id:'travel',amount:199}).select('id').single();if(order.error)throw Error('db');
  const link=await englishTelegram('createInvoiceLink',{title:'Melo English: В поездке — как дома',description:'6 уроков A1–A2, 36 фраз с заданиями. Разовая покупка, доступ без срока действия. Поддержка: '+Deno.env.get('MELO_SUPPORT_CONTACT'),payload:'meloeng:'+order.data.id,currency:'XTR',provider_token:'',prices:[{label:'Набор «В поездке — как дома»',amount:199}]});return apiJson({url:link});
 }
 if(body.action==='setup_webhook'){
  if(String(userId)!==Deno.env.get('MELO_ADMIN_USER_ID'))return apiJson({error:'FORBIDDEN'},403);
  const secret=Deno.env.get('TELEGRAM_WEBHOOK_SECRET');if(!secret)throw Error('config');
  await englishTelegram('setWebhook',{url:Deno.env.get('SUPABASE_URL')+'/functions/v1/melospace-api',secret_token:secret,allowed_updates:['message','pre_checkout_query']});return apiJson({ok:true});
 }
 return apiJson({error:'UNKNOWN_ACTION'},400);
 }catch{return apiJson({error:'ENGLISH_UNAVAILABLE'},503)}
}
async function englishWebhook(update){
 const pre=update.pre_checkout_query;
 if(pre?.invoice_payload?.startsWith('meloeng:')){
  try{const id=pre.invoice_payload.slice(8);if(!/^[0-9a-f-]{36}$/i.test(id))throw Error();const db=englishDb();const r=await db.from('english_orders').select('id,telegram_user_id,amount,status').eq('id',id).maybeSingle();const valid=!r.error&&r.data&&r.data.status==='pending'&&r.data.telegram_user_id===pre.from.id&&pre.currency==='XTR'&&pre.total_amount===r.data.amount&&!await englishAccess(db,pre.from.id)&&Deno.env.get('MELO_ENGLISH_SALES_ENABLED')==='true';return Response.json({method:'answerPreCheckoutQuery',pre_checkout_query_id:pre.id,ok:!!valid,...(!valid?{error_message:'Покупка недоступна или набор уже открыт. Stars не списаны.'}:{})})}catch{return Response.json({method:'answerPreCheckoutQuery',pre_checkout_query_id:pre.id,ok:false,error_message:'Не удалось проверить заказ. Попробуй позже.'})}
 }
 const m=update.message,payment=m?.successful_payment,refund=m?.refunded_payment;
 if(payment?.invoice_payload?.startsWith('meloeng:')){
  if(m.chat?.type!=='private'||m.chat.id!==m.from?.id||payment.currency!=='XTR'||payment.total_amount!==199)return new Response('Invalid payment',{status:400});
  const id=payment.invoice_payload.slice(8);if(!/^[0-9a-f-]{36}$/i.test(id))return new Response('Invalid order',{status:400});
  try{const r=await englishDb().rpc('melo_english_fulfill',{order_uuid:id,buyer:m.from.id,charge:payment.telegram_payment_charge_id,stars:payment.total_amount});if(r.error||!r.data)throw Error();return reply(m.chat.id,'Спасибо! Набор «В поездке — как дома» открыт ✓\nВернись в Melo English → Новые истории → Обновить покупки.\nНомер заказа: '+id)}catch{return new Response('Payment processing pending',{status:503})}
 }
 if(refund?.invoice_payload?.startsWith('meloeng:')){try{const r=await englishDb().rpc('melo_english_refund',{charge:refund.telegram_payment_charge_id});if(r.error)throw Error();return Response.json({ok:true})}catch{return new Response('Refund processing pending',{status:503})}}
 if(m?.chat?.type==='private'&&/^\/paysupport(?:@\w+)?(?:\s|$)/.test(m.text||''))return reply(m.chat.id,'Поддержка покупок Melo English: '+(Deno.env.get('MELO_SUPPORT_CONTACT')||'контакт владельца ещё не настроен. Продажи отключены.')+'\nУкажи номер заказа из подтверждения оплаты. Токены, пароли и банковские данные не отправляй.');
 if(m?.chat?.type==='private'&&/^\/refund\s+[0-9a-f-]{36}$/i.test(m.text||'')){
  if(String(m.from?.id)!==Deno.env.get('MELO_ADMIN_USER_ID'))return reply(m.chat.id,'Команда доступна только администратору.');
  try{const id=m.text.split(/\s+/)[1],db=englishDb();const r=await db.from('english_orders').select('telegram_user_id,charge_id,status').eq('id',id).maybeSingle();if(r.error||!r.data||r.data.status!=='paid')return reply(m.chat.id,'Оплаченный заказ не найден.');await englishTelegram('refundStarPayment',{user_id:r.data.telegram_user_id,telegram_payment_charge_id:r.data.charge_id});const saved=await db.rpc('melo_english_refund',{charge:r.data.charge_id});if(saved.error)throw Error();return reply(m.chat.id,'Возврат выполнен. Доступ по этому заказу закрыт.')}catch{return reply(m.chat.id,'Возврат не подтверждён. Проверь журнал Stars и статус заказа перед повтором.')}
 }
 return null;
}

async function handleRequest(req) {
  if (new URL(req.url).pathname.endsWith("/english")) return handleEnglish(req);
  if (new URL(req.url).pathname.endsWith("/social")) return handleSocial(req);
  if (new URL(req.url).pathname.endsWith("/catalog")) return handleCatalog(req);
  if (new URL(req.url).pathname.endsWith("/library")) return handleLibrary(req);
  if (req.method === 'GET') {
    return Response.json({ service: 'MeloSpace', status: 'ok', version: 8 });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!secret) return new Response('Missing webhook configuration', { status: 503 });
  if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update;
  try { update = await req.json(); }
  catch { return new Response('Invalid JSON', { status: 400 }); }
  const learningResponse = await englishWebhook(update);
  if (learningResponse) return learningResponse;
  const message = update?.message;
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot) {
    return Response.json({ ok: true });
  }
  const userId = message.from?.id;
  const chatId = message.chat.id;
  if (!Number.isSafeInteger(userId) || userId <= 0 || chatId !== userId) {
    return Response.json({ ok: true });
  }

  const file = message.audio || message.document;
  if (!file) {
    return reply(chatId, 'Привет! Это MeloSpace 🎵\nОтправь аудиофайл MP3, M4A, WAV, OGG или FLAC размером до 20 МБ. Сохраню его в твою серверную медиатеку.');
  }
  const extension = (file.file_name || '').split('.').pop()?.toLowerCase();
  const recognizedAudio = !!message.audio || file.mime_type?.startsWith('audio/');
  if (!recognizedAudio && !FORMATS[extension]) {
    return reply(chatId, 'Это не похоже на аудиофайл. Отправь MP3, M4A, WAV, OGG или FLAC.');
  }
  if (!file.file_id || !file.file_unique_id) {
    return reply(chatId, 'Не удалось прочитать данные файла. Отправь его ещё раз.');
  }
  if (file.file_size > MAX_BYTES) {
    return reply(chatId, 'Файл больше 20 МБ. Для этой версии выбери файл поменьше.');
  }

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')?.trim();
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!token || !url || !key) {
    return reply(chatId, 'Сервер ещё не настроен: проверь секреты функции.');
  }
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = db.storage.from(BUCKET);
  let uploadedPath = null;
  let stage = "DB_READ";
  let detail = "";
  try {
    const { data: existing, error: lookupError } = await db.from('music_tracks')
      .select('id').eq('telegram_user_id', userId)
      .eq('telegram_file_unique_id', file.file_unique_id).maybeSingle();
    if (lookupError) { detail = String(lookupError.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30); throw new Error('database'); }
    if (existing) return reply(chatId, 'Этот трек уже есть в твоей медиатеке ✓');

    stage = "TG_FILE";
    const metadataResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: file.file_id }),
      signal: AbortSignal.timeout(20_000),
    });
    const metadata = await metadataResponse.json();
    if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
      detail = String(metadata.error_code || metadataResponse.status);
      throw new Error('telegram');
    }
    if (metadata.result.file_size > MAX_BYTES) throw new Error('size');
    stage = "TG_DOWNLOAD";
    const response = await fetch(
      `https://api.telegram.org/file/bot${token}/${metadata.result.file_path}`,
      { signal: AbortSignal.timeout(40_000) },
    );
    detail = response.ok ? "" : String(response.status);
    const blob = await readAudio(response);
    const mime = FORMATS[extension] ||
      (file.mime_type?.startsWith('audio/') ? file.mime_type : 'audio/mpeg');
    const path = `${userId}/${crypto.randomUUID()}.${FORMATS[extension] ? extension : 'bin'}`;
    stage = "STORAGE_UPLOAD";
    const { error: uploadError } = await storage.upload(path, blob, {
      contentType: mime, upsert: false,
    });
    if (uploadError) { detail = String(uploadError.statusCode || uploadError.status || '').replace(/[^0-9]/g, '').slice(0, 3); throw new Error('storage'); }
    uploadedPath = path;

    const title = String(file.title || file.file_name || 'Без названия')
      .replace(/\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|aiff)$/i, '').slice(0, 300);
    stage = "DB_INSERT";
    const { error: insertError } = await db.from('music_tracks').insert({
      telegram_user_id: userId,
      telegram_file_unique_id: file.file_unique_id,
      title, artist: String(file.performer || 'Моя музыка').slice(0, 200),
      storage_path: path, mime_type: mime, size_bytes: blob.size,
      duration_seconds: Number.isInteger(file.duration) ? file.duration : null,
    });
    if (insertError) {
      detail = String(insertError.code || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);
      const { error: cleanupError } = await storage.remove([path]);
      if (cleanupError) console.error('MeloSpace: orphan cleanup failed');
      uploadedPath = null;
      if (insertError.code === '23505') {
        return reply(chatId, 'Этот трек уже сохранён ✓');
      }
      throw new Error('database');
    }
    uploadedPath = null;
    return reply(chatId, `Сохранено: ${title} ✓\nФайл добавлен в серверную медиатеку. Открой MeloSpace и нажми «Обновить» в медиатеке.`);
  } catch (error) {
    // Never log exception objects: network errors can include the bot token in a URL.
    if (uploadedPath) {
      try { await storage.remove([uploadedPath]); } catch { /* Retry manually if needed. */ }
    }
    console.error('MeloSpace import failed:', stage, detail);
    const hints = {
      DB_READ: 'Проверь таблицу public.music_tracks и серверный ключ Supabase.',
      TG_FILE: 'Проверь TELEGRAM_BOT_TOKEN: это должен быть токен текущего бота.',
      TG_DOWNLOAD: 'Не удалось скачать файл из Telegram. Попробуй другой небольшой MP3.',
      STORAGE_UPLOAD: 'Проверь, создан ли bucket melospace-audio, и разрешены ли в нём аудиофайлы нужного размера.',
      DB_INSERT: 'Файл скачан, но запись в music_tracks не создана. Проверь структуру таблицы.',
    };
    return reply(chatId, error instanceof Error && error.message === 'size'
      ? 'Файл превышает лимит 20 МБ. Отправь файл поменьше.'
      : `Не удалось сохранить трек. Код: ${stage}${detail ? ' (' + detail + ')' : ''}.\n${hints[stage]}\nПосле исправления отправь файл повторно.`);
  }
}

Deno.serve(handleRequest);
