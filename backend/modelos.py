"""
Modelos, enums e regras puras do NuControle.

Duas convencoes que valem para TODO o projeto:

1. Dinheiro e SEMPRE int em centavos. Nunca float.
   R$ 1.234,56 -> 123456. Isso elimina erro de arredondamento
   (0.1 + 0.2 != 0.3 em float, e em dinheiro isso e inaceitavel).

2. Datas circulam como str ISO "YYYY-MM-DD" na API e como
   datetime.date dentro das regras.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date
from enum import Enum

# ---------------------------------------------------------------------------
# Enums de classificacao
# ---------------------------------------------------------------------------


class Fluxo(str, Enum):
    """O dinheiro entrou ou saiu."""

    SAIDA = "SAIDA"
    ENTRADA = "ENTRADA"


class Responsavel(str, Enum):
    """De quem e o gasto -- as tres tabelas da tela inicial."""

    PESSOAL = "PESSOAL"
    TERCEIROS = "TERCEIROS"
    GENESYS = "GENESYS"


class Natureza(str, Enum):
    """Como o gasto se comporta no tempo."""

    FIXO = "FIXO"
    PARCELAMENTO = "PARCELAMENTO"
    AVULSO = "AVULSO"


class Meio(str, Enum):
    """Por onde o dinheiro passou.

    CREDITO entra na fatura do cartao e so afeta o saldo da conta no
    dia do pagamento da fatura. DEBITO (pix, debito, ted) sai do saldo
    na hora. Dinheiro fisico nao existe neste app, por decisao de escopo.
    """

    CREDITO = "CREDITO"
    DEBITO = "DEBITO"


class TipoReserva(str, Enum):
    """Caixinha rende sozinha; fundo tem aporte e dividendo."""

    CAIXINHA = "CAIXINHA"
    FUNDO = "FUNDO"


class MovReserva(str, Enum):
    """Movimentacao dentro de uma caixinha / fundo.

    DEPOSITO tira da conta e poe na caixinha.
    SAQUE tira da caixinha e devolve para a conta.
    RENDIMENTO cresce a caixinha sem tocar na conta (juros, dividendo).
    """

    DEPOSITO = "DEPOSITO"
    SAQUE = "SAQUE"
    RENDIMENTO = "RENDIMENTO"


class OrigemLancamento(str, Enum):
    """Quem criou o lancamento -- usado para saber o que pode ser editado."""

    MANUAL = "MANUAL"
    RECORRENCIA = "RECORRENCIA"
    PARCELAMENTO = "PARCELAMENTO"
    SETUP = "SETUP"


# ---------------------------------------------------------------------------
# Dinheiro
# ---------------------------------------------------------------------------


def formatar_reais(centavos: int) -> str:
    """123456 -> 'R$ 1.234,56'. Negativo vira '-R$ 1.234,56'."""
    sinal = "-" if centavos < 0 else ""
    inteiro, resto = divmod(abs(int(centavos)), 100)
    return f"{sinal}R$ {inteiro:,.0f}".replace(",", ".") + f",{resto:02d}"


def parse_centavos(valor: str | int | float) -> int:
    """Aceita o que o usuario digitar e devolve centavos.

    '1.234,56' -> 123456    (formato brasileiro)
    '1234.56'  -> 123456    (formato americano)
    '1234'     -> 123400    (reais inteiros)
    1234.56    -> 123456    (float, arredondado)
    """
    if isinstance(valor, bool):
        raise ValueError("valor invalido")
    if isinstance(valor, int):
        return valor * 100
    if isinstance(valor, float):
        return int(round(valor * 100))

    texto = str(valor).strip()
    if not texto:
        raise ValueError("valor vazio")

    negativo = texto.startswith("-")
    texto = re.sub(r"[^\d,.]", "", texto)
    if not texto:
        raise ValueError(f"valor invalido: {valor!r}")

    # O ultimo separador presente e o decimal; os outros sao de milhar.
    if "," in texto and "." in texto:
        if texto.rindex(",") > texto.rindex("."):
            texto = texto.replace(".", "").replace(",", ".")
        else:
            texto = texto.replace(",", "")
    elif "," in texto:
        texto = texto.replace(",", ".")
    elif texto.count(".") > 1:
        texto = texto.replace(".", "")

    centavos = int(round(float(texto) * 100))
    return -centavos if negativo else centavos


def dividir_parcelas(total_centavos: int, num_parcelas: int) -> list[int]:
    """Divide um total em N parcelas sem perder nem inventar centavo.

    O resto vai nas PRIMEIRAS parcelas, que e como o Nubank faz:
    R$ 100,00 em 3x -> 33,34 / 33,33 / 33,33 (soma exata: 100,00).
    """
    if num_parcelas < 1:
        raise ValueError("numero de parcelas deve ser >= 1")
    base, resto = divmod(int(total_centavos), num_parcelas)
    return [base + (1 if i < resto else 0) for i in range(num_parcelas)]


# ---------------------------------------------------------------------------
# Calendario e ciclo da fatura
# ---------------------------------------------------------------------------


def clamp_dia(ano: int, mes: int, dia: int) -> date:
    """Data segura: dia 31 em fevereiro vira o ultimo dia de fevereiro.

    Sem isso, 'fatura fecha dia 29' quebraria em fevereiro de ano nao bissexto.
    """
    ultimo = calendar.monthrange(ano, mes)[1]
    return date(ano, mes, min(dia, ultimo))


def somar_meses(ano: int, mes: int, delta: int) -> tuple[int, int]:
    """(2026, 12) + 1 -> (2027, 1). Aceita delta negativo."""
    total = (ano * 12 + (mes - 1)) + delta
    return total // 12, (total % 12) + 1


def ref_para_partes(ref: str) -> tuple[int, int]:
    """'2026-09' -> (2026, 9)."""
    if not re.fullmatch(r"\d{4}-\d{2}", ref or ""):
        raise ValueError(f"referencia de mes invalida: {ref!r} (use 'YYYY-MM')")
    ano, mes = ref.split("-")
    mes_int = int(mes)
    if not 1 <= mes_int <= 12:
        raise ValueError(f"mes invalido em {ref!r}")
    return int(ano), mes_int


def partes_para_ref(ano: int, mes: int) -> str:
    """(2026, 9) -> '2026-09'."""
    return f"{ano:04d}-{mes:02d}"


def ref_de_data(d: date) -> str:
    """Mes calendario de uma data. 08/09/2026 -> '2026-09'."""
    return partes_para_ref(d.year, d.month)


MESES_PT = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]


def rotulo_mes(ref: str) -> str:
    """'2026-09' -> 'Setembro 2026'."""
    ano, mes = ref_para_partes(ref)
    return f"{MESES_PT[mes - 1].capitalize()} {ano}"


@dataclass(frozen=True)
class CicloFatura:
    """Uma fatura do cartao, identificada pelo mes em que VENCE.

    Com fechamento dia 29 e vencimento dia 3, a fatura '2026-10' e:
        janela de compras : 30/08/2026 ate 29/09/2026
        fechamento        : 29/09/2026
        vencimento        : 03/10/2026

    A janela comeca no dia seguinte ao fechamento anterior. Isso garante
    que nenhuma compra caia em duas faturas nem fique de fora, mesmo
    quando o dia de fechamento e ajustado por causa de fevereiro.
    """

    ref: str
    inicio: date
    fechamento: date
    vencimento: date

    @property
    def rotulo(self) -> str:
        return rotulo_mes(self.ref)

    def contem(self, d: date) -> bool:
        return self.inicio <= d <= self.fechamento

    def para_json(self) -> dict:
        return {
            "ref": self.ref,
            "rotulo": self.rotulo,
            "inicio": self.inicio.isoformat(),
            "fechamento": self.fechamento.isoformat(),
            "vencimento": self.vencimento.isoformat(),
        }


def ciclo_fatura(ref: str, dia_fechamento: int, dia_vencimento: int) -> CicloFatura:
    """Monta o ciclo da fatura que VENCE no mes `ref`."""
    ano, mes = ref_para_partes(ref)

    vencimento = clamp_dia(ano, mes, dia_vencimento)

    ano_f, mes_f = somar_meses(ano, mes, -1)
    fechamento = clamp_dia(ano_f, mes_f, dia_fechamento)

    ano_a, mes_a = somar_meses(ano, mes, -2)
    fechamento_anterior = clamp_dia(ano_a, mes_a, dia_fechamento)

    inicio = date.fromordinal(fechamento_anterior.toordinal() + 1)
    return CicloFatura(ref=ref, inicio=inicio, fechamento=fechamento, vencimento=vencimento)


def fatura_de_compra(d: date, dia_fechamento: int) -> str:
    """Em qual fatura cai uma compra feita no dia `d`.

    Comprou 08/09 com fechamento 29 -> fecha 29/09 -> vence 03/10 -> '2026-10'.
    Comprou 30/09 (ja passou o fechamento) -> vence em novembro -> '2026-11'.
    """
    fechamento_do_mes = clamp_dia(d.year, d.month, dia_fechamento)
    delta = 1 if d <= fechamento_do_mes else 2
    ano, mes = somar_meses(d.year, d.month, delta)
    return partes_para_ref(ano, mes)


# ---------------------------------------------------------------------------
# Categorias iniciais (editaveis pelo usuario depois)
# ---------------------------------------------------------------------------

CATEGORIAS_PADRAO: list[tuple[str, str, str]] = [
    ("Alimentacao", "#FF6B35", "restaurant"),
    ("Mercado", "#F7B32B", "cart"),
    ("Transporte", "#2EC4B6", "car"),
    ("Assinaturas", "#820AD1", "play"),
    ("Moradia", "#5B6BF5", "home"),
    ("Saude", "#E5484D", "heart"),
    ("Lazer", "#EC4899", "music"),
    ("Educacao", "#0EA5E9", "book"),
    ("Compras", "#8B5CF6", "bag"),
    ("Servicos", "#64748B", "tool"),
    ("Impostos", "#78716C", "doc"),
    ("Outros", "#94A3B8", "dots"),
]
