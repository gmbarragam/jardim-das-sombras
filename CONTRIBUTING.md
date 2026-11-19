# Guia de Contribuição — Jardim das Sombras (Shadow Garden)

Bem-vindo ao repositório do **Jardim das Sombras**! Este projeto é um microsserviço RESTful headless de fazenda gótica desenvolvido como parte do ecossistema do bot **Ravena-AI**.

Este documento serve de guia para **desenvolvedores humanos** e **agentes autônomos de IA** (Coding Agents como Gemini, Claude, Cursor, Copilot, etc.) que forem criar novas funcionalidades, corrigir bugs ou estender a integração.

---

## 🏗️ 1. Arquitetura e Filosofia do Projeto

- **Headless & Desacoplado:** A API não lida diretamente com mensagens ou protocolos de chat (WhatsApp, Telegram, Discord). A API fornece endpoints REST protegidos e renderiza imagens isométricas via `@napi-rs/canvas`.
- **Ecosistema Ravena-AI:** O bot externo ([Ravena-AI](https://github.com/moothz/ravena-ai)) orquestra os comandos de chat (`!fazenda`, `!plantar`, `!colher`), interage com o usuário e consome esta API.
- **Fail Closed & Validações:** Erros de domínio usam `DomainError` com códigos HTTP semânticos e mensagens em Português. Nenhuma exceção de validação deve passar silenciosamente.

---

## 🤖 2. Diretrizes Específicas para Agentes de IA (AI Agents Guidelines)

Se você é um agente de IA operando neste repositório, você **DEVE** seguir rigorosamente as regras abaixo:

### 2.1. Segurança e Privacidade (Privacidade Zero Leaks)
1. **Nunca use caminhos absolutos do host:** Proibido usar caminhos como `/home/...`, `/Users/...` ou referências à máquina local. Use caminhos relativos ou construídos dinamicamente via `path.resolve(__dirname, ...)`.
2. **Sem domínios privados como padrão:** Variáveis como `PUBLIC_URL` e `API_URL` devem ter como fallback padrão `http://localhost:3040`. Domínios de produção devem vir estritamente de variáveis de ambiente.
3. **Sem segredos no código ou git:** Nunca commite tokens reais, senhas, telefones de usuários ou chaves no repositório. Use `.env.example` para documentar variáveis.

### 2.2. Padrões de Código e TypeScript
1. **Node.js ESM Strict:** O projeto usa ECMAScript Modules (`"type": "module"`). Todas as importações relativas em arquivos TypeScript **precisam** conter a extensão `.js`:
   ```typescript
   // ✅ Correto:
   import { config } from '../config.js';
   import { DomainError } from '../errors/DomainError.js';

   // ❌ Errado:
   import { config } from '../config';
   ```
2. **Tipagem Estrita:** Evite o uso de `any` em assinaturas públicas e rotas. Valide entradas de API e variáveis de ambiente com esquemas `zod`.

### 2.3. Verificação Obrigatória (Checklist Pré-Conclusão)
Antes de finalizar qualquer alteração ou abrir pull request:
1. **Testes Unitários:** Execute `npm test` dentro de `api/` (Vitest). Todos os testes devem passar (100% green).
2. **Typecheck:** Execute `npx tsc --noEmit` em `api/` e em `bot/`. Não deve haver erros de compilação.
3. **Integridade de Documentação:** Mantenha a documentação sincronizada em `README.md` e [`docs/INTEGRATION.md`](docs/INTEGRATION.md) se criar ou alterar rotas.

### 2.4. Telemetria OpenTelemetry (Obrigatória em todo PR)
Toda rota, serviço ou fluxo novo (ou alterado) deve sair instrumentado. Referência: [`OBSERVABILITY.md`](OBSERVABILITY.md) e o da ravena-ai. Helpers em `api/src/telemetry.ts` (no-op com a telemetria desligada).
1. **Operação de negócio** (plantar, colher, vender, comprar, transferir…): `withSpan('<área> <operação>', { attributes: { 'jds.user.id': userIdAttr(userId) } }, async (span) => ...)`. Etapas lentas (render, encode, consulta pesada, aviso ao bot) ganham span filho; transações Prisma usam `withTxSpans`.
2. **Atributos de negócio:** `setAttrs({ 'jds.<domínio>.<campo>': valor })`. Recusa esperada (`DomainError`, saldo, limite) é rejeição, não erro: use `markRejected`. Exceção inesperada: `recordError(span, err)`.
3. **Rotas:** o `@fastify/otel` já cria o span SERVER, e o hook `preValidation` grava `user_id`/`userId`/`fromUserId`/`toUserId`. Prisma já é instrumentado via `$extends` (não use `@prisma/instrumentation`).
4. **IDs:** jogador só via `userIdAttr()` em `jds.user.id` (ou `from_user`/`to_user`), nunca no nome do span. **Nunca** em span: nome de jogador ou fazenda, textos livres, mensagens de `DomainError`, tokens, headers.
5. **Nome de span** de baixa cardinalidade, sem IDs nem valores (vira dimensão de métrica).
6. **Documentação:** acrescente o span novo no `OBSERVABILITY.md`. **Validar:** com `OTEL_EXPORTER_OTLP_ENDPOINT` ligado localmente, confira o trace no Jaeger (`http://localhost:16686`).

---

### 2.5. Mudanças de balanceamento da economia: registrar depois do deploy (OBRIGATÓRIO)
O painel da economia (Grafana, aba **Mudanças**) compara os 7 dias antes e depois de cada mudança. Para isso, toda mudança que altere quanto de Petalitas entra ou sai precisa estar registrada **no instante em que passou a valer em produção**.
- **O que conta:** recompensa, preço, taxa, limite diário, chance, cotação, multiplicador, cooldown que limita ganho, evento com prêmio, compensação, give-all e script retroativo que credita ou debita moeda.
- **Prefira constante a número solto no código.** Os valores ficam no catálogo (`data/plants|decorations|consumables.json`), em `data/economy.json` e nas constantes de `catalog.ts`, `economy.ts`, `FarmService.ts` e `ShopService.ts`, e saem em `api/src/utils/economyParams.ts`. Constante que está na rota `GET /internal/economy/params` é registrada sozinha pela ravena no deploy, com o valor antigo e o novo. Constante nova nos arquivos cobertos precisa entrar na rota ou na lista de ignoradas, ou o teste de guarda falha.
- **Registre depois do deploy, nunca no commit nem na abertura do PR.** O commit pode levar dias para ir ao ar, e a ficha mediria a semana errada.
- **No PR**, inclua uma seção "Registro pós-deploy" com o comando pronto para quem fizer o deploy:
  `docker exec ravena-ai node scripts/economy-annotate.js "<o que mudou e por quê>" <zinthos|petalitas|runas|todas> [hora ISO do deploy]`
  Sem a hora, o registro vale para agora. Se o deploy já aconteceu, passe a hora dele.
- **Se você fizer ou acompanhar o deploy**, rode o comando assim que a versão nova estiver no ar. Antes, confira com `docker exec ravena-ai node scripts/economy-annotate.js --listar` se a mudança já entrou como automática. Se entrou, não registre de novo: o porquê fica no PR.
- **Script retroativo, compensação ou give-all:** registre depois da execução, com a hora em que rodou.
- **Possíveis mudanças** (marca âmbar, detectadas nos dados): decida com `--confirmar <ts> "texto"` ou `--descartar <ts> "texto"` (o `ts` sai do `--listar`).

---

## 🚀 3. Como Configurar o Ambiente de Desenvolvimento

### Pré-requisitos
- Node.js 22 LTS ou superior
- Docker e Docker Compose (opcional para rodar com banco)
- npm 10+

### Instalação Rápida com Docker
```bash
# 1. Clone o repositório
git clone https://github.com/moothz/jardim-das-sombras.git
cd jardim-das-sombras

# 2. Configure as variáveis de ambiente
cp .env.example .env

# 3. Inicie os containers com o Makefile
make up

# 4. Acompanhe os logs
make logs
```

### Execução Local (Sem Docker)
```bash
# API
cd api
npm install
cp .env.example .env
npx prisma generate
npm run dev

# Bot de testes (opcional)
cd ../bot
npm install
npm run dev
```

---

## 🧪 4. Testes Automatizados

O repositório conta com uma suíte de testes unitários abrangente cobrindo:
- Catálogo de sementes e decorações
- Cálculos econômicos de colheita e sacola diária
- Renderização isométrica de canteiros com Canvas
- Limites de compra e consumíveis mágicos

```bash
cd api
npm run test
```

---

## 📦 5. Convenção de Commits

Seguimos a convenção [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` Nova funcionalidade
- `fix:` Correção de bug
- `test:` Inclusão ou ajuste de testes
- `docs:` Alterações em documentação
- `refactor:` Refatoração de código sem alteração funcional
- `chore:` Tarefas de manutenção e infraestrutura
