"""
Pecas comuns a escrita e consulta: "hoje", configuracao e erro de validacao.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date

from . import calendario as cal

_HOJE_FIXO: date | None = None


def hoje() -> date:
    """A data de hoje para todo o app. Os testes congelam com `fixar_hoje`."""
    return _HOJE_FIXO or date.today()


def fixar_hoje(d: date | None) -> None:
    global _HOJE_FIXO
    _HOJE_FIXO = d


class ErroValidacao(ValueError):
    """Erro que o usuario precisa ver, com mensagem em portugues."""


@dataclass(frozen=True)
class Config:
    dia_fechamento: int
    dia_vencimento: int
    saldo_inicial: int
    data_inicio: date

    @classmethod
    def ler(cls, conn: sqlite3.Connection) -> "Config":
        v = dict(conn.execute("SELECT chave, valor FROM config").fetchall())
        return cls(
            dia_fechamento=int(v["dia_fechamento"]),
            dia_vencimento=int(v["dia_vencimento"]),
            saldo_inicial=int(v["saldo_inicial"]),
            data_inicio=date.fromisoformat(v["data_inicio"]),
        )

    def fatura_de(self, d: date) -> str:
        return cal.fatura_de(d, self.dia_fechamento, self.dia_vencimento)

    def ciclo(self, ref: str) -> cal.Ciclo:
        return cal.ciclo(ref, self.dia_fechamento, self.dia_vencimento)

    def json(self) -> dict:
        return {
            "dia_fechamento": self.dia_fechamento,
            "dia_vencimento": self.dia_vencimento,
            "saldo_inicial": self.saldo_inicial,
            "data_inicio": self.data_inicio.isoformat(),
        }


def linhas(cursor) -> list[dict]:
    return [dict(r) for r in cursor.fetchall()]
