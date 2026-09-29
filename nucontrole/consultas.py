"""
Tudo que le o banco e monta o que as telas mostram.

Regras de saldo (as mesmas da v1, que custaram bug para acertar):

  - Saldo e o REALIZADO, nao o previsto. Fixos e parcelas futuras ja existem
    no banco, mas so mexem no saldo quando a data chega.
  - Compra no credito nao move o saldo: vira fatura, e o saldo so muda no dia
    em que a fatura e paga.
  - Nada antes da DATA DE INICIO (Ajustes) mexe no saldo, porque o saldo
    inicial que voce digitou ja continha esse passado.
  - O saldo sai inteiro da SUA conta mesmo quando a compra e dividida: a
    divisao diz de quem e o gasto, nao de onde saiu o dinheiro.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta

from . import calendario as cal
from .base import Config, ErroValidacao, hoje, linhas
from .escrita import ID_EU

NATUREZAS = ("FIXO", "PARCELAMENTO", "AVULSO")


def _soma(conn: sqlite3.Connection, sql: str, params: tuple) -> int:
    return conn.execute(sql, params).fetchone()[0] or 0


# ---------------------------------------------------------------------------
# Cadastros
# ---------------------------------------------------------------------------


def donos(conn: sqlite3.Connection) -> list[dict]:
    return linhas(conn.execute(
        "SELECT d.*, (SELECT COUNT(*) FROM compra_parte p WHERE p.dono_id = d.id) AS usos "
        "FROM dono d ORDER BY d.tipo != 'EU', d.ativo DESC, d.nome"
    ))


def categorias(conn: sqlite3.Connection) -> list[dict]:
    return linhas(conn.execute("SELECT * FROM categoria ORDER BY nome"))


def estado(conn: sqlite3.Connection) -> dict:
    cfg = Config.ler(conn)
    h = hoje()
    return {
        "hoje": h.isoformat(),
        "mes_atual": cal.ref_de(h),
        "fatura_atual": cfg.fatura_de(h),
        "config": cfg.json(),
        "donos": donos(conn),
        "categorias": categorias(conn),
    }


def compra(conn: sqlite3.Connection, compra_id: int) -> dict:
    """Uma compra do jeito que o formulario de edicao precisa."""
    c = conn.execute("SELECT * FROM compra WHERE id = ?", (compra_id,)).fetchone()
    if c is None:
        raise ErroValidacao("Lançamento não encontrado.")
    dados = dict(c)
    dados["partes"] = linhas(conn.execute(
        "SELECT dono_id, valor FROM compra_parte WHERE compra_id = ? ORDER BY dono_id != 1, rowid",
        (compra_id,),
    ))
    return dados


# ---------------------------------------------------------------------------
# Conta
# ---------------------------------------------------------------------------


def _lanc_debito(conn: sqlite3.Connection, fluxo: str, desde: str, ate: str) -> int:
    """Soma dos lancamentos no debito com data em (desde, ate]."""
    return _soma(
        conn,
        "SELECT SUM(l.valor) FROM lancamento l JOIN compra c ON c.id = l.compra_id "
        "WHERE c.fluxo = ? AND c.meio = 'DEBITO' AND l.data > ? AND l.data <= ?",
        (fluxo, desde, ate),
    )


def _saldo_ate(conn: sqlite3.Connection, cfg: Config, ate: date) -> dict:
    """Saldo da conta somando tudo que tem data entre o inicio e `ate`.

    Com `ate` = hoje e o saldo realizado. Com `ate` no futuro inclui o que ja
    esta agendado (fixos, parcelas no debito, pagamentos com data futura) --
    mas NAO as faturas ainda nao pagas; quem precisa delas soma a parte.
    """
    desde = (cfg.data_inicio - timedelta(days=1)).isoformat()
    a = ate.isoformat()
    movs = dict(conn.execute(
        "SELECT tipo, SUM(valor) FROM mov_reserva WHERE data > ? AND data <= ? GROUP BY tipo",
        (desde, a),
    ).fetchall())
    p = {
        "entradas": _lanc_debito(conn, "ENTRADA", desde, a),
        "saidas_debito": _lanc_debito(conn, "SAIDA", desde, a),
        "pagamentos_fatura": _soma(
            conn, "SELECT SUM(valor) FROM pagamento_fatura WHERE data > ? AND data <= ?", (desde, a)
        ),
        "depositos": movs.get("DEPOSITO", 0),
        "saques": movs.get("SAQUE", 0),
    }
    p["saldo"] = (
        cfg.saldo_inicial + p["entradas"] - p["saidas_debito"]
        - p["pagamentos_fatura"] - p["depositos"] + p["saques"]
    )
    return p


def conta(conn: sqlite3.Connection, cfg: Config, ref: str | None = None) -> dict:
    """Saldo de hoje e o que acontece com ele no mes `ref` (padrao: o atual).

    Para o mes atual ou um mes futuro, `previsao_fim_mes` e o saldo de hoje mais
    tudo o que esta agendado ate o ultimo dia de `ref`, menos as faturas em
    aberto que vencem ate la. Para um mes que ja passou, e o saldo realizado no
    ultimo dia dele.
    """
    h = hoje()
    ref = ref or cal.ref_de(h)
    ano, m = cal.partes(ref)
    inicio_mes = date(ano, m, 1)
    fim_mes = cal.clamp_dia(ano, m, 31)

    atual = _saldo_ate(conn, cfg, h)
    passado = fim_mes <= h

    # O que mexe no saldo DENTRO do mes escolhido, a partir de hoje.
    apos = max(h, inicio_mes - timedelta(days=1)).isoformat()
    a_entrar = 0 if passado else _lanc_debito(conn, "ENTRADA", apos, fim_mes.isoformat())
    a_sair_debito = 0 if passado else _lanc_debito(conn, "SAIDA", apos, fim_mes.isoformat())
    # A fatura e identificada pelo mes em que vence: a que vence em `ref` tem ref == ref.
    fatura_mes = _resumo_fatura(conn, cfg, ref)
    a_sair_fatura = 0 if passado or fatura_mes["status"] == "anterior" else fatura_mes["restante"]

    if passado:
        previsao = _saldo_ate(conn, cfg, fim_mes)["saldo"]
    else:
        # Toda fatura ainda devida que vence ate o fim do mes (inclusive vencidas).
        em_aberto = sum(
            f["restante"] for f in faturas(conn)
            if f["ref"] <= ref and f["status"] in ("aberta", "fechada", "vencida", "futura")
        )
        previsao = _saldo_ate(conn, cfg, fim_mes)["saldo"] - em_aberto

    return {
        **atual,
        "ref": ref,
        "mes_passado": passado,
        "a_entrar_mes": a_entrar,
        "a_sair_mes": a_sair_debito + a_sair_fatura,
        "a_sair_debito": a_sair_debito,
        "a_sair_fatura": a_sair_fatura,
        "previsao_fim_mes": previsao,
    }


# ---------------------------------------------------------------------------
# Caixinhas e fundos
# ---------------------------------------------------------------------------


def reservas(conn: sqlite3.Connection) -> dict:
    lista = []
    for r in linhas(conn.execute("SELECT * FROM reserva ORDER BY tipo, nome")):
        por_tipo = dict(conn.execute(
            "SELECT tipo, SUM(valor) FROM mov_reserva WHERE reserva_id = ? GROUP BY tipo",
            (r["id"],),
        ).fetchall())
        dep, saq, rend = (por_tipo.get(t, 0) for t in ("DEPOSITO", "SAQUE", "RENDIMENTO"))
        r["depositado"] = dep
        r["sacado"] = saq
        r["rendimentos"] = rend
        r["saldo"] = r["saldo_inicial"] + dep - saq + rend
        lista.append(r)
    movs = linhas(conn.execute(
        "SELECT m.*, r.nome AS reserva_nome, r.tipo AS reserva_tipo FROM mov_reserva m "
        "JOIN reserva r ON r.id = m.reserva_id ORDER BY m.data DESC, m.id DESC LIMIT 200"
    ))
    return {
        "reservas": lista,
        "movimentacoes": movs,
        "total": sum(r["saldo"] for r in lista),
        "total_caixinhas": sum(r["saldo"] for r in lista if r["tipo"] == "CAIXINHA"),
        "total_fundos": sum(r["saldo"] for r in lista if r["tipo"] == "FUNDO"),
    }


# ---------------------------------------------------------------------------
# Lancamentos com a divisao
# ---------------------------------------------------------------------------


_SQL_LANC = """
SELECT l.id, l.compra_id, l.data, l.ref, l.valor, l.fatura_ref,
       l.parcela_num, l.parcela_total,
       c.descricao, c.fluxo, c.natureza, c.meio, c.fim_ref,
       c.categoria_id, cat.nome AS categoria, cat.cor AS categoria_cor
