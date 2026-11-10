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

async function handleRequest(req) {
  if (req.method === 'GET') {
    return Response.json({ service: 'MeloSpace', status: 'ok', version: 3 });
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

  const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
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
    return reply(chatId, `Сохранено: ${title} ✓\nФайл добавлен в серверную медиатеку. Её отображение в Mini App подключим следующим шагом.`);
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
