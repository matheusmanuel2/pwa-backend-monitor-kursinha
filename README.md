# Monitor PWA da API Kursinha

PWA instalável no iPhone e no PC que recebe notificações quando `https://api.kursinha.com/` cai e quando volta.

## Como funciona

O servidor verifica a API a cada 60 segundos. Depois de 2 falhas consecutivas, envia um Web Push para todos os dispositivos inscritos. Quando a API responde novamente, envia outro alerta informando a recuperação.

O monitor precisa ficar hospedado 24 horas por dia. Não basta deixar apenas a página aberta no celular ou PC.

## Rodar localmente

Requer Node.js 20 ou superior.

```bash
cp .env.example .env
npm install
npm start
```

Abra `http://localhost:3000` no PC. Para testar no iPhone, a aplicação precisa estar em um endereço HTTPS público; Web Push e Service Worker não funcionam normalmente em um IP HTTP da rede local.

Na primeira inicialização, o servidor gera automaticamente as chaves Web Push em `data/vapid.json`. Preserve esse diretório, pois trocar as chaves invalida inscrições antigas.

## Colocar no ar rapidamente

### Opção 1 — Railway

1. Crie um repositório Git com este projeto.
2. Importe o repositório no Railway.
3. Adicione um volume persistente montado em `/app/data`.
4. Defina as variáveis do arquivo `.env.example` no painel.
5. Gere um domínio HTTPS no Railway.

Use um plano que não suspenda o serviço. Um monitor que “dorme” não consegue detectar indisponibilidade.

### Opção 2 — VPS com Docker

```bash
cp .env.example .env
docker compose up -d --build
```

Coloque Caddy, Nginx ou Cloudflare Tunnel na frente da porta 3000 para fornecer HTTPS.

## Variáveis principais

- `API_URL`: URL monitorada.
- `CHECK_INTERVAL_MS`: intervalo entre verificações; padrão 60000.
- `FAILURE_THRESHOLD`: falhas consecutivas antes do alerta; padrão 2.
- `REQUEST_TIMEOUT_MS`: tempo máximo por chamada; padrão 10000.
- `ACCESS_TOKEN`: opcional, protege o painel e as inscrições.
- `VAPID_SUBJECT`: use `mailto:seu-email@dominio.com`.
- `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`: opcionais. Sem elas, são geradas no diretório persistente.

## Instalar no iPhone

1. Abra o endereço HTTPS no Safari.
2. Toque no botão Compartilhar.
3. Escolha **Adicionar à Tela de Início**.
4. Abra o ícone instalado.
5. Toque em **Ativar notificações** e permita.
6. Toque em **Enviar notificação de teste**.

No iPhone, Web Push exige iOS/iPadOS 16.4 ou superior e o site instalado na Tela de Início.

## Instalar no PC

Abra no Chrome ou Edge, use o ícone de instalação na barra de endereço e depois clique em **Ativar notificações**. Também funciona como página normal, mas a instalação deixa o acesso mais simples.

## Testes

```bash
npm run check
curl http://localhost:3000/healthz
curl http://localhost:3000/api/status
```

Se `ACCESS_TOKEN` estiver configurado:

```bash
curl -H "x-monitor-token: SEU_TOKEN" http://localhost:3000/api/status
```
