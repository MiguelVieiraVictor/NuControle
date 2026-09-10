"""
Regras de negocio do NuControle.

Nada aqui fala HTTP e nada aqui monta HTML. Sao so contas sobre o banco.
Isso e proposital: quando o front virar Tauri, este arquivo nao muda.

Os tres conceitos que voce precisa ter na cabeca para ler o resto:

  MES         -- mes do calendario (01/09 a 30/09). E como a gente olha
                 "quanto eu gastei em setembro", em qualquer meio de pagamento.

  FATURA      -- ciclo do cartao (30/08 a 29/09, vence 03/10). E como a gente
                 olha "quanto eu vou pagar dia 3". Identificada pelo mes em
                 que VENCE.

  DATA DE CORTE -- o dia em que voce informou seus saldos no setup. Lancamentos
                 anteriores a ela aparecem nos relatorios, mas nao mexem no
                 saldo, porque o saldo que voce digitou ja os continha.
"""

from __future__ import annotations

import sqlite3
from datetime import date

from .modelos import (
    CicloFatura,
    Fluxo,
    Meio,
    MovReserva,
    Natureza,
    OrigemLancamento,
    Responsavel,
    ciclo_fatura,
    clamp_dia,
    fatura_de_compra,
    partes_para_ref,
    ref_de_data,
    ref_para_partes,
    rotulo_mes,
    somar_meses,
)

MAX_MESES_MATERIALIZACAO = 120


_HOJE_FIXO: date | None = None


def hoje() -> date:
    """A data de "hoje" para todo o app.

    Tudo passa por aqui em vez de chamar `date.today()` direto, para que os
    testes possam congelar a data. Regras que dependem de hoje (saldo
    realizado, status da fatura, previsao do mes) so sao testaveis assim.
    """
    return _HOJE_FIXO or date.today()


def fixar_hoje(d: date | None) -> None:
    """Congela (ou libera, com None) a data de hoje. Uso exclusivo de teste."""
    global _HOJE_FIXO
    _HOJE_FIXO = d


# ---------------------------------------------------------------------------
# Configuracao
# ---------------------------------------------------------------------------


class Config:
    """Configuracao financeira lida do banco, com valores tipados."""

    def __init__(self, bruta: dict[str, str]):
        self.mes_inicial: str = bruta.get("mes_inicial", "2026-09")
        self.dia_fechamento: int = int(bruta.get("dia_fechamento", 29))
        self.dia_vencimento: int = int(bruta.get("dia_vencimento", 3))
        self.saldo_inicial_conta: int = int(bruta.get("saldo_inicial_conta", 0))
        self.nome_conta: str = bruta.get("nome_conta", "Conta Nubank")
        self.setup_concluido: bool = bruta.get("setup_concluido", "0") == "1"
        self.data_corte: str = bruta.get("data_corte") or f"{self.mes_inicial}-01"

    def para_json(self) -> dict:
        return {
            "mes_inicial": self.mes_inicial,
            "dia_fechamento": self.dia_fechamento,
            "dia_vencimento": self.dia_vencimento,
            "saldo_inicial_conta": self.saldo_inicial_conta,
            "nome_conta": self.nome_conta,
            "setup_concluido": self.setup_concluido,
            "data_corte": self.data_corte,
        }


def carregar_config(conn: sqlite3.Connection) -> Config:
    bruta = {l["chave"]: l["valor"] for l in conn.execute("SELECT chave, valor FROM config")}
    return Config(bruta)


def ciclo(cfg: Config, ref: str) -> CicloFatura:
    return ciclo_fatura(ref, cfg.dia_fechamento, cfg.dia_vencimento)


def fatura_aberta(cfg: Config, quando: date | None = None) -> str:
    """Referencia da fatura que esta acumulando compras agora."""
    return fatura_de_compra(quando or hoje(), cfg.dia_fechamento)


def refs_disponiveis(cfg: Config, quantos_futuros: int = 6) -> list[dict]:
    """Meses que o app aceita mostrar: de `mes_inicial` ate alguns a frente.

    Nunca voltamos antes de `mes_inicial` -- foi requisito explicito nao
    lidar com meses anteriores ao ponto de partida.
    """
    ano_i, mes_i = ref_para_partes(cfg.mes_inicial)
    h = hoje()
    ano_f, mes_f = somar_meses(h.year, h.month, quantos_futuros)

    refs: list[dict] = []
    ano, mes = ano_i, mes_i
    while (ano, mes) <= (ano_f, mes_f) and len(refs) < MAX_MESES_MATERIALIZACAO:
        ref = partes_para_ref(ano, mes)
        refs.append({"ref": ref, "rotulo": rotulo_mes(ref), "atual": ref == ref_de_data(h)})
        ano, mes = somar_meses(ano, mes, 1)
    return refs


