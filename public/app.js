const $ = (selector) => document.querySelector(selector);

const elements = {
  pill: $('#connection-pill'),
  dot: $('#status-dot'),
  title: $('#status-title'),
  message: $('#status-message'),
  responseTime: $('#response-time'),
  statusCode: $('#status-code'),
  lastCheck: $('#last-check'),
  subscriberCount: $('#subscriber-count'),
  monitoredUrl: $('#monitored-url'),
  notificationState: $('#notification-state'),
  enableButton: $('#enable-notifications'),
  testButton: $('#test-notification'),
  checkButton: $('#check-now'),
  installHelp: $('#install-help'),
  tokenBox: $('#token-box'),
  tokenForm: $('#token-form'),
  tokenInput: $('#token-input'),
  toast: $('#toast')
};

let config = null;
let registration = null;
let currentSubscription = null;
let toastTimer = null;
let token = localStorage.getItem('monitorToken') || '';

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function authHeaders(extra = {}) {
  return token ? { ...extra, 'x-monitor-token': token } : extra;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(options.headers || {})
  });

  if (response.status === 401) {
    elements.tokenBox.classList.remove('hidden');
    throw new Error('Informe o token de acesso.');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro HTTP ${response.status}`);
  elements.tokenBox.classList.add('hidden');
  return data;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 3500);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function renderState(state) {
  const status = state.status || 'unknown';
  const isUp = status === 'up';
  const isDown = status === 'down';

  elements.dot.className = `status-dot ${status}`;
  elements.pill.className = `pill ${isUp ? 'up' : isDown ? 'down' : 'neutral'}`;
  elements.pill.textContent = isUp ? 'Online' : isDown ? 'Fora do ar' : 'Verificando';
  elements.title.textContent = isUp ? 'API online' : isDown ? 'API fora do ar' : 'Verificando…';
  elements.message.textContent = isDown
    ? (state.error || 'A API não respondeu corretamente.')
    : isUp
      ? `Última resposta válida em ${state.responseTimeMs ?? '—'} ms.`
      : 'Aguardando dados suficientes para definir o estado.';

  elements.responseTime.textContent = state.responseTimeMs == null ? '—' : `${state.responseTimeMs} ms`;
  elements.statusCode.textContent = state.statusCode ?? '—';
  elements.lastCheck.textContent = formatDate(state.lastCheckAt);
  elements.subscriberCount.textContent = state.subscriberCount ?? '—';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function loadConfigAndStatus() {
  config = await apiFetch('/api/config', { cache: 'no-store' });
  elements.monitoredUrl.textContent = config.apiUrl;
  const state = await apiFetch('/api/status', { cache: 'no-store' });
  renderState(state);
}

async function updatePushState() {
  if (!registration || !('PushManager' in window)) {
    elements.notificationState.textContent = 'Web Push não disponível';
    elements.enableButton.disabled = true;
    return;
  }

  currentSubscription = await registration.pushManager.getSubscription();
  const granted = Notification.permission === 'granted' && currentSubscription;
  elements.notificationState.textContent = granted ? 'Notificações ativas' : 'Notificações desativadas';
  elements.enableButton.textContent = granted ? 'Notificações ativadas' : 'Ativar notificações';
  elements.enableButton.disabled = Boolean(granted);
  elements.testButton.disabled = !granted;
}

async function enableNotifications() {
  if (isIOS() && !isStandalone()) {
    elements.installHelp.classList.remove('hidden');
    showToast('No iPhone, instale primeiro pela opção “Adicionar à Tela de Início”.');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão de notificação não concedida.');

  currentSubscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
  });

  await apiFetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(currentSubscription)
  });

  await updatePushState();
  await loadConfigAndStatus();
  showToast('Notificações ativadas neste dispositivo.');
}

async function testNotification() {
  currentSubscription = await registration.pushManager.getSubscription();
  if (!currentSubscription) throw new Error('Ative as notificações primeiro.');

  await apiFetch('/api/test-notification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(currentSubscription)
  });
  showToast('Notificação de teste enviada.');
}

async function checkNow() {
  elements.checkButton.disabled = true;
  elements.checkButton.textContent = 'Verificando…';
  try {
    const state = await apiFetch('/api/check-now', { method: 'POST' });
    const status = await apiFetch('/api/status', { cache: 'no-store' });
    renderState({ ...state, subscriberCount: status.subscriberCount });
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

async function init() {
  if ('serviceWorker' in navigator) {
    registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  }

  if (isIOS() && !isStandalone()) elements.installHelp.classList.remove('hidden');

  await runAction(loadConfigAndStatus);
  await runAction(updatePushState);

  setInterval(() => runAction(loadConfigAndStatus), 30000);
}

elements.enableButton.addEventListener('click', () => runAction(enableNotifications));
elements.testButton.addEventListener('click', () => runAction(testNotification));
elements.checkButton.addEventListener('click', () => runAction(checkNow));
elements.tokenForm.addEventListener('submit', (event) => {
  event.preventDefault();
  token = elements.tokenInput.value.trim();
  localStorage.setItem('monitorToken', token);
  elements.tokenInput.value = '';
  runAction(async () => {
    await loadConfigAndStatus();
    await updatePushState();
    showToast('Acesso liberado.');
  });
});

window.addEventListener('online', () => runAction(loadConfigAndStatus));
window.addEventListener('offline', () => showToast('Este dispositivo está sem internet.'));

init().catch((error) => {
  console.error(error);
  showToast('Falha ao iniciar o monitor.');
});
