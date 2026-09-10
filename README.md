# NuControle

Controle de finanças pessoais com o que os apps genéricos não fazem: separar
o que é **gasto seu** do que é **dinheiro de terceiros** e do que é **da Genesys**
passando pelo seu cartão — e mostrar, do total que vence dia 3, quanto realmente
sai do seu bolso.

Nada é automático. Você lança, o app calcula.

---

## Rodar

```bash
python -m pip install -r requirements.txt
python run.py
```

O navegador abre em `http://127.0.0.1:8757`. O servidor escuta **só em
localhost** — nada sai da sua máquina e nada da rede alcança o app.

Na primeira execução aparece o setup, que pede o ponto de partida: saldo da
conta, caixinhas/fundos, parcelamentos já em andamento e a fatura aberta.

```bash
python testes.py          # 127 verificações, em banco temporário
python run.py --sem-navegador
```

---

## O modelo mental

Todo lançamento tem **duas** classificações independentes, além da categoria:

|                | Fixo | Parcelamento | Avulso |
|----------------|:----:|:------------:|:------:|
| **Pessoal**    |  ✓   |      ✓       |   ✓    |
| **Terceiros**  |  ✓   |      ✓       |   ✓    |
| **Genesys**    |  ✓   |      ✓       |   ✓    |

E três conceitos de tempo que o app nunca mistura:

| Conceito | O que é | Onde aparece |
|---|---|---|
| **Mês** | mês do calendário (01/09 a 30/09) | "onde eu gastei", as 3 tabelas |
| **Fatura** | ciclo do cartão (30/08 a 29/09, vence 03/10) | aba Cartão, "quanto pago dia 3" |
| **Data de corte** | o dia em que você informou os saldos no setup | limite inferior de todo cálculo de saldo |

A fatura é identificada pelo mês em que **vence**. Com fechamento dia 29 e
vencimento dia 3, a fatura `2026-10` cobre compras de 30/08 a 29/09.

### Regras que o app garante

- **Dinheiro é `int` em centavos**, do SQLite ao JavaScript. Nenhum `float`
  atravessa a fronteira — em dinheiro, `0.1 + 0.2 != 0.3` é inaceitável.
- **Toda data cai em exatamente uma fatura.** Testado dia a dia por 3 anos,
  incluindo fevereiro (o "dia 29" vira dia 28 sem abrir buraco no ciclo).
- **Parcelas nunca perdem centavo.** R$ 100,00 em 3x = 33,34 / 33,33 / 33,33.
- **Saldo é o realizado, não o previsto.** Um gasto fixo gera as parcelas dos
  meses seguintes, mas o aluguel de outubro não derruba o saldo de hoje. O que
  ainda vai sair aparece separado, como "ainda saem R$ X este mês".
- **Compra no crédito não move o saldo.** Ela vira fatura; o saldo só muda no
  dia do pagamento.
- **Pagar a fatura pela caixinha não move o saldo da conta.** O app faz os dois
  lados do que você faz na mão: saca da caixinha (creditando a conta) e paga a
  fatura (debitando a conta). Efeito líquido: zero. O dinheiro saiu da caixinha.
- **Não existem meses anteriores a setembro/2026.** Lançar antes disso é
  recusado pelo back-end, não só escondido na tela.

---

## Estrutura

```
run.py               sobe o servidor e abre o navegador
testes.py            127 verificações, em banco temporário

backend/
  modelos.py         enums, centavos, matemática do ciclo da fatura
  db.py              conexão SQLite, schema, migrações, backup
  regras.py          saldos, faturas, dashboard          (não fala HTTP)
  repositorio.py     criar / editar / apagar             (não fala HTTP)
  api.py             endpoints + serve o front-end

frontend/
  index.html         estrutura da página
  erro.html          tela de "não foi possível iniciar" (usada pelo Tauri)
  css/app.css        tokens + componentes (tema claro Nubank)
  js/util.js         dinheiro, datas, escape de HTML, modal, avisos
  js/api.js          uma função por endpoint
  js/graficos.js     barras ordenadas + barra empilhada
  js/tabelas.js      conteúdo das 5 abas
  js/setup.js        assistente de primeiro uso
  js/app.js          estado, eventos, telas

src-tauri/           casca desktop (fase 2)
  src/main.rs        escolhe a porta, sobe o Python, abre a janela
  tauri.conf.json    janela, ícones, recursos empacotados
  icons/             gerados por script, não pelo CLI do Tauri

%APPDATA%\NuControle\dados\    seus dados (fora do projeto, fora do git)
  nucontrole.db                seu banco
  backups/                     cópias automáticas antes de operações destrutivas
```

O banco fica na pasta do **usuário**, não junto do programa — porque o
programa pode estar em Program Files (somente leitura) ou numa pasta de build
que `cargo clean` apaga. Isso também garante **um banco só**, seja abrindo pelo
`.exe` ou por `python run.py`. Para rodar uma instância separada (testes, uma
segunda base), defina `NUCONTROLE_DADOS`.

`regras.py` e `repositorio.py` **não conhecem HTTP**. Essa fronteira é o que
torna a fase 2 (Tauri) uma troca de casca, não uma reescrita.

---

## Levar para outro computador

O banco é **um único arquivo**. Não usamos WAL de propósito — WAL cria arquivos
`-wal` e `-shm` ao lado, e a ideia é poder copiar o banco arrastando um arquivo.

