# NuControle

Controle de finanças pessoais no navegador, no computador ou no celular. O
diferencial é separar **de quem é cada gasto** que passa pelo seu cartão ou
conta: seu, de uma pessoa ou de uma organização (os "terceiros", que você
cadastra). Uma compra pode ser **dividida** entre vários donos.

Nada é automático. Você lança, o app calcula.

Cada pessoa tem a própria conta, com os próprios dados. O acesso é só por convite.

## Como funciona

```
navegador (computador ou celular)
   │  site estático: HTML, CSS e JS puros        -> GitHub Pages
   │  as regras rodam aqui (js/nucleo/)
   ▼
Supabase                                          -> login + Postgres
   - Auth: e-mail e senha, cadastro só por convite
   - cada tabela tem user_id e RLS: cada um só vê e mexe no que é seu
   - public.aplicar(ops): grava cada alteração numa transação só
```

O site carrega os dados da conta uma vez (é pouca coisa: as finanças de uma
pessoa), calcula as telas no próprio navegador e, a cada alteração, manda ao
servidor só **a diferença**, que é gravada inteira ou não é gravada (uma compra
nunca fica sem as parcelas). Se outro aparelho mexeu nos mesmos dados, o
servidor recusa, o site recarrega e avisa.

```
frontend/                    o site (é isto que vai para o GitHub Pages)
  index.html  css/app.css  manifest.webmanifest
  js/principal.js            partida: config, login, convite, esqueci a senha
  js/api.js                  api.metodo() que as telas chamam
  js/servidor.js             Supabase (ou localStorage, no modo local)
  js/nucleo/                 as regras, sem tela e sem rede (testadas no Node)
    dinheiro.js              centavos, divisão igual, rateio proporcional
    calendario.js            meses e ciclo da fatura
    banco.js                 dados em memória, transação e "diferença"
    regras.js                tudo que grava (compras, divisão, terceiros...)
    consultas.js             tudo que as telas leem (saldo, mês por dono...)
    transferencia.js         importar o .db do app desktop, backup .json
    configuracao.js          confere a URL/chave e recusa a chave secreta
  js/app.js telas.js lancamento.js graficos.js util.js   a interface
supabase/
  schema.sql                 tabelas, RLS e a função aplicar
  verificar.sql              confere a segurança (tudo tem que dar ok)
testes/                      npm test
ferramentas/                 vendor, config do deploy, servidor local, ícone
.github/workflows/publicar.yml   testa e publica a cada push na main
```

## Segurança

- **Nenhuma chave no repositório.** A URL e a chave *publishable* do Supabase
  ficam nas variáveis do GitHub e são injetadas só no deploy. A chave
  publishable é feita para ficar no navegador: sozinha, não abre nada.
- **A chave secreta nunca chega ao site.** `gerar-config.mjs` recusa
  `sb_secret_...` e `service_role`, e aí o deploy falha. O navegador confere de
  novo antes de iniciar.
- **RLS em todas as tabelas**: `user_id = auth.uid()` para ler e para gravar. As
  referências entre tabelas incluem o `user_id`, então ninguém pendura um
  registro seu em dado de outra pessoa. Quem não fez login (`anon`) não tem
  acesso a nada.
- `aplicar` roda como **quem chama** (`security invoker`): não libera nada que a
  API comum já não libere. Nome de tabela é validado por lista e colunas vão
  escapadas.
- O site só carrega arquivos do próprio domínio (CSP), sem CDN, e as bibliotecas
  são travadas pelo `package-lock.json`.
- Tudo isso é testado num Postgres de verdade (PGlite) em `testes/sql.test.js`:
  um usuário tenta ler, alterar, apagar e referenciar dados de outro, e falha.

## Publicar (passo a passo)

### 1. Supabase