# ---------------------------------------------------------------------------
# Materializacao dos gastos fixos
# ---------------------------------------------------------------------------


def materializar_recorrencias(conn: sqlite3.Connection, cfg: Config, ate_ref: str) -> int:
    """Cria os lancamentos dos gastos fixos de cada mes, uma unica vez.

    Voce cadastra "Netflix, R$ 44,90, dia 15, credito" uma vez; esta funcao
    e quem faz a Netflix aparecer em outubro, novembro e assim por diante.

    E idempotente: a tabela `recorrencia_gerada` guarda o par
    (recorrencia, mes). Se voce APAGAR um fixo gerado, ele nao volta --
    o registro do par sobrevive a exclusao do lancamento.
    """
    recorrencias = conn.execute(
        "SELECT * FROM recorrencia WHERE ativa = 1 ORDER BY id"
    ).fetchall()
    if not recorrencias:
        return 0

    # Materializa pelo menos ate o mes corrente, mesmo olhando um mes passado.
    limite = max(ate_ref, ref_de_data(hoje()))
    ano_fim, mes_fim = ref_para_partes(limite)
    agora = hoje().isoformat()
    criados = 0

    for r in recorrencias:
        inicio = max(r["inicio_ref"], cfg.mes_inicial)
        ano, mes = ref_para_partes(inicio)
        passos = 0

        while (ano, mes) <= (ano_fim, mes_fim) and passos < MAX_MESES_MATERIALIZACAO:
            passos += 1
            ref = partes_para_ref(ano, mes)
            ano, mes = somar_meses(ano, mes, 1)

            if r["fim_ref"] and ref > r["fim_ref"]:
                break

            ja = conn.execute(
                "SELECT 1 FROM recorrencia_gerada WHERE recorrencia_id = ? AND ref = ?",
                (r["id"], ref),
            ).fetchone()
            if ja:
                continue

            ano_l, mes_l = ref_para_partes(ref)
            data = clamp_dia(ano_l, mes_l, r["dia"])
            fat = (
                fatura_de_compra(data, cfg.dia_fechamento)
                if r["meio"] == Meio.CREDITO.value
                else None
            )

            cur = conn.execute(
                """
                INSERT INTO lancamento
                    (data, descricao, valor, fluxo, responsavel, natureza, meio,
                     categoria_id, fatura_ref, origem, recorrencia_id, observacao, criado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
                """,
                (
                    data.isoformat(),
                    r["descricao"],
                    r["valor"],
                    r["fluxo"],
                    r["responsavel"],
                    Natureza.FIXO.value,
                    r["meio"],
                    r["categoria_id"],
                    fat,
                    OrigemLancamento.RECORRENCIA.value,
                    r["id"],
                    agora,
                ),
            )
            conn.execute(
                "INSERT INTO recorrencia_gerada (recorrencia_id, ref, lancamento_id, gerado_em) "
                "VALUES (?, ?, ?, ?)",
                (r["id"], ref, cur.lastrowid, agora),
            )
            criados += 1

    return criados


# ---------------------------------------------------------------------------
# Saldos
# ---------------------------------------------------------------------------