FROM lancamento l
JOIN compra c ON c.id = l.compra_id
LEFT JOIN categoria cat ON cat.id = c.categoria_id
"""


def _com_partes(conn: sqlite3.Connection, lancs: list[dict]) -> list[dict]:
    """Anexa a cada lancamento a lista de partes [{dono_id, valor}]."""
    if not lancs:
        return lancs
    ids = [l["id"] for l in lancs]
    partes: dict[int, list[dict]] = {i: [] for i in ids}
    marcadores = ",".join("?" * len(ids))
    for p in conn.execute(
        f"SELECT lancamento_id, dono_id, valor FROM lancamento_parte "
        f"WHERE lancamento_id IN ({marcadores}) AND valor > 0 "
        f"ORDER BY dono_id != 1, rowid",
        ids,
    ):
        partes[p["lancamento_id"]].append({"dono_id": p["dono_id"], "valor": p["valor"]})
    for l in lancs:
        l["partes"] = partes[l["id"]]
    return lancs


def _por_categoria(itens: list[dict], campo_valor: str) -> list[dict]:
    grupos: dict = {}
    for i in itens:
        chave = i["categoria_id"]
        g = grupos.setdefault(chave, {
            "categoria_id": chave,
            "nome": i["categoria"] or "Sem categoria",
            "cor": i["categoria_cor"] or "#78909C",
            "valor": 0,
        })
        g["valor"] += i[campo_valor]
    return sorted(grupos.values(), key=lambda g: -g["valor"])


# ---------------------------------------------------------------------------
# Mes: uma aba por dono
# ---------------------------------------------------------------------------


def mes(conn: sqlite3.Connection, ref: str) -> dict:
    """Gastos do mes do calendario, separados por dono.

    Cada dono ve SO a parte dele de cada compra, com a informacao de com quem
    ela foi dividida. Uma compra de R$ 300 dividida em 3 aparece como R$ 100
    nas tres abas.
    """
    cal.partes(ref)
    lancs = _com_partes(conn, linhas(conn.execute(
        _SQL_LANC + " WHERE l.ref = ? ORDER BY l.data, l.id", (ref,)
    )))
    saidas = [l for l in lancs if l["fluxo"] == "SAIDA"]
    entradas = [l for l in lancs if l["fluxo"] == "ENTRADA"]
    h = hoje().isoformat()

    todos_donos = donos(conn)
    com_gasto = {p["dono_id"] for l in saidas for p in l["partes"]}
    abas = []
    for d in todos_donos:
        if not d["ativo"] and d["id"] not in com_gasto:
            continue
        itens = []
        for l in saidas:
            minha = next((p["valor"] for p in l["partes"] if p["dono_id"] == d["id"]), 0)
            if minha:
                itens.append({**l, "valor_dono": minha, "futuro": l["data"] > h})
        grupos = {
            n: {
                "itens": [i for i in itens if i["natureza"] == n],
                "total": sum(i["valor_dono"] for i in itens if i["natureza"] == n),
            }
            for n in NATUREZAS
        }
        abas.append({
            "dono": d,
            "total": sum(i["valor_dono"] for i in itens),
            "total_credito": sum(i["valor_dono"] for i in itens if i["meio"] == "CREDITO"),
            "total_debito": sum(i["valor_dono"] for i in itens if i["meio"] == "DEBITO"),
            "grupos": grupos,
            "categorias": _por_categoria(itens, "valor_dono"),
            "quantidade": len(itens),
        })

    return {
        "ref": ref,
        "rotulo": cal.rotulo(ref),
        "abas": abas,
        "total_saidas": sum(l["valor"] for l in saidas),
        "entradas": {
            "itens": [{**l, "futuro": l["data"] > h} for l in entradas],
            "total": sum(l["valor"] for l in entradas),
        },
    }


# ---------------------------------------------------------------------------
# Fatura: resumo por dono
# ---------------------------------------------------------------------------


def _status(total: int, pago: int, ciclo: cal.Ciclo, cfg: Config) -> str:
    h = hoje()
    if total == 0 and pago == 0:
        return "vazia"
    if total > 0 and pago >= total:
        return "paga"
    # Venceu antes de o controle comecar: ja foi paga fora do app, nao e pendencia.
    if ciclo.vencimento < cfg.data_inicio:
        return "anterior"
    if h < ciclo.inicio:
        return "futura"
    if h <= ciclo.fechamento:
        return "aberta"
    if h > ciclo.vencimento:
        return "vencida"
    return "fechada"


def _resumo_fatura(conn: sqlite3.Connection, cfg: Config, ref: str) -> dict:
    total = _soma(conn, "SELECT SUM(valor) FROM lancamento WHERE fatura_ref = ?", (ref,))
    pago = _soma(conn, "SELECT SUM(valor) FROM pagamento_fatura WHERE fatura_ref = ?", (ref,))
    ciclo = cfg.ciclo(ref)
    return {
        **ciclo.json(),
        "total": total,
        "pago": pago,
        "restante": max(total - pago, 0),
        "status": _status(total, pago, ciclo, cfg),
    }


def fatura(conn: sqlite3.Connection, ref: str) -> dict:
    cal.partes(ref)
    cfg = Config.ler(conn)
    resumo = _resumo_fatura(conn, cfg, ref)
    itens = _com_partes(conn, linhas(conn.execute(
        _SQL_LANC + " WHERE l.fatura_ref = ? ORDER BY l.data, l.id", (ref,)
    )))

    por_dono: dict[int, dict] = {}
    for l in itens:
        for p in l["partes"]:
            g = por_dono.setdefault(p["dono_id"], {"dono_id": p["dono_id"], "valor": 0, "itens": 0})
            g["valor"] += p["valor"]
            g["itens"] += 1
    resumo_donos = sorted(por_dono.values(), key=lambda g: (g["dono_id"] != ID_EU, -g["valor"]))

    return {
        **resumo,
        "itens": itens,
        "por_dono": resumo_donos,
        "de_terceiros": sum(g["valor"] for g in resumo_donos if g["dono_id"] != ID_EU),
        "pagamentos": linhas(conn.execute(
            "SELECT * FROM pagamento_fatura WHERE fatura_ref = ? ORDER BY data, id", (ref,)
        )),
    }


def faturas(conn: sqlite3.Connection, incluir: str | None = None) -> list[dict]:
    """Todas as faturas com algum lancamento ou pagamento, mais a atual e `incluir`."""
    cfg = Config.ler(conn)
    atual = cfg.fatura_de(hoje())
    refs = {atual}
    if incluir:
        cal.partes(incluir)
        refs.add(incluir)
    refs.update(r[0] for r in conn.execute(
        "SELECT DISTINCT fatura_ref FROM lancamento WHERE fatura_ref IS NOT NULL"
    ))
    refs.update(r[0] for r in conn.execute("SELECT DISTINCT fatura_ref FROM pagamento_fatura"))
    return [_resumo_fatura(conn, cfg, r) for r in sorted(refs)]


# ---------------------------------------------------------------------------
# Visao geral
# ---------------------------------------------------------------------------


def visao_geral(conn: sqlite3.Connection, ref: str | None = None) -> dict:
    """Resumo do mes `ref` (padrao: o atual). O saldo e sempre o de hoje; a
    previsao, os gastos e a fatura em destaque sao os do mes escolhido."""
    cfg = Config.ler(conn)
    h = hoje()
    mes_atual = cal.ref_de(h)
    ref = ref or mes_atual
    c = conta(conn, cfg, ref)
    res = reservas(conn)
    m = mes(conn, ref)

    todas = faturas(conn)
    pendentes = [
        f for f in todas
        if f["status"] in ("fechada", "vencida") and f["restante"] > 0
    ]
    if ref == mes_atual:
        # A fatura que pede atencao: a mais antiga fechada e nao paga; senao a aberta.
        atual = cfg.fatura_de(h)
        destaque = pendentes[0]["ref"] if pendentes else atual
    else:
        destaque = ref  # a fatura que vence no mes escolhido
    destaque = fatura(conn, destaque)
    destaque.pop("itens")

    return {
        "ref": ref,
        "rotulo": cal.rotulo(ref),
        "mes_atual": ref == mes_atual,
        "conta": c,
        "reservas": {k: res[k] for k in ("total", "total_caixinhas", "total_fundos")},
        "patrimonio": c["saldo"] + res["total"],
        "fatura": destaque,
        "faturas_pendentes": len(pendentes),
        "gastos_por_dono": [
            {"dono": a["dono"], "total": a["total"]} for a in m["abas"] if a["total"] > 0
        ],
        "total_gasto_mes": m["total_saidas"],
        "entradas_mes": m["entradas"]["total"],
        "categorias_eu": next(
            (a["categorias"] for a in m["abas"] if a["dono"]["id"] == ID_EU), []
        ),
    }
