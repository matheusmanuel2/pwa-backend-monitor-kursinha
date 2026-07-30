import express from 'express';
import helmet from 'helmet';
import webpush from 'web-push';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const API_URL = process.env.API_URL || 'https://api.kursinha.com/';
const CHECK_INTERVAL_MS = Math.max(Number(process.env.CHECK_INTERVAL_MS || 60000), 30000);
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.REQUEST_TIMEOUT_MS || 10000), 1000);
const FAILURE_THRESHOLD = Math.max(Number(process.env.FAILURE_THRESHOLD || 2), 1);
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:monitor@example.com';

const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

const app = express();
let checkInProgress = false;
let lastManualCheckAt = 0;

const defaultState = {
  status: 'unknown',
  consecutiveFailures: 0,
  lastCheckAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  responseTimeMs: null,
  statusCode: null,
  error: null,
  checkedUrl: API_URL
};

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(SUBSCRIPTIONS_FILE)) await writeJson(SUBSCRIPTIONS_FILE, []);
  if (!existsSync(STATE_FILE)) await writeJson(STATE_FILE, defaultState);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    console.error(`Falha ao ler ${file}:`, error.message);
    return fallback;
  }
}

async function writeJson(file, value) {
  const tempFile = `${file}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempFile, file);
}

async function loadVapidKeys() {
  const envPublic = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;

  if (envPublic && envPrivate) {
    return { publicKey: envPublic, privateKey: envPrivate };
  }

  const stored = await readJson(VAPID_FILE, null);
  if (stored?.publicKey && stored?.privateKey) return stored;

  const generated = webpush.generateVAPIDKeys();
  await writeJson(VAPID_FILE, generated);
  console.log(`Chaves VAPID geradas e salvas em ${VAPID_FILE}. Preserve o diretório data em produção.`);
  return generated;
}

function isValidSubscription(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === 'string' &&
    subscription.endpoint.startsWith('https://') &&
    subscription.keys &&
    typeof subscription.keys.p256dh === 'string' &&
    typeof subscription.keys.auth === 'string'
  );
}

async function getSubscriptions() {
  const subscriptions = await readJson(SUBSCRIPTIONS_FILE, []);
  return Array.isArray(subscriptions) ? subscriptions : [];
}

async function saveSubscription(subscription) {
  const subscriptions = await getSubscriptions();
  const existingIndex = subscriptions.findIndex((item) => item.endpoint === subscription.endpoint);
  const record = { ...subscription, updatedAt: new Date().toISOString() };

  if (existingIndex >= 0) subscriptions[existingIndex] = record;
  else subscriptions.push(record);

  await writeJson(SUBSCRIPTIONS_FILE, subscriptions);
}

async function removeSubscription(endpoint) {
  const subscriptions = await getSubscriptions();
  const filtered = subscriptions.filter((item) => item.endpoint !== endpoint);
  await writeJson(SUBSCRIPTIONS_FILE, filtered);
  return filtered.length !== subscriptions.length;
}

async function sendPushToSubscription(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 3600,
      urgency: 'high'
    });
    return true;
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await removeSubscription(subscription.endpoint);
      console.log('Inscrição expirada removida.');
      return false;
    }
    console.error('Erro ao enviar push:', error.statusCode || '', error.message);
    return false;
  }
}

async function broadcast(payload) {
  const subscriptions = await getSubscriptions();
  if (!subscriptions.length) {
    console.log('Nenhum dispositivo inscrito para receber o alerta.');
    return;
  }
  await Promise.allSettled(subscriptions.map((subscription) => sendPushToSubscription(subscription, payload)));
}

function notificationPayload(kind, state) {
  if (kind === 'down') {
    return {
      title: 'API Kursinha caiu',
      body: state.error || `Falha HTTP ${state.statusCode || 'sem resposta'}`,
      tag: 'kursinha-api-status',
      url: '/',
      status: 'down',
      timestamp: Date.now()
    };
  }

  if (kind === 'recovered') {
    return {
      title: 'API Kursinha voltou',
      body: `Respondendo em ${state.responseTimeMs} ms`,
      tag: 'kursinha-api-status',
      url: '/',
      status: 'up',
      timestamp: Date.now()
    };
  }

  return {
    title: 'Teste do monitor',
    body: 'As notificações estão funcionando neste dispositivo.',
    tag: `kursinha-test-${Date.now()}`,
    url: '/',
    status: 'test',
    timestamp: Date.now()
  };
}

async function performCheck() {
  if (checkInProgress) return readJson(STATE_FILE, defaultState);
  checkInProgress = true;

  try {
  const previous = await readJson(STATE_FILE, defaultState);
  const startedAt = Date.now();
  let success = false;
  let statusCode = null;
  let errorMessage = null;

  try {
    const response = await fetch(API_URL, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'user-agent': 'Kursinha-API-Monitor/1.0'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    statusCode = response.status;
    success = response.ok;
    if (!success) errorMessage = `A API respondeu com HTTP ${response.status}`;
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    errorMessage = error.name === 'TimeoutError'
      ? `Tempo limite excedido (${REQUEST_TIMEOUT_MS} ms)`
      : error.message;
  }

  const now = new Date().toISOString();
  const responseTimeMs = Date.now() - startedAt;
  const next = {
    ...previous,
    lastCheckAt: now,
    responseTimeMs,
    statusCode,
    checkedUrl: API_URL
  };

  let event = null;

  if (success) {
    next.consecutiveFailures = 0;
    next.lastSuccessAt = now;
    next.error = null;
    if (previous.status === 'down') event = 'recovered';
    next.status = 'up';
  } else {
    next.consecutiveFailures = Number(previous.consecutiveFailures || 0) + 1;
    next.lastFailureAt = now;
    next.error = errorMessage || 'Falha desconhecida';

    if (next.consecutiveFailures >= FAILURE_THRESHOLD) {
      if (previous.status !== 'down') event = 'down';
      next.status = 'down';
    } else if (previous.status === 'unknown') {
      next.status = 'checking';
    }
  }

  await writeJson(STATE_FILE, next);

  const logLine = `[${now}] ${next.status.toUpperCase()} ${statusCode || '-'} ${responseTimeMs}ms${errorMessage ? ` - ${errorMessage}` : ''}`;
  console.log(logLine);

  if (event) await broadcast(notificationPayload(event, next));
  return next;
  } finally {
    checkInProgress = false;
  }
}

function requireAccess(req, res, next) {
  if (!ACCESS_TOKEN) return next();
  const token = req.get('x-monitor-token') || req.query.token;
  if (token === ACCESS_TOKEN) return next();
  return res.status(401).json({ error: 'Token de acesso inválido.' });
}

await ensureDataFiles();
const vapidKeys = await loadVapidKeys();
webpush.setVapidDetails(VAPID_SUBJECT, vapidKeys.publicKey, vapidKeys.privateKey);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: null,
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/api/config', requireAccess, (_req, res) => {
  res.json({
    apiUrl: API_URL,
    checkIntervalMs: CHECK_INTERVAL_MS,
    failureThreshold: FAILURE_THRESHOLD,
    vapidPublicKey: vapidKeys.publicKey,
    accessProtected: Boolean(ACCESS_TOKEN)
  });
});

app.get('/api/status', requireAccess, async (_req, res) => {
  const state = await readJson(STATE_FILE, defaultState);
  const subscriptions = await getSubscriptions();
  res.set('Cache-Control', 'no-store');
  res.json({ ...state, subscriberCount: subscriptions.length });
});

app.post('/api/subscribe', requireAccess, async (req, res) => {
  if (!isValidSubscription(req.body)) {
    return res.status(400).json({ error: 'Inscrição Web Push inválida.' });
  }
  await saveSubscription(req.body);
  return res.status(201).json({ ok: true });
});

app.post('/api/unsubscribe', requireAccess, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Endpoint inválido.' });
  const removed = await removeSubscription(endpoint);
  return res.json({ ok: true, removed });
});

app.post('/api/test-notification', requireAccess, async (req, res) => {
  const subscription = req.body;
  if (!isValidSubscription(subscription)) {
    return res.status(400).json({ error: 'Inscrição Web Push inválida.' });
  }

  const stored = (await getSubscriptions()).some((item) => item.endpoint === subscription.endpoint);
  if (!stored) return res.status(403).json({ error: 'Este dispositivo ainda não está inscrito.' });

  const sent = await sendPushToSubscription(subscription, notificationPayload('test', {}));
  return res.status(sent ? 200 : 502).json({ ok: sent });
});

app.post('/api/check-now', requireAccess, async (_req, res) => {
  const now = Date.now();
  if (now - lastManualCheckAt < 10000) {
    return res.status(429).json({ error: 'Aguarde 10 segundos antes de testar novamente.' });
  }
  lastManualCheckAt = now;
  const state = await performCheck();
  return res.json(state);
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Erro interno do monitor.' });
});

app.listen(PORT, () => {
  console.log(`Monitor disponível na porta ${PORT}`);
  console.log(`Verificando ${API_URL} a cada ${CHECK_INTERVAL_MS / 1000}s`);
  performCheck().catch(console.error);
  setInterval(() => performCheck().catch(console.error), CHECK_INTERVAL_MS).unref();
});