def saldo_conta(conn: sqlite3.Connection, cfg: Config) -> dict:
    """Saldo da conta corrente, decomposto para poder ser auditado na tela.

    saldo = saldo informado no setup
          + entradas no debito
          - saidas no debito
          - depositos em caixinha
          + saques de caixinha
          - pagamentos de fatura

    DUAS janelas de data limitam essa soma, e as duas importam:

    * `data >= data_corte` -- o saldo que voce digitou no setup ja continha
      tudo que aconteceu antes daquele dia. Contar de novo seria duplicar.

    * `data <= hoje` -- saldo e o que voce TEM, nao o que vai ter. Sem esse
      limite, cadastrar o aluguel como gasto fixo derrubaria o saldo de hoje
      pelas parcelas de outubro, novembro e dezembro, que ainda nao sairam.
      O que ainda vai sair aparece em `a_sair_no_mes`, separado.

    Compras no CREDITO nao entram: elas so viram dinheiro saindo da conta
    no dia em que a fatura e paga.
    """
    corte = cfg.data_corte
    h = hoje().isoformat()

    entradas = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM lancamento "
        "WHERE fluxo = ? AND meio = ? AND data >= ? AND data <= ?",
        (Fluxo.ENTRADA.value, Meio.DEBITO.value, corte, h),
    )
    saidas = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM lancamento "
        "WHERE fluxo = ? AND meio = ? AND data >= ? AND data <= ?",
        (Fluxo.SAIDA.value, Meio.DEBITO.value, corte, h),
    )
    depositos = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM mov_reserva "
        "WHERE tipo = ? AND data >= ? AND data <= ?",
        (MovReserva.DEPOSITO.value, corte, h),
    )
    saques = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM mov_reserva "
        "WHERE tipo = ? AND data >= ? AND data <= ?",
        (MovReserva.SAQUE.value, corte, h),
    )
    pagamentos = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM pagamento_fatura WHERE data >= ? AND data <= ?",
        (corte, h),
    )

    # O que ainda esta previsto sair/entrar da conta neste mes de calendario.
    fim_do_mes = clamp_dia(*ref_para_partes(ref_de_data(hoje())), 31).isoformat()
    a_sair = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM lancamento "
        "WHERE fluxo = ? AND meio = ? AND data > ? AND data <= ?",
        (Fluxo.SAIDA.value, Meio.DEBITO.value, h, fim_do_mes),
    )
    a_entrar = _soma(
        conn,
        "SELECT COALESCE(SUM(valor), 0) FROM lancamento "
        "WHERE fluxo = ? AND meio = ? AND data > ? AND data <= ?",
        (Fluxo.ENTRADA.value, Meio.DEBITO.value, h, fim_do_mes),
    )

    saldo = cfg.saldo_inicial_conta + entradas - saidas - depositos + saques - pagamentos
    return {
        "nome": cfg.nome_conta,
        "saldo": saldo,
        "a_sair_no_mes": a_sair,
        "a_entrar_no_mes": a_entrar,
        "saldo_previsto_fim_do_mes": saldo - a_sair + a_entrar,
        "composicao": {
            "saldo_inicial": cfg.saldo_inicial_conta,
            "entradas": entradas,
            "saidas": saidas,
            "depositos_reservas": depositos,
            "saques_reservas": saques,
            "pagamentos_fatura": pagamentos,
        },
    }


def saldos_reservas(conn: sqlite3.Connection, cfg: Config) -> list[dict]:
    """Saldo de cada caixinha / fundo, com o quanto foi aporte e o quanto rendeu.

    Mesma regra de janela do saldo da conta: conta do dia do setup ate hoje.
    Uma movimentacao com data futura nao pode inflar o que voce tem agora.
    """
    corte = cfg.data_corte
    h = hoje().isoformat()
    reservas = conn.execute(
        "SELECT * FROM reserva WHERE ativa = 1 ORDER BY tipo, nome"
    ).fetchall()

    resultado: list[dict] = []
    for r in reservas:
        linhas = conn.execute(
            "SELECT tipo, COALESCE(SUM(valor), 0) AS total FROM mov_reserva "
            "WHERE reserva_id = ? AND data >= ? AND data <= ? GROUP BY tipo",
            (r["id"], corte, h),
        ).fetchall()
        por_tipo = {l["tipo"]: l["total"] for l in linhas}

        depositos = por_tipo.get(MovReserva.DEPOSITO.value, 0)
        saques = por_tipo.get(MovReserva.SAQUE.value, 0)
        rendimentos = por_tipo.get(MovReserva.RENDIMENTO.value, 0)
        saldo = r["saldo_inicial"] + depositos - saques + rendimentos

        resultado.append(
            {
                "id": r["id"],
                "nome": r["nome"],
                "tipo": r["tipo"],
                "meta": r["meta"],
                "saldo": saldo,
                "saldo_inicial": r["saldo_inicial"],
                "depositos": depositos,
                "saques": saques,
                "rendimentos": rendimentos,
                "progresso_meta": (
                    round(min(saldo / r["meta"], 1.0) * 100, 1) if r["meta"] else None
                ),
            }
        )
    return resultado


def _soma(conn: sqlite3.Connection, sql: str, params: tuple) -> int:
    return int(conn.execute(sql, params).fetchone()[0] or 0)


# ---------------------------------------------------------------------------
# Fatura do cartao
# ---------------------------------------------------------------------------


