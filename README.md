# Remote Support Suite (Agent + Controller)

Projeto de suporte remoto com foco em **seguranca, consentimento e auditoria**. Nenhum acesso e permitido sem confirmacao explicita do usuario local. Nao existe modo stealth, persistencia oculta, bypass de permissoes ou coleta silenciosa.

## Visao geral

- **Agent**: instalado na maquina do usuario que vai receber suporte.
- **Controller**: usado pelo tecnico para ver a tela e, se autorizado, controlar mouse/teclado.
- **Signaling Server**: WebSocket + REST para login, criacao de sessoes e negociacao WebRTC.
- **Infra**: `docker-compose` com signaling server e `coturn` (STUN/TURN).

No Agent, o usuario faz um login local simples (nome) e o codigo de acesso e gerado automaticamente ao entrar.

## Stack

- Desktop: **Tauri + Rust**
- UI: **React + Vite + Tailwind**
- Transporte de midia: **WebRTC**
- Sinalizacao: **WebSocket** (WSS em producao)

## Estrutura

```
/server
/apps/agent
/apps/controller
/infra
/scripts
```

## Requisitos

- Node.js 20+
- Rust toolchain (stable)
- Tauri prerequisites (MSVC, WebView2 no Windows)
- Docker (para `infra`)

## Configuracao rapida

1) Copie os exemplos de variaveis:

```
copy .env.example .env
copy server\.env.example server\.env
copy apps\agent\.env.example apps\agent\.env
copy apps\controller\.env.example apps\controller\.env
```

2) Ajuste os valores (`JWT_SECRET`, usuario tecnico, URLs, TURN, etc.).

## Rodar local (dev)

- Subir servidor de sinalizacao:

```
cd server
npm install
npm run dev
```

- Rodar Agent e Controller (apenas UI, sem Tauri):

```
cd apps\agent
npm install
npm run dev

cd apps\controller
npm install
npm run dev
```

- Rodar com Tauri (apps desktop):

```
cd apps\agent
npm run tauri:dev

cd apps\controller
npm run tauri:dev
```

## Build de instaladores

Scripts prontos:

```
.\scripts\build-installers.ps1
```

No macOS/Linux, use:

```
./scripts/build-installers.sh
```

Isso executa `tauri build` para Agent e Controller. O Windows gera MSI/EXE por padrao.

## TLS / WSS / Dominio

- Em producao, **obrigatorio** usar WSS (TLS). 
- Coloque o signaling server atras de um proxy (NGINX/Caddy) com certificado.
- Ajuste `VITE_SIGNALING_URL` e `VITE_API_URL` para o dominio HTTPS/WSS.

## TURN / NAT traversal

- O `coturn` esta em `infra/docker-compose.yml`.
- Configure `TURN_USER`, `TURN_PASSWORD` e dominios.
- Use as credenciais nas variaveis `VITE_TURN_URLS`.

## Servidor como servico (Windows)

Recomendado para manter o signaling **24/7** sem quedas. Usa **NSSM**.

1) Abra PowerShell como **Administrador**.
2) Execute:

```
cd server
.\scripts\windows\install-service.ps1
```

Isso:
- instala o NSSM (se necessario),
- builda o servidor se `dist/index.js` nao existir,
- cria o servico `RemoteSupportServer`,
- inicia automaticamente no boot,
- grava logs em `server\logs`.

Para remover:

```
cd server
.\scripts\windows\uninstall-service.ps1
```

## Deploy gratuito no Render + keep-alive (cron)

**Aviso**: no free tier, o Render pode **hibernar** quando nao ha trafego. O keep-alive evita isso para testes, mas nao e garantia de SLA. Em producao, prefira plano pago/VPS.

1) Crie um **Web Service** no Render apontando para este repo.
2) Configure:
   - Build: `npm install && npm run build`
   - Start: `npm run start`
   - Root (opcional): `server`
3) Defina as variaveis de ambiente (no dashboard do Render):
   - `JWT_SECRET`, `TECH_EMAIL`, `TECH_PASSWORD`, etc.
4) Crie um **Cron Job** no Render com o comando:

```
node server/scripts/keepalive.mjs
```

5) Configure o cron para rodar a cada 10-14 minutos (UTC).
6) Defina a env `KEEPALIVE_URL` no Cron Job:

```
KEEPALIVE_URL=https://SEU-SERVICO.onrender.com/healthz
```

## Fluxo de consentimento

1) Tecnico solicita compartilhamento.
2) Usuario local **aceita** antes de iniciar o streaming.
3) Tecnico solicita controle.
4) Usuario local **aceita** controle de mouse/teclado.

Sem aceite explicito, nao existe streaming nem controle.

## Auditoria

- Agent registra inicio/fim, tecnico, IP e permissoes concedidas.
- Exporta log local em JSON.
- Opcionalmente envia log ao servidor via REST.

## Transferencia de arquivos (opcional)

- Existe apenas o **fluxo de permissao** (pedido + aceite/negacao).
- Nenhuma transferencia de arquivo e realizada neste MVP.

## Observacoes de seguranca

- Agent roda como usuario normal.
- Qualquer permissao especial (screen recording / accessibility) e solicitada pelo sistema operacional.
- Sem acesso a arquivos, sem execucao de comandos remotos.

## Permissoes do SO

- macOS: permitir *Screen Recording* para o Agent e *Accessibility* se desejar controle de input.
- Windows: garantir que o app tenha permissao para capturar a tela; o UAC exibira prompt quando necessario.
- Linux: Wayland pode limitar captura/controle; prefira X11 ou conceda permissoes no compositor.
- Linux (input): o crate `enigo` pode exigir dependencias como `libxdo`/`xdotool`.

## Licenca

Uso educacional / demonstrativo. Ajuste conforme necessidade da sua organizacao.
