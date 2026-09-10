"""
Testes do NuControle.

    python testes.py

Roda em um banco TEMPORARIO -- nunca toca em `dados/nucontrole.db`.
Cobre o que da prejuizo se estiver errado: centavos, ciclo da fatura,
divisao de parcelas e o efeito de cada operacao no saldo.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import date
from pathlib import Path

# Precisa vir ANTES de importar backend.db, que le a pasta na hora do import.
_TMP = Path(tempfile.mkdtemp(prefix="nucontrole_testes_"))
os.environ["NUCONTROLE_DADOS"] = str(_TMP)

from backend import db, regras, repositorio  # noqa: E402
from backend.modelos import (  # noqa: E402
    ciclo_fatura,
    clamp_dia,
    dividir_parcelas,
    fatura_de_compra,
    formatar_reais,
    parse_centavos,
    somar_meses,
)

_falhas: list[str] = []
_total = 0


def checar(rotulo: str, obtido, esperado) -> None:
    global _total
    _total += 1
    if obtido == esperado:
        print(f"  [ OK ] {rotulo}")
    else:
        print(f"  [FALHA] {rotulo}")
        print(f"          esperado: {esperado!r}")
        print(f"          obtido  : {obtido!r}")
        _falhas.append(rotulo)


def checar_erro(rotulo: str, funcao, excecao=Exception) -> None:
    global _total
    _total += 1
    try:
        funcao()
    except excecao:
        print(f"  [ OK ] {rotulo}")
        return
    except Exception as exc:  # noqa: BLE001
        print(f"  [FALHA] {rotulo} -- levantou {type(exc).__name__}, esperava {excecao.__name__}")
        _falhas.append(rotulo)
        return
    print(f"  [FALHA] {rotulo} -- nao levantou erro nenhum")
    _falhas.append(rotulo)


def secao(titulo: str) -> None:
    print(f"\n{titulo}")
    print("-" * len(titulo))


# ---------------------------------------------------------------------------


def testar_dinheiro() -> None:
    secao("Dinheiro em centavos")

    checar("formata mil reais", formatar_reais(123456), "R$ 1.234,56")
    checar("formata centavos sozinhos", formatar_reais(5), "R$ 0,05")
    checar("formata zero", formatar_reais(0), "R$ 0,00")
    checar("formata negativo", formatar_reais(-45090), "-R$ 450,90")
    checar("formata milhao", formatar_reais(123456789), "R$ 1.234.567,89")

    checar("le formato brasileiro", parse_centavos("1.234,56"), 123456)
    checar("le formato americano", parse_centavos("1234.56"), 123456)
    checar("le reais inteiros", parse_centavos("1234"), 123400)
    checar("le com R$ na frente", parse_centavos("R$ 89,90"), 8990)
    checar("le float", parse_centavos(44.90), 4490)
    checar("le negativo", parse_centavos("-50,00"), -5000)
    checar_erro("recusa texto vazio", lambda: parse_centavos(""), ValueError)


def testar_parcelas() -> None:
    secao("Divisao de parcelas (nao pode perder centavo)")

    p3 = dividir_parcelas(10000, 3)
    checar("100,00 em 3x", p3, [3334, 3333, 3333])
    checar("soma de 3x fecha exata", sum(p3), 10000)

    p7 = dividir_parcelas(100000, 7)
    checar("1.000,00 em 7x soma exata", sum(p7), 100000)
    checar("1.000,00 em 7x primeira parcela", p7[0], 14286)

    checar("1x devolve o total", dividir_parcelas(5000, 1), [5000])
    checar_erro("recusa zero parcelas", lambda: dividir_parcelas(100, 0), ValueError)

    for total in (1, 99, 100, 1234567):
        for n in (1, 2, 3, 6, 10, 12, 18, 24):
            checar(f"{total}c em {n}x soma exata", sum(dividir_parcelas(total, n)), total)


def testar_calendario() -> None:
    secao("Calendario (dia 29 em fevereiro nao pode explodir)")

    checar("dia 29 em fevereiro nao bissexto", clamp_dia(2026, 2, 29), date(2026, 2, 28))
    checar("dia 29 em fevereiro bissexto", clamp_dia(2028, 2, 29), date(2028, 2, 29))
    checar("dia 31 em abril", clamp_dia(2026, 4, 31), date(2026, 4, 30))
    checar("dia normal passa direto", clamp_dia(2026, 9, 15), date(2026, 9, 15))

    checar("dezembro + 1 mes", somar_meses(2026, 12, 1), (2027, 1))
    checar("janeiro - 1 mes", somar_meses(2026, 1, -1), (2025, 12))
    checar("janeiro - 2 meses", somar_meses(2026, 1, -2), (2025, 11))
    checar("setembro + 12 meses", somar_meses(2026, 9, 12), (2027, 9))


def testar_ciclo_fatura() -> None:
    secao("Ciclo da fatura (fecha dia 29, vence dia 3)")

    c = ciclo_fatura("2026-10", 29, 3)
    checar("fatura out/2026 vence", c.vencimento, date(2026, 10, 3))
    checar("fatura out/2026 fecha", c.fechamento, date(2026, 9, 29))
    checar("fatura out/2026 abre", c.inicio, date(2026, 8, 30))

    checar("compra 08/09 -> fatura out", fatura_de_compra(date(2026, 9, 8), 29), "2026-10")
    checar("compra 29/09 (dia do corte) -> out", fatura_de_compra(date(2026, 9, 29), 29), "2026-10")
    checar("compra 30/09 (pos corte) -> nov", fatura_de_compra(date(2026, 9, 30), 29), "2026-11")
    checar("compra 30/08 -> out", fatura_de_compra(date(2026, 8, 30), 29), "2026-10")
    checar("compra 29/08 -> set", fatura_de_compra(date(2026, 8, 29), 29), "2026-09")
    checar("compra 31/12 -> fev do ano seguinte", fatura_de_compra(date(2026, 12, 31), 29), "2027-02")

    # A propriedade que importa: toda data cai em exatamente UMA fatura.
    # Sem isso, uma compra sumiria ou seria cobrada duas vezes.
    d = date(2026, 1, 1)
    problemas = []
    while d < date(2029, 1, 1):
        ref = fatura_de_compra(d, 29)
        if not ciclo_fatura(ref, 29, 3).contem(d):
            problemas.append(d.isoformat())
        d = date.fromordinal(d.toordinal() + 1)
    checar("3 anos de datas caem na fatura certa", problemas, [])

    # E as janelas nao se sobrepoem nem deixam buraco (inclusive em fevereiro).
    buracos = []
    ano, mes = 2026, 1
    anterior = None
    for _ in range(36):
        c = ciclo_fatura(f"{ano:04d}-{mes:02d}", 29, 3)
        if anterior and c.inicio.toordinal() != anterior.toordinal() + 1:
            buracos.append(c.ref)
        anterior = c.fechamento
        ano, mes = somar_meses(ano, mes, 1)
    checar("36 ciclos encaixados sem buraco", buracos, [])


# ---------------------------------------------------------------------------
# Cenario ponta a ponta em banco temporario
# ---------------------------------------------------------------------------


def testar_cenario() -> None:
    secao("Cenario completo: setembro/2026")

    # Congela "hoje" em 05/10/2026: setembro inteiro ja passou e a fatura
    # que venceu em 03/10 pode ser paga. Sem congelar, o resultado dos
    # testes mudaria conforme o dia em que fossem rodados.
    regras.fixar_hoje(date(2026, 10, 5))

    conn = db.conectar()
    db.inicializar(conn)

    cats = {c["nome"]: c["id"] for c in repositorio.listar_categorias(conn)}

    # --- Setup: 2.000 na conta, 800 na caixinha, fatura aberta de 300 -------
    repositorio.aplicar_setup(
        conn,
        {
            "saldo_conta": 200000,
            "data_corte": "2026-09-01",
            "reservas": [
                {"nome": "Reserva", "tipo": "CAIXINHA", "saldo": 80000},
                {"nome": "MXRF11", "tipo": "FUNDO", "saldo": 150000},
            ],
            "fatura_aberta": {"valor": 30000, "responsavel": "PESSOAL"},
        },
    )
    cfg = regras.carregar_config(conn)
    checar("setup marcado como concluido", cfg.setup_concluido, True)
    checar("saldo inicial gravado", cfg.saldo_inicial_conta, 200000)

    conta = regras.saldo_conta(conn, cfg)
    checar("saldo da conta apos setup", conta["saldo"], 200000)

    reservas = {r["nome"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}
    checar("caixinha apos setup", reservas["Reserva"], 80000)
    checar("fundo apos setup", reservas["MXRF11"], 150000)

    # --- Gasto no credito: nao mexe no saldo, entra na fatura --------------
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-09-08",
            "descricao": "Mercado",
            "valor": 24000,
            "responsavel": "PESSOAL",
            "natureza": "AVULSO",
            "meio": "CREDITO",
            "categoria_id": cats["Mercado"],
        },
    )
    checar(
        "credito NAO altera o saldo da conta",
        regras.saldo_conta(conn, cfg)["saldo"],
        200000,
    )

    # --- Gasto no debito: sai do saldo na hora ----------------------------
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-09-09",
            "descricao": "Pix padaria",
            "valor": 5000,
            "responsavel": "PESSOAL",
            "natureza": "AVULSO",
            "meio": "DEBITO",
            "categoria_id": cats["Alimentacao"],
        },
    )
    checar("debito sai do saldo", regras.saldo_conta(conn, cfg)["saldo"], 195000)

    # --- Entrada: salario -------------------------------------------------
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-09-05",
            "descricao": "Salario",
            "valor": 500000,
            "fluxo": "ENTRADA",
            "responsavel": "PESSOAL",
            "natureza": "AVULSO",
            "meio": "DEBITO",
        },
    )
    checar("entrada soma no saldo", regras.saldo_conta(conn, cfg)["saldo"], 695000)

    # --- Gastos de terceiros e Genesys no credito -------------------------
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-09-10",
            "descricao": "Uber do Joao",
            "valor": 8200,
            "responsavel": "TERCEIROS",
            "natureza": "AVULSO",
            "meio": "CREDITO",
            "categoria_id": cats["Transporte"],
        },
    )
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-09-11",
            "descricao": "Combustivel obra",
            "valor": 72300,
            "responsavel": "GENESYS",
            "natureza": "AVULSO",
            "meio": "CREDITO",
            "categoria_id": cats["Transporte"],
        },
    )

    # --- Gasto fixo cadastrado uma vez ------------------------------------
    repositorio.criar_recorrencia(
        conn,
        {
            "descricao": "Netflix",
            "valor": 4490,
            "dia": 15,
            "responsavel": "PESSOAL",
            "meio": "CREDITO",
            "categoria_id": cats["Assinaturas"],
            "inicio_ref": "2026-09",
        },
    )
    criados = regras.materializar_recorrencias(conn, cfg, "2026-11")
    checar("fixo gerado para set, out e nov", criados, 3)

    de_novo = regras.materializar_recorrencias(conn, cfg, "2026-11")
    checar("materializar de novo nao duplica", de_novo, 0)

    # --- Parcelamento: 1.200 em 10x --------------------------------------
    parc = repositorio.criar_parcelamento(
        conn,
        {
            "descricao": "Notebook",
            "valor": 120000,
            "num_parcelas": 10,
            "data": "2026-09-12",
            "responsavel": "GENESYS",
            "meio": "CREDITO",
            "categoria_id": cats["Compras"],
        },
    )
    checar("10 parcelas geradas", parc["parcelas_geradas"], 10)

    parcelas = repositorio.listar_lancamentos(conn, {"natureza": "PARCELAMENTO", "limite": 50})
    checar("soma das parcelas fecha o total", sum(p["valor"] for p in parcelas), 120000)
    checar(
        "cada parcela numa fatura diferente",
        len({p["fatura_ref"] for p in parcelas}),
        10,
    )
    checar(
        "cada parcela num mes diferente",
        len({p["data"][:7] for p in parcelas}),
        10,
    )

    # --- Fatura de outubro (compras de 30/08 a 29/09) --------------------
    fatura = regras.montar_fatura(conn, cfg, "2026-10")
    esperado = (
        30000    # fatura aberta trazida no setup
        + 24000  # mercado
        + 8200   # uber do Joao
        + 72300  # combustivel Genesys
        + 4490   # netflix
        + 12000  # parcela 1/10 do notebook
    )
    checar("total da fatura de outubro", fatura["total"], esperado)
    checar("fatura vence 03/10", fatura["ciclo"]["vencimento"], "2026-10-03")

    checar("parte PESSOAL da fatura", fatura["por_responsavel"]["PESSOAL"], 30000 + 24000 + 4490)
    checar("parte TERCEIROS da fatura", fatura["por_responsavel"]["TERCEIROS"], 8200)
    checar("parte GENESYS da fatura", fatura["por_responsavel"]["GENESYS"], 72300 + 12000)
    checar(
        "as tres partes somam o total",
        sum(fatura["por_responsavel"].values()),
        fatura["total"],
    )
    # Em 05/10 a fatura de outubro ja fechou (29/09) e ainda nao foi paga.
    checar("fatura fechada e nao paga", fatura["status"], "FECHADA")

    # --- Pagar a fatura tirando da caixinha ------------------------------
    # Este e o fluxo central do app: o dinheiro sai da CAIXINHA, e o saldo
    # da conta nao pode se mover por causa disso.
    saldo_antes = regras.saldo_conta(conn, cfg)["saldo"]
    repositorio.criar_mov_reserva(
        conn,
        {"reserva_id": 1, "data": "2026-09-20", "tipo": "DEPOSITO", "valor": 100000},
    )
    checar(
        "deposito na caixinha tira da conta",
        regras.saldo_conta(conn, cfg)["saldo"],
        saldo_antes - 100000,
    )

    saldo_antes = regras.saldo_conta(conn, cfg)["saldo"]
    reserva_antes = {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1]

    repositorio.pagar_fatura(
        conn,
        {"fatura_ref": "2026-10", "data": "2026-10-03", "valor": 50000, "reserva_id": 1},
    )

    checar(
        "pagar fatura pela caixinha NAO move o saldo da conta",
        regras.saldo_conta(conn, cfg)["saldo"],
        saldo_antes,
    )
    reserva_depois = {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1]
    checar("pagamento saiu da caixinha", reserva_depois, reserva_antes - 50000)

    fatura = regras.montar_fatura(conn, cfg, "2026-10")
    checar("fatura marcada como parcial", fatura["status"], "PARCIAL")
    checar("valor pago registrado", fatura["pago"], 50000)
    checar("restante da fatura", fatura["restante"], esperado - 50000)

    # --- Pagar direto do saldo da conta ----------------------------------
    saldo_antes = regras.saldo_conta(conn, cfg)["saldo"]
    repositorio.pagar_fatura(
        conn, {"fatura_ref": "2026-10", "data": "2026-10-03", "valor": 10000}
    )
    checar(
        "pagar sem caixinha sai do saldo da conta",
        regras.saldo_conta(conn, cfg)["saldo"],
        saldo_antes - 10000,
    )

    # --- Desfazer o pagamento pela caixinha devolve o dinheiro -----------
    reserva_antes = {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1]
    pagamentos = regras.montar_fatura(conn, cfg, "2026-10")["pagamentos"]
    pago_da_caixinha = next(p for p in pagamentos if p["reserva_id"] == 1)
    repositorio.excluir_pagamento(conn, pago_da_caixinha["id"])
    reserva_depois = {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1]
    checar(
        "apagar pagamento desfaz o saque da caixinha",
        reserva_depois,
        reserva_antes + 50000,
    )

    # --- Rendimento cresce a caixinha sem tocar na conta ------------------
    saldo_antes = regras.saldo_conta(conn, cfg)["saldo"]
    repositorio.criar_mov_reserva(
        conn,
        {"reserva_id": 1, "data": "2026-09-30", "tipo": "RENDIMENTO", "valor": 412},
    )
    checar(
        "rendimento nao mexe na conta",
        regras.saldo_conta(conn, cfg)["saldo"],
        saldo_antes,
    )

    # --- Lancamento FUTURO nao pode mexer no saldo de hoje ---------------
    # Este e o bug que a inspecao visual pegou: ao cadastrar o aluguel como
    # gasto fixo, o app gerava tambem a parcela do mes seguinte, e o saldo
    # de HOJE caia pelo aluguel que ainda nao tinha sido pago.
    secao("Saldo conta o realizado, nao o previsto")

    saldo_antes = regras.saldo_conta(conn, cfg)["saldo"]
    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-10-28",  # depois do "hoje" congelado (05/10)
            "descricao": "Aluguel de outubro",
            "valor": 145000,
            "responsavel": "PESSOAL",
            "natureza": "AVULSO",
            "meio": "DEBITO",
        },
    )
    conta = regras.saldo_conta(conn, cfg)
    checar("gasto futuro NAO derruba o saldo de hoje", conta["saldo"], saldo_antes)
    checar("gasto futuro aparece como 'a sair no mes'", conta["a_sair_no_mes"], 145000)
    checar(
        "previsao de fim do mes desconta o futuro",
        conta["saldo_previsto_fim_do_mes"],
        saldo_antes - 145000,
    )

    repositorio.criar_lancamento(
        conn,
        {
            "data": "2026-10-30",
            "descricao": "Freelance a receber",
            "valor": 90000,
            "fluxo": "ENTRADA",
            "responsavel": "PESSOAL",
            "natureza": "AVULSO",
            "meio": "DEBITO",
        },
    )
    conta = regras.saldo_conta(conn, cfg)
    checar("entrada futura NAO sobe o saldo de hoje", conta["saldo"], saldo_antes)
    checar("entrada futura aparece como 'a entrar no mes'", conta["a_entrar_no_mes"], 90000)
    checar(
        "previsao considera saidas e entradas futuras",
        conta["saldo_previsto_fim_do_mes"],
        saldo_antes - 145000 + 90000,
    )

    # Movimentacao futura de caixinha tambem nao conta.
    reserva_antes = {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1]
    conn.execute(
        "INSERT INTO mov_reserva (reserva_id, data, tipo, valor, descricao, criado_em) "
        "VALUES (1, '2026-10-25', 'DEPOSITO', 50000, 'Aporte programado', '2026-10-05')"
    )
    checar(
        "deposito futuro nao infla a caixinha",
        {r["id"]: r["saldo"] for r in regras.saldos_reservas(conn, cfg)}[1],
        reserva_antes,
    )
    conn.execute("DELETE FROM mov_reserva WHERE descricao = 'Aporte programado'")

    # Limpa os dois lancamentos futuros para nao sujar os totais adiante.
    conn.execute("DELETE FROM lancamento WHERE data IN ('2026-10-28', '2026-10-30')")

    # --- Dashboard do mes ------------------------------------------------
    resumo = regras.resumo_mes(conn, cfg, "2026-09")
    # Sem os 30000 da fatura em aberto do setup: aquilo foi gasto em agosto,
    # entra na fatura a pagar mas nao conta como gasto de setembro.
    gastos_setembro = 24000 + 5000 + 8200 + 72300 + 4490 + 12000
    checar("total de saidas em setembro", resumo["total_saidas"], gastos_setembro)
    # O saldo de fatura do setup tem que estar nos DOIS lados certos:
    # dentro da fatura a pagar, fora do relatorio de gasto do mes.
    checar(
        "saldo do setup NAO aparece nas tabelas do mes",
        [
            i
            for t in resumo["tabelas"].values()
            for g in t["grupos"]
            for i in g["itens"]
            if i["origem"] == "SETUP"
        ],
        [],
    )
    checar(
        "saldo do setup APARECE na fatura a pagar",
        sum(
            i["valor"]
            for i in regras.montar_fatura(conn, cfg, "2026-10")["itens"]
            if i["origem"] == "SETUP"
        ),
        30000,
    )
    checar("total de entradas em setembro", resumo["total_entradas"], 500000)
    checar(
        "categorias somam o total de saidas",
        sum(c["total"] for c in resumo["por_categoria"]),
        gastos_setembro,
    )
    checar(
        "as tres tabelas somam o total de saidas",
        sum(t["total_saidas"] for t in resumo["tabelas"].values()),
        gastos_setembro,
    )
    checar(
        "tabela pessoal agrupa em 3 naturezas",
        [g["natureza"] for g in resumo["tabelas"]["PESSOAL"]["grupos"]],
        ["FIXO", "PARCELAMENTO", "AVULSO"],
    )

    # --- Regras de protecao ----------------------------------------------
    secao("Regras de protecao")

    checar_erro(
        "recusa lancamento antes de setembro/2026",
        lambda: repositorio.criar_lancamento(
            conn,
            {
                "data": "2026-08-15",
                "descricao": "Gasto antigo",
                "valor": 1000,
                "responsavel": "PESSOAL",
                "meio": "DEBITO",
            },
        ),
        repositorio.ErroValidacao,
    )
    checar_erro(
        "recusa valor zero",
        lambda: repositorio.criar_lancamento(
            conn,
            {"data": "2026-09-10", "descricao": "X", "valor": 0, "responsavel": "PESSOAL"},
        ),
        repositorio.ErroValidacao,
    )
    checar_erro(
        "recusa responsavel inventado",
        lambda: repositorio.criar_lancamento(
            conn,
            {"data": "2026-09-10", "descricao": "X", "valor": 100, "responsavel": "CHEFE"},
        ),
        repositorio.ErroValidacao,
    )
    checar_erro(
        "recusa saque maior que a caixinha",
        lambda: repositorio.criar_mov_reserva(
            conn,
            {"reserva_id": 1, "data": "2026-09-25", "tipo": "SAQUE", "valor": 99999999},
        ),
        repositorio.ErroValidacao,
    )
    checar_erro(
        "recusa pagar fatura com caixinha sem saldo",
        lambda: repositorio.pagar_fatura(
            conn,
            {
                "fatura_ref": "2026-10",
                "data": "2026-10-03",
                "valor": 99999999,
                "reserva_id": 2,
            },
        ),
        repositorio.ErroValidacao,
    )
    checar_erro(
        "recusa parcelamento pela rota de lancamento simples",
        lambda: repositorio.criar_lancamento(
            conn,
            {
                "data": "2026-09-10",
                "descricao": "X",
                "valor": 100,
                "responsavel": "PESSOAL",
                "natureza": "PARCELAMENTO",
            },
        ),
        repositorio.ErroValidacao,
    )

    # --- Parcelamento em andamento (o caso do setup) ---------------------
    secao("Parcelamento que ja estava em andamento")

    em_andamento = repositorio.criar_parcelamento(
        conn,
        {
            "descricao": "Celular",
            "valor_parcela": 20000,
            "num_parcelas": 10,
            "parcela_inicial": 4,
            "responsavel": "PESSOAL",
            "meio": "CREDITO",
            "data": "2026-09-10",
        },
    )
    checar("gera so as 7 parcelas que faltam", em_andamento["parcelas_geradas"], 7)

    celular = [
        p
        for p in repositorio.listar_lancamentos(conn, {"natureza": "PARCELAMENTO", "limite": 100})
        if p["descricao"].startswith("Celular")
    ]
    checar("primeira parcela gerada e a 4", min(p["parcela_num"] for p in celular), 4)
    checar("ultima parcela gerada e a 10", max(p["parcela_num"] for p in celular), 10)
    checar("descricao mostra 4/10", sorted(celular, key=lambda p: p["parcela_num"])[0]["descricao"], "Celular (4/10)")

    # --- Backup e restauracao --------------------------------------------
    secao("Backup e portabilidade")

    caminho = db.exportar_backup(conn)
    checar("backup criado", caminho.is_file(), True)
    checar("backup nao esta vazio", caminho.stat().st_size > 0, True)

    saldo_original = regras.saldo_conta(conn, cfg)["saldo"]
    conn.close()

    db.importar_backup(caminho)
    conn = db.conectar()
    db.inicializar(conn)
    cfg = regras.carregar_config(conn)
    checar(
        "saldo intacto depois de restaurar o backup",
        regras.saldo_conta(conn, cfg)["saldo"],
        saldo_original,
    )

    checar_erro(
        "recusa importar arquivo que nao e do NuControle",
        lambda: db.importar_backup(Path(__file__)),
        Exception,
    )

    conn.close()
    regras.fixar_hoje(None)


def main() -> int:
    print(f"\nNuControle -- testes (banco temporario em {_TMP})")

    testar_dinheiro()
    testar_parcelas()
    testar_calendario()
    testar_ciclo_fatura()
    testar_cenario()

    print("\n" + "=" * 60)
    if _falhas:
        print(f"  {len(_falhas)} de {_total} verificacoes FALHARAM:")
        for f in _falhas:
            print(f"    - {f}")
        print("=" * 60 + "\n")
        return 1

    print(f"  Todas as {_total} verificacoes passaram.")
    print("=" * 60 + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
