"""NuControle -- controle de financas pessoais.

Camadas, de baixo para cima:

    modelos.py     enums, dinheiro em centavos, matematica do ciclo da fatura
    db.py          conexao SQLite, schema, migracoes, backup
    regras.py      calculos: saldos, faturas, dashboard  (nao fala HTTP)
    repositorio.py escrita no banco: criar, editar, apagar
    api.py         endpoints HTTP + servico do front-end

`regras.py` e `repositorio.py` nao conhecem HTTP. Quando o front virar
Tauri, so `api.py` (ou o comando Rust que o substituir) precisa mudar.
"""

__version__ = "1.0.0"