1. Em [supabase.com](https://supabase.com), crie um projeto. Região: **South America (São Paulo)**.
   Guarde a senha do banco num gerenciador de senhas; o site não usa essa senha.
2. **SQL Editor → New query**: cole o conteúdo de `supabase/schema.sql` e clique em **Run**.
3. Numa nova query, rode `supabase/verificar.sql`. **Todas** as linhas precisam vir com `ok = true`.
4. **Authentication → Sign In / Providers**: deixe **Email** ligado e **desligue
   "Allow new users to sign up"**. Isso é o que torna o cadastro só por convite.
5. **Authentication → URL Configuration**:
   - Site URL: `https://miguelvieiravictor.github.io/NuControle/`
   - Redirect URLs: adicione o mesmo endereço.
6. **Project Settings → API Keys**: copie a **Project URL** e a chave
   **publishable** (`sb_publishable_...`). **Não** copie a secret.

### 2. GitHub

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → aba Variables → New repository variable**:
   - `SUPABASE_URL` = a Project URL
   - `SUPABASE_CHAVE` = a chave publishable
3. Leve o código para a `main` e dê push. Em **Actions**, o workflow "Publicar
   site" roda os testes e publica. O site fica em
   `https://miguelvieiravictor.github.io/NuControle/`.

### 3. Convidar quem vai usar

**Authentication → Users → Add user → Send invitation**, com o e-mail da
pessoa. Ela recebe o convite, clica no link, cria a senha e entra.

Se o e-mail não chegar (o Supabase grátis manda poucos por hora e às vezes cai
no spam), use **Add user → Create new user** com uma senha provisória. A pessoa
troca a senha em **Ajustes → Trocar senha**.

### 4. Trazer os dados do app desktop

No primeiro acesso, com a conta vazia, a Visão geral mostra **Importar dados**.
Em **Ajustes → Seus dados**, escolha o `nucontrole-v2.db` (fica em
`%APPDATA%\NuControle\dados`). O navegador lê o arquivo e grava na sua conta;
o arquivo não vai para o GitHub nem para nenhum outro lugar.

### 5. Backup

O plano grátis do Supabase **não faz backup sozinho**. Em **Ajustes → Seus dados
→ Baixar backup**, você baixa um `.json` com tudo; **Restaurar** carrega esse
arquivo de volta (troca todos os dados da conta). Faça isso de vez em quando.

Outros cuidados do plano grátis: o projeto **pausa depois de 7 dias sem nenhum
acesso** (para reativar, é um clique no painel) e o banco tem 500 MB, que sobram
para isso aqui.

### No celular

Abra o site e use **Adicionar à tela de início** (Safari: botão de compartilhar;
Chrome: menu ⋮). Ele abre como um app, sem a barra do navegador.

## Desenvolver

```bash
npm ci
npm run vendor     # copia supabase-js e sql.js para frontend/vendor/
npm run dev        # http://localhost:8080 no MODO LOCAL: sem login, dados no localStorage
npm test           # regras, paridade com a versão desktop, SQL/RLS no Postgres (PGlite)
```

Para testar contra o Supabase de verdade, gere o `frontend/js/config.js` (ele
fica fora do git):

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_CHAVE=sb_publishable_... node ferramentas/gerar-config.mjs
```

## Como o dinheiro é dividido

Todo valor é inteiro em centavos, do Postgres à tela.

- **Igual**: R$ 100,00 entre 3 → 33,34 / 33,33 / 33,33. O centavo que sobra vai
  para "Eu".
- **Por valor**: cada dono com seu valor. As regras recusam se a soma não fechar
  no centavo (o formulário mostra "faltam R$ X" ao vivo).
- **Parcelamentos e fixos divididos**: cada parcela é dividida na mesma
  proporção por `ratearMatriz`, que garante as duas somas ao mesmo tempo. Cada
  parcela fecha com a fatura, e a soma das parcelas de cada dono fecha com a
  parte dele.

```
compra            o que você digitou           (valor = total, ou valor/mês no fixo)
compra_parte      parte de cada dono            soma = compra.valor
lancamento        cada ocorrência: a compra, cada parcela, cada mês do fixo
lancamento_parte  parte de cada dono nela       soma = lancamento.valor
```

## Regras de saldo

- **Saldo é o realizado.** Fixos e parcelas futuras já existem, mas só mexem no
  saldo quando a data chega. O que ainda vai sair aparece à parte.
- **Crédito não move o saldo.** Vira fatura; o saldo muda no dia do pagamento.
- **A divisão não muda o saldo.** Ela diz de quem é o gasto, não de onde saiu o
  dinheiro: uma compra dividida sai inteira da sua conta.
- **Nada antes da data de início** (Ajustes) mexe no saldo. Faturas que
  venceram antes dela aparecem como "Antes do controle", não como pendência.

## Fatura

Identificada pelo mês em que **vence**. Com fechamento 29 e vencimento 3, a
fatura de outubro/2026 cobre compras de 30/08 a 29/09. Testado dia a dia por 3
anos com três configurações de cartão: toda data cai em exatamente uma fatura.
Mudar os dias do cartão em Ajustes reposiciona todas as compras.

## Fixos

Gerados até 2 meses adiante (para aparecerem na fatura aberta), ou até o mês
que você abrir. Dá para **pular um mês** (ele não volta a ser gerado sozinho),
**encerrar** num mês ou editar. Edições valem a partir do mês atual; os meses
passados ficam como estavam.

## Cores dos donos

"Eu" usa o violeta `#9085E9`, e cada terceiro novo recebe a próxima cor desta
ordem: aqua, laranja, azul, amarelo, magenta, verde, vermelho. A ordem foi
validada para daltonismo em pares vizinhos sobre o fundo escuro (pior par
ΔE 8,6 em CVD, 19,3 em visão normal), porque é assim que os donos aparecem na
barra empilhada da fatura.
