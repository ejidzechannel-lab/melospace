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

async function handleRequest(req) {
  if (new URL(req.url).pathname.endsWith("/social")) return handleSocial(req);
  if (new URL(req.url).pathname.endsWith("/catalog")) return handleCatalog(req);
  if (new URL(req.url).pathname.endsWith("/library")) return handleLibrary(req);
  if (req.method === 'GET') {
    return Response.json({ service: 'MeloSpace', status: 'ok', version: 7 });
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