def montar_fatura(conn: sqlite3.Connection, cfg: Config, ref: str) -> dict:
    """A fatura que vence no mes `ref`, com a quebra nos tres responsaveis.

    A quebra por responsavel e o ponto central do app: do total que vence
    dia 3, ela diz quanto e SEU e quanto e dinheiro de terceiros / Genesys
    que ja esta guardado na caixinha esperando para pagar o cartao.
    """
    c = ciclo(cfg, ref)

    itens = [
        dict(l)
        for l in conn.execute(
            """
            SELECT l.*, c.nome AS categoria_nome, c.cor AS categoria_cor
            FROM lancamento l
            LEFT JOIN categoria c ON c.id = l.categoria_id
            WHERE l.meio = ? AND l.fatura_ref = ?
            ORDER BY l.data, l.id
            """,
            (Meio.CREDITO.value, ref),
        )
    ]

    por_responsavel = {r.value: 0 for r in Responsavel}
    por_natureza = {n.value: 0 for n in Natureza}
    total = 0
    for i in itens:
        # Um estorno (ENTRADA no credito) abate a fatura em vez de somar.
        sinal = 1 if i["fluxo"] == Fluxo.SAIDA.value else -1
        valor = sinal * i["valor"]
        total += valor
        por_responsavel[i["responsavel"]] += valor
        por_natureza[i["natureza"]] += valor

    pagamentos = [
        dict(p)
        for p in conn.execute(
            """
            SELECT p.*, r.nome AS reserva_nome
            FROM pagamento_fatura p
            LEFT JOIN reserva r ON r.id = p.reserva_id
            WHERE p.fatura_ref = ?
            ORDER BY p.data, p.id
            """,
            (ref,),
        )
    ]
    pago = sum(p["valor"] for p in pagamentos)
    h = hoje()

    if total > 0 and pago >= total:
        status = "PAGA"
    elif pago > 0:
        status = "PARCIAL"
    elif h > c.fechamento:
        status = "FECHADA"
    elif h >= c.inicio:
        status = "ABERTA"
    else:
        status = "FUTURA"

    return {
        "ciclo": c.para_json(),
        "status": status,
        "total": total,
        "pago": pago,
        "restante": max(total - pago, 0),
        "por_responsavel": por_responsavel,
        "por_natureza": por_natureza,
        "itens": itens,
        "pagamentos": pagamentos,
        "dias_para_vencer": (c.vencimento - h).days,
    }


# ---------------------------------------------------------------------------
# Visao do mes: as tres tabelas e o dashboard
# ---------------------------------------------------------------------------


def _lancamentos_do_mes(conn: sqlite3.Connection, ref: str) -> list[dict]:
    """Lancamentos do mes de calendario `ref`, para os relatorios de gasto.

    Exclui `origem = 'SETUP'` de proposito. O saldo de fatura anterior
    informado no setup e dinheiro gasto ANTES do controle comecar: ele
    precisa entrar no total que voce paga dia 3 (e entra, via `montar_fatura`),
    mas nao pode aparecer em "onde eu mais gastei neste mes", senao suja
    exatamente a analise que o app existe para fazer.
    """
    return [
        dict(l)
        for l in conn.execute(
            """
            SELECT l.*, c.nome AS categoria_nome, c.cor AS categoria_cor
            FROM lancamento l
            LEFT JOIN categoria c ON c.id = l.categoria_id
            WHERE substr(l.data, 1, 7) = ? AND l.origem <> 'SETUP'
            ORDER BY l.data DESC, l.id DESC
            """,
            (ref,),
        )
    ]


def tabela_responsavel(itens: list[dict], responsavel: str) -> dict:
    """Uma das tres tabelas da tela inicial, agrupada por Fixo/Parcelamento/Avulso."""
    do_grupo = [i for i in itens if i["responsavel"] == responsavel]

    grupos = []
    for nat in (Natureza.FIXO, Natureza.PARCELAMENTO, Natureza.AVULSO):
        linhas = [i for i in do_grupo if i["natureza"] == nat.value]
        saidas = sum(i["valor"] for i in linhas if i["fluxo"] == Fluxo.SAIDA.value)
        entradas = sum(i["valor"] for i in linhas if i["fluxo"] == Fluxo.ENTRADA.value)
        grupos.append(
            {
                "natureza": nat.value,
                "itens": linhas,
                "total": saidas - entradas,
                "quantidade": len(linhas),
            }
        )

    saidas = sum(i["valor"] for i in do_grupo if i["fluxo"] == Fluxo.SAIDA.value)
    entradas = sum(i["valor"] for i in do_grupo if i["fluxo"] == Fluxo.ENTRADA.value)
    return {
        "responsavel": responsavel,
        "grupos": grupos,
        "total_saidas": saidas,
        "total_entradas": entradas,
        "total": saidas - entradas,
        "quantidade": len(do_grupo),
    }


