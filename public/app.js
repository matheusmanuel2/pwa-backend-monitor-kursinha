const API_URL = 'https://api.kursinha.com/';
const CHECK_INTERVAL_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;
const FAILURE_THRESHOLD = 2;
const MANUAL_CHECK_COOLDOWN_MS = 10000;

const $ = (selector) => document.querySelector(selector);

const elements = {
  pill: $('#connection-pill'),
  dot: $('#status-dot'),
  title: $('#status-title'),
  message: $('#status-message'),
  responseTime: $('#response-time'),
  consecutiveFailures: $('#consecutive-failures'),
  lastCheck: $('#last-check'),
  monitoredUrl: $('#monitored-url'),
  notificationState: $('#notification-state'),
  enableButton: $('#enable-notifications'),
  testButton: $('#test-notification'),
  checkButton: $('#check-now'),
  toast: $('#toast')
};

let status = 'unknown';
let consecutiveFailures = 0;
let lastCheckAt = null;
let lastResponseTimeMs = null;
let lastManualCheckAt = 0;
let toastTimer = null;
let checkTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 3500);
}


function formatDate(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'kursinha-status', icon: '/icons/icon-192.png' });
  } catch (error) {
    console.error('Falha ao exibir notificação:', error);
  }
}

function render() {
  const isUp = status === 'up';
  const isDown = status === 'down';

  elements.dot.className = `status-dot ${status}`;
  elements.pill.className = `pill ${isUp ? 'up' : isDown ? 'down' : 'neutral'}`;
  elements.pill.textContent = isUp ? 'Online' : isDown ? 'Fora do ar' : 'Verificando';
  elements.title.textContent = isUp ? 'API online' : isDown ? 'API fora do ar' : 'Verificando…';
  elements.message.textContent = isDown
    ? 'A API não respondeu (timeout, DNS ou conexão recusada).'
    : isUp
      ? `Última checagem alcançou a API em ${lastResponseTimeMs ?? '—'} ms.`
      : 'Aguardando checagens suficientes para definir o estado.';

  elements.responseTime.textContent = lastResponseTimeMs == null ? '—' : `${lastResponseTimeMs} ms`;
  elements.consecutiveFailures.textContent = consecutiveFailures;
  elements.lastCheck.textContent = formatDate(lastCheckAt);
  elements.monitoredUrl.textContent = API_URL;
}

async function performCheck() {
  const startedAt = Date.now();
  let reachable = false;

  try {
    await fetch(API_URL, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    reachable = true;
  } catch (error) {
    reachable = false;
  }

  lastResponseTimeMs = Date.now() - startedAt;
  lastCheckAt = new Date();

  const previousStatus = status;

  if (reachable) {
    consecutiveFailures = 0;
    status = 'up';
    if (previousStatus === 'down') notify('API Kursinha voltou', `Respondendo novamente (${lastResponseTimeMs} ms).`);
  } else {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      if (previousStatus !== 'down') notify('API Kursinha caiu', 'Sem resposta ao tentar acessar a API.');
      status = 'down';
    } else if (previousStatus === 'unknown') {
      status = 'checking';
    }
  }

  render();
}

async function updateNotificationState() {
  const supported = 'Notification' in window;
  const granted = supported && Notification.permission === 'granted';
  elements.notificationState.textContent = !supported
    ? 'Notificações não suportadas neste navegador'
    : granted
      ? 'Notificações ativas'
      : 'Notificações desativadas';
  elements.enableButton.textContent = granted ? 'Notificações ativadas' : 'Ativar notificações';
  elements.enableButton.disabled = !supported || granted;
  elements.testButton.disabled = !granted;
}

async function enableNotifications() {
  if (!('Notification' in window)) throw new Error('Este navegador não suporta notificações.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão de notificação não concedida.');
  await updateNotificationState();
  showToast('Notificações ativadas neste navegador.');
}

function testNotification() {
  notify('Teste do monitor', 'As notificações estão funcionando neste navegador.');
  showToast('Notificação de teste enviada.');
}

async function checkNow() {
  const now = Date.now();
  if (now - lastManualCheckAt < MANUAL_CHECK_COOLDOWN_MS) {
    showToast('Aguarde alguns segundos antes de testar novamente.');
    return;
  }
  lastManualCheckAt = now;

  elements.checkButton.disabled = true;
  elements.checkButton.textContent = 'Verificando…';
  try {
    await performCheck();
    showToast('Verificação concluída.');
  } finally {
    elements.checkButton.disabled = false;
    elements.checkButton.textContent = 'Verificar agora';
  }
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Não foi possível concluir a ação.');
  }
}

function init() {
  render();
  updateNotificationState();
  runAction(performCheck);
  checkTimer = setInterval(() => runAction(performCheck), CHECK_INTERVAL_MS);
}

elements.enableButton.addEventListener('click', () => runAction(enableNotifications));
elements.testButton.addEventListener('click', () => runAction(testNotification));
elements.checkButton.addEventListener('click', () => runAction(checkNow));

window.addEventListener('beforeunload', () => clearInterval(checkTimer));

init();
