# NuControle 2

Controle de finanças pessoais em janela desktop. O diferencial é separar **de quem
é cada gasto** que passa pelo seu cartão ou conta: seu, de uma pessoa ou de uma
organização (os "terceiros", que você cadastra). Uma compra pode ser **dividida**
entre vários donos.

Nada é automático. Você lança, o app calcula.

## Rodar

```bash
python -m pip install -r requirements.txt
python app.py              # abre a janela
python app.py --debug      # com DevTools (F12)
python testes.py           # 38 testes, em banco temporário
```

Gerar o executável (não exige Python no PC de destino):

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1   # -> dist\NuControle.exe
```

## Stack

| Camada | O quê |
|---|---|
| Janela | **pywebview** (WebView2 no Windows). Sem servidor HTTP e sem porta: o JS chama o Python direto via `window.pywebview.api` |
| Back | Python + SQLite, sem dependências além do pywebview |
| Front | HTML, CSS e JS puros, tema escuro |

```
app.py                 abre a janela
build.ps1              testes + PyInstaller -> dist\NuControle.exe
testes.py
nucontrole/
  dinheiro.py          centavos, divisão igual, rateio proporcional
  calendario.py        meses e ciclo da fatura
  db.py                schema e local do banco
  base.py              "hoje", configuração, erro de validação
  escrita.py           tudo que grava (compras, divisão, terceiros, caixinhas...)
  consultas.py         tudo que as telas leem (saldo, mês por dono, fatura...)
  ponte.py             métodos expostos ao JavaScript
frontend/
  index.html  css/app.css
  js/util.js           dinheiro, datas, modal, avisos
  js/api.js            api.metodo() -> window.pywebview.api.metodo()
  js/graficos.js       barras ordenadas e barra empilhada
  js/lancamento.js     formulário de lançamento com divisão
  js/telas.js          as seis telas
  js/app.js            navegação
```

## Dados

`%APPDATA%\NuControle\dados\nucontrole-v2.db`, um arquivo só (sem WAL), que dá
para copiar para outro PC. O `nucontrole.db` da versão 1 fica ao lado, intocado.
A variável `NUCONTROLE_DADOS` aponta para outra pasta (testes, instância separada).

**Ajustes → Backup** faz isso pelo app:

- **Salvar backup…** grava uma cópia onde você escolher (`nucontrole_AAAA-MM-DD_HHMM.db`).
- **Restaurar backup…** valida o arquivo (é da v2? está íntegro?), mostra um
  resumo e pede confirmação. Antes de substituir, guarda os dados atuais em
  `dados\backups\antes-de-restaurar_<data>.db`, então uma restauração errada
  nunca é definitiva. Um banco da versão 1 é recusado com mensagem própria.

As duas operações usam `Connection.backup` do SQLite, que copia o banco aberto
de forma consistente. Não é preciso fechar o app nem trocar um arquivo em uso
(o que no Windows falharia).

## Como o dinheiro é dividido

Todo valor é `int` em centavos, do SQLite ao JavaScript.

- **Igual**: R$ 100,00 entre 3 → 33,34 / 33,33 / 33,33. O centavo que sobra vai
  para "Eu".
- **Por valor**: cada dono com seu valor. O back-end recusa se a soma não fechar
  no centavo (o formulário mostra "faltam R$ X" ao vivo).
- **Parcelamentos e fixos divididos**: cada parcela é dividida na mesma
  proporção por `ratear_matriz`, que garante as duas somas ao mesmo tempo. Cada
  parcela fecha com a fatura, e a soma das parcelas de cada dono fecha com a
  parte dele. Ratear parcela por parcela sozinha não garante a segunda soma,
  porque o centavo de arredondamento cairia sempre no mesmo dono.

```
compra            o que você digitou           (valor = total, ou valor/mês no fixo)
compra_parte      parte de cada dono            soma = compra.valor
lancamento        cada ocorrência: a compra, cada parcela, cada mês do fixo
lancamento_parte  parte de cada dono nela       soma = lancamento.valor
```

## Regras de saldo

- **Saldo é o realizado.** Fixos e parcelas futuras existem no banco, mas só
  mexem no saldo quando a data chega. O que ainda vai sair aparece à parte.
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

Gerados até 2 meses adiante (para aparecerem na fatura aberta). Dá para
**pular um mês** (ele não volta a ser gerado sozinho), **encerrar** num mês ou
editar. Edições valem a partir do mês atual; os meses passados ficam como
estavam.

## Cores dos donos

"Eu" usa o violeta `#9085E9`, e cada terceiro novo recebe a próxima cor desta
ordem: aqua, laranja, azul, amarelo, magenta, verde, vermelho. A ordem foi
validada para daltonismo em pares vizinhos sobre o fundo escuro (pior par
ΔE 8,6 em CVD, 19,3 em visão normal), porque é assim que os donos aparecem na
barra empilhada da fatura. Violeta ao lado de azul reprovava (ΔE 1,9).