def resumo_mes(conn: sqlite3.Connection, cfg: Config, ref: str) -> dict:
    """Tudo que a tela inicial precisa para o mes `ref`, em uma chamada."""
    itens = _lancamentos_do_mes(conn, ref)
    saidas = [i for i in itens if i["fluxo"] == Fluxo.SAIDA.value]
    entradas = [i for i in itens if i["fluxo"] == Fluxo.ENTRADA.value]

    # Gastos por categoria -- o grafico principal do dashboard.
    por_categoria: dict[int | None, dict] = {}
    for i in saidas:
        chave = i["categoria_id"]
        alvo = por_categoria.setdefault(
            chave,
            {
                "categoria_id": chave,
                "nome": i["categoria_nome"] or "Sem categoria",
                "cor": i["categoria_cor"] or "#94A3B8",
                "total": 0,
                "quantidade": 0,
            },
        )
        alvo["total"] += i["valor"]
        alvo["quantidade"] += 1

    total_saidas = sum(i["valor"] for i in saidas)
    categorias = sorted(por_categoria.values(), key=lambda c: -c["total"])
    for c in categorias:
        c["percentual"] = round(c["total"] / total_saidas * 100, 1) if total_saidas else 0.0

    por_meio = {m.value: 0 for m in Meio}
    for i in saidas:
        por_meio[i["meio"]] += i["valor"]

    tabelas = {r.value: tabela_responsavel(itens, r.value) for r in Responsavel}
    total_pessoal = tabelas[Responsavel.PESSOAL.value]["total_saidas"]

    return {
        "ref": ref,
        "rotulo": rotulo_mes(ref),
        "total_saidas": total_saidas,
        "total_entradas": sum(i["valor"] for i in entradas),
        "total_pessoal": total_pessoal,
        "gasto_de_terceiros": (
            tabelas[Responsavel.TERCEIROS.value]["total_saidas"]
            + tabelas[Responsavel.GENESYS.value]["total_saidas"]
        ),
        "por_categoria": categorias,
        "por_meio": por_meio,
        "tabelas": tabelas,
        "quantidade": len(itens),
    }


def visao_geral(conn: sqlite3.Connection, cfg: Config, ref: str) -> dict:
    """Payload unico da tela inicial: saldos + mes + fatura aberta + proxima fatura."""
    materializar_recorrencias(conn, cfg, ref)

    ref_fatura_aberta = fatura_aberta(cfg)
    ano, mes = ref_para_partes(ref_fatura_aberta)
    ref_fatura_seguinte = partes_para_ref(*somar_meses(ano, mes, 1))

    reservas = saldos_reservas(conn, cfg)
    conta = saldo_conta(conn, cfg)
    fatura = montar_fatura(conn, cfg, ref_fatura_aberta)

    movimentacoes = [
        dict(m)
        for m in conn.execute(
            "SELECT m.*, r.nome AS reserva_nome, r.tipo AS reserva_tipo "
            "FROM mov_reserva m JOIN reserva r ON r.id = m.reserva_id "
            "ORDER BY m.data DESC, m.id DESC LIMIT 100"
        )
    ]

    total_reservado = sum(r["saldo"] for r in reservas)
    nao_e_meu = (
        fatura["por_responsavel"][Responsavel.TERCEIROS.value]
        + fatura["por_responsavel"][Responsavel.GENESYS.value]
    )

    return {
        "config": cfg.para_json(),
        "hoje": hoje().isoformat(),
        "mes": resumo_mes(conn, cfg, ref),
        "conta": conta,
        "reservas": reservas,
        "movimentacoes": movimentacoes,
        "total_reservado": total_reservado,
        "patrimonio": conta["saldo"] + total_reservado,
        "fatura_aberta": fatura,
        "fatura_seguinte": montar_fatura(conn, cfg, ref_fatura_seguinte),
        # Quanto da fatura aberta e realmente seu bolso.
        "fatura_parte_minha": fatura["por_responsavel"][Responsavel.PESSOAL.value],
        "fatura_parte_terceiros": nao_e_meu,
        "meses": refs_disponiveis(cfg),
    }