1. **Ajustes → Baixar backup** gera `nucontrole_AAAA-MM-DD_HHMMSS.db`
2. No outro PC: instalar Python 3.11+, `pip install -r requirements.txt` e abrir
   o app (pelo `.exe` ou por `python run.py`)
3. **Ajustes → Escolher arquivo .db** e apontar para o backup

A importação valida que o arquivo é um banco do NuControle e salva o banco
vigente em `dados/backups/` antes de sobrescrever — uma importação errada nunca
é definitiva.

---

## App desktop (Tauri)

```bash
cd src-tauri
cargo build --release        # gera target/release/nucontrole.exe
cargo tauri build            # gera o instalador NSIS (precisa do tauri-cli)
```

Ou continue usando `python run.py` — o app no navegador e o app na janela
carregam **a mesma** interface.

### Como a casca funciona

O Rust não sabe nada de finanças. `src-tauri/src/main.rs` faz quatro coisas:

1. pede ao sistema uma **porta livre**;
2. acha o Python do sistema e sobe `run.py` nela (via `NUCONTROLE_PORTA`);
3. espera a porta começar a aceitar conexão (até 45 s);
4. abre a janela em `http://127.0.0.1:<porta>`.

```
NuControle.exe  ──spawn──>  python run.py   (processo filho, sem console)
      │                          │
      └──── janela WebView2 ─────┘
              http://127.0.0.1:<porta>
```

O Python é morto quando a janela fecha (`RunEvent::Exit`) — e também quando
**não** fecha direito. Dois detalhes que custaram bug:

- O Rust não sobe o Python via `py -3`, e sim pergunta a ele onde mora
  (`sys.executable`) e executa **esse binário direto**. Via `py`, o launcher é
  um intermediário: matar o `py.exe` deixava o `python.exe` neto órfão
  segurando a porta e o arquivo do banco.
- O Python recebe o `stdin` ligado a um **pipe** que o Rust mantém aberto
  (`NUCONTROLE_VIGIAR_STDIN=1`). Se o app for encerrado à força — Gerenciador
  de Tarefas, pânico — o `RunEvent::Exit` nunca roda, mas o sistema fecha o
  pipe, o `sys.stdin.read()` retorna EOF e o Python se encerra sozinho. Mesmo
  efeito de um Job Object do Windows, sem uma linha de `unsafe`.

**O Python vem do sistema**, por decisão de projeto — o `.exe` fica pequeno,
mas exige Python 3.11+ com as dependências instaladas. Esse é o ponto frágil da
escolha, então quando algo falta a casca não abre uma janela branca: ela abre
`frontend/erro.html`, que diz exatamente qual comando rodar. Os quatro casos
tratados são `sem-python`, `sem-dependencias`, `sem-projeto` e `sem-servidor`.

### Ferramentas instaladas

| Ferramenta | Versão | Onde |
|---|---|---|
| rustup / rustc / cargo | 1.29.1 / 1.98.1 / 1.98.1 | `~/.cargo/bin` (perfil do usuário) |
| VS Build Tools 2022 | 17.14.40 | `C:\Program Files (x86)\...\BuildTools` |
| MSVC toolset | 14.44.35207 | idem |
| Windows SDK | 10.0.26100.0 | `C:\Program Files (x86)\Windows Kits\10` |
| WebView2 | já vinha no Windows 11 | — |

Os ícones em `src-tauri/icons/` são gerados por script (PNG e ICO escritos à
mão, sem Pillow e sem o CLI do Tauri) — não é preciso Node no projeto.

Se quiser eliminar o HTTP no futuro, o único arquivo a substituir é `api.py`:
os comandos Rust chamariam `regras.py` / `repositorio.py` diretamente, porque
essas duas camadas não conhecem HTTP.

---

## Decisões de projeto

**Por que barras ordenadas e não um gráfico de rosca?** "Onde eu mais gasto" é
uma pergunta de *ranking*, e com ~12 categorias uma rosca fica ilegível. As
barras respondem na hora. Série única, então um roxo só — o tamanho da barra já
carrega a magnitude; colorir por posição pintaria o *rank*, não a categoria. A
cor de cada categoria vive num ponto de identidade ao lado do nome.

**As três cores de dado** (Pessoal `#820AD1`, Terceiros `#0891B2`, Genesys
`#EA580C`) foram validadas para daltonismo: pior par adjacente com ΔE 16,0 em
deuteranopia e 28,6 em visão normal, sobre fundo branco. Texto nunca usa cor de
dado — a identidade vem sempre do marcador colorido ao lado.

**Por que `check_same_thread=False` no SQLite?** O FastAPI executa a dependência
que abre a conexão e a função do endpoint em threads possivelmente diferentes do
seu pool. Sem isso, endpoints falham de forma **intermitente**. É seguro porque
cada request tem sua própria conexão e o uso é estritamente sequencial dentro do
request. Está comentado em `db.py`.

**Por que os gastos fixos são materializados?** Você cadastra a Netflix uma vez
e a tabela `recorrencia_gerada` registra o par (recorrência, mês). O registro
**sobrevive** à exclusão do lançamento — assim um fixo que você apagou de
propósito não volta a aparecer sozinho no mês seguinte.

**Por que o saldo de fatura anterior do setup não conta como gasto do mês?**
Ele é dinheiro gasto antes do controle começar. Precisa entrar no total que você
paga dia 3 (e entra), mas sujaria exatamente a análise de "onde eu mais gastei"
que o app existe para fazer.
