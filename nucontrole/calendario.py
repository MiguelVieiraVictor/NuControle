"""
Meses e ciclo da fatura.

Dois conceitos de tempo que o app nunca mistura:

  MES     -- mes do calendario (01/09 a 30/09). "Quanto eu gastei em setembro",
             em qualquer meio de pagamento. Identificado por 'YYYY-MM'.

  FATURA  -- ciclo do cartao (30/08 a 29/09, vence 03/10). "Quanto eu pago dia 3".
             Identificada pelo mes em que VENCE: a fatura '2026-10' acima.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date

MESES = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]


def clamp_dia(ano: int, mes: int, dia: int) -> date:
    """Dia 31 em fevereiro vira o ultimo dia de fevereiro."""
    return date(ano, mes, min(dia, calendar.monthrange(ano, mes)[1]))


def somar_meses(ano: int, mes: int, delta: int) -> tuple[int, int]:
    """(2026, 12) + 1 -> (2027, 1). Aceita delta negativo."""
    total = ano * 12 + (mes - 1) + delta
    return total // 12, total % 12 + 1


def partes(ref: str) -> tuple[int, int]:
    """'2026-09' -> (2026, 9)."""
    if not re.fullmatch(r"\d{4}-\d{2}", ref or ""):
        raise ValueError(f"mes invalido: {ref!r} (use AAAA-MM)")
    ano, mes = int(ref[:4]), int(ref[5:])
    if not 1 <= mes <= 12:
        raise ValueError(f"mes invalido: {ref!r}")
    return ano, mes


def ref(ano: int, mes: int) -> str:
    return f"{ano:04d}-{mes:02d}"


def ref_de(d: date) -> str:
    return ref(d.year, d.month)


def somar_ref(r: str, delta: int) -> str:
    return ref(*somar_meses(*partes(r), delta))


def rotulo(r: str) -> str:
    """'2026-09' -> 'Setembro 2026'."""
    ano, mes = partes(r)
    return f"{MESES[mes - 1]} {ano}"


def data_iso(texto: str) -> date:
    try:
        return date.fromisoformat(texto)
    except (TypeError, ValueError):
        raise ValueError(f"data invalida: {texto!r}") from None


def data_no_mes(r: str, dia: int) -> date:
    """Dia `dia` do mes `r`, respeitando o tamanho do mes."""
    return clamp_dia(*partes(r), dia)


@dataclass(frozen=True)
class Ciclo:
    """Uma fatura. Com fechamento 29 e vencimento 3, a fatura '2026-10' e:
        compras de 30/08/2026 a 29/09/2026, fecha 29/09, vence 03/10.

    O ciclo comeca no dia seguinte ao fechamento anterior, entao nenhuma
    compra cai em duas faturas nem fica de fora -- inclusive em fevereiro.
    """

    ref: str
    inicio: date
    fechamento: date
    vencimento: date

    def json(self) -> dict:
        return {
            "ref": self.ref,
            "rotulo": rotulo(self.ref),
            "inicio": self.inicio.isoformat(),
            "fechamento": self.fechamento.isoformat(),
            "vencimento": self.vencimento.isoformat(),
        }


def ciclo(r: str, dia_fechamento: int, dia_vencimento: int) -> Ciclo:
    """O ciclo da fatura que VENCE no mes `r`."""
    ano, mes = partes(r)
    vencimento = clamp_dia(ano, mes, dia_vencimento)
    # Vencimento no inicio do mes (ex.: dia 3) -> fechou no mes anterior.
    # Vencimento depois do fechamento no mesmo mes (ex.: fecha 5, vence 15)
    # -> fechou no proprio mes.
    delta = 0 if dia_vencimento > dia_fechamento else -1
    fechamento = clamp_dia(*somar_meses(ano, mes, delta), dia_fechamento)
    anterior = clamp_dia(*somar_meses(ano, mes, delta - 1), dia_fechamento)
    return Ciclo(r, date.fromordinal(anterior.toordinal() + 1), fechamento, vencimento)


def fatura_de(d: date, dia_fechamento: int, dia_vencimento: int) -> str:
    """Em qual fatura cai uma compra feita no dia `d`.

    Fecha 29, vence 3: compra em 08/09 -> fecha 29/09 -> vence 03/10 -> '2026-10'.
                      compra em 30/09 -> fecha 29/10 -> vence 03/11 -> '2026-11'.
    """
    fechamento_do_mes = clamp_dia(d.year, d.month, dia_fechamento)
    ano, mes = (d.year, d.month) if d <= fechamento_do_mes else somar_meses(d.year, d.month, 1)
    # (ano, mes) agora e o mes em que a fatura FECHA
    delta = 0 if dia_vencimento > dia_fechamento else 1
    return ref(*somar_meses(ano, mes, delta))
