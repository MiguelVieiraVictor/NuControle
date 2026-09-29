"""
Conexao SQLite e schema.

O banco mora na pasta do USUARIO (%APPDATA%\\NuControle\\dados), nao junto do
programa: o .exe pode estar numa pasta somente leitura, e assim abrir pelo .exe
ou por `python app.py` usa sempre o mesmo banco.

O arquivo e `nucontrole-v2.db`. O `nucontrole.db` da versao 1 fica ao lado,
intocado -- a v2 comeca zerada por decisao de projeto.

Sem WAL de proposito: o banco e um arquivo so, que da para copiar arrastando.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from datetime import date
from pathlib import Path


def _pasta_do_usuario() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
    else:
        base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "NuControle" / "dados"


def caminho_banco() -> Path:
    # NUCONTROLE_DADOS existe para os testes e para uma instancia separada.
    pasta = Path(os.environ.get("NUCONTROLE_DADOS") or _pasta_do_usuario())
    return pasta / "nucontrole-v2.db"


VERSAO_SCHEMA = 1

SCHEMA = """
CREATE TABLE config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

-- Donos de gasto. O id 1 e sempre "Eu" (tipo EU) e nao pode ser apagado.
-- Os demais sao os terceiros que o usuario cadastra: pessoas ou orgs.
CREATE TABLE dono (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    nome      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    tipo      TEXT    NOT NULL CHECK (tipo IN ('EU', 'PESSOA', 'ORG')),
    cor       TEXT    NOT NULL,
    ativo     INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT    NOT NULL
);

CREATE TABLE categoria (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    nome   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    cor    TEXT    NOT NULL,
    ativa  INTEGER NOT NULL DEFAULT 1
);

-- Caixinhas e fundos imobiliarios.
CREATE TABLE reserva (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nome          TEXT    NOT NULL,
    tipo          TEXT    NOT NULL CHECK (tipo IN ('CAIXINHA', 'FUNDO')),
    saldo_inicial INTEGER NOT NULL DEFAULT 0 CHECK (saldo_inicial >= 0),
    meta          INTEGER CHECK (meta IS NULL OR meta > 0),
    criada_em     TEXT    NOT NULL
);

-- DEPOSITO: conta -> reserva.  SAQUE: reserva -> conta.
-- RENDIMENTO: a reserva cresce sem tocar na conta (juros, dividendo).
CREATE TABLE mov_reserva (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reserva_id INTEGER NOT NULL REFERENCES reserva(id) ON DELETE CASCADE,
    data       TEXT    NOT NULL,
    tipo       TEXT    NOT NULL CHECK (tipo IN ('DEPOSITO', 'SAQUE', 'RENDIMENTO')),
    valor      INTEGER NOT NULL CHECK (valor > 0),
    descricao  TEXT    NOT NULL DEFAULT '',
    criado_em  TEXT    NOT NULL
);
CREATE INDEX ix_mov_reserva ON mov_reserva(reserva_id, data);

-- O que o usuario digitou: uma compra avulsa, um parcelamento ou um fixo.
--   AVULSO / PARCELAMENTO: `valor` e o total da compra.
--   FIXO: `valor` e o valor de CADA mes; `dia`, `inicio_ref`, `fim_ref` definem
--         quando ele acontece.
CREATE TABLE compra (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    descricao       TEXT    NOT NULL,
    fluxo           TEXT    NOT NULL CHECK (fluxo IN ('SAIDA', 'ENTRADA')),
    natureza        TEXT    NOT NULL CHECK (natureza IN ('AVULSO', 'PARCELAMENTO', 'FIXO')),
    meio            TEXT    NOT NULL CHECK (meio IN ('CREDITO', 'DEBITO')),
    categoria_id    INTEGER REFERENCES categoria(id) ON DELETE SET NULL,
    valor           INTEGER NOT NULL CHECK (valor > 0),
    data            TEXT    NOT NULL,
    num_parcelas    INTEGER NOT NULL DEFAULT 1 CHECK (num_parcelas >= 1),
    parcela_inicial INTEGER NOT NULL DEFAULT 1 CHECK (parcela_inicial >= 1),
    dia             INTEGER CHECK (dia IS NULL OR dia BETWEEN 1 AND 31),
    inicio_ref      TEXT,
    fim_ref         TEXT,
    observacao      TEXT    NOT NULL DEFAULT '',
    criado_em       TEXT    NOT NULL
);

-- A divisao da compra entre donos. Soma sempre igual a compra.valor.
CREATE TABLE compra_parte (
    compra_id INTEGER NOT NULL REFERENCES compra(id) ON DELETE CASCADE,
    dono_id   INTEGER NOT NULL REFERENCES dono(id),
    valor     INTEGER NOT NULL CHECK (valor > 0),
    PRIMARY KEY (compra_id, dono_id)
);

-- Cada ocorrencia concreta: a compra avulsa, cada parcela, cada mes do fixo.
CREATE TABLE lancamento (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    compra_id     INTEGER NOT NULL REFERENCES compra(id) ON DELETE CASCADE,
    data          TEXT    NOT NULL,
    ref           TEXT    NOT NULL,           -- mes do calendario da data
    valor         INTEGER NOT NULL CHECK (valor > 0),
    fatura_ref    TEXT,                       -- so no credito
    parcela_num   INTEGER,
    parcela_total INTEGER
);
CREATE INDEX ix_lancamento_ref    ON lancamento(ref);
CREATE INDEX ix_lancamento_fatura ON lancamento(fatura_ref);
CREATE INDEX ix_lancamento_compra ON lancamento(compra_id);

-- A divisao de CADA ocorrencia entre donos. Soma sempre igual a lancamento.valor.
CREATE TABLE lancamento_parte (
    lancamento_id INTEGER NOT NULL REFERENCES lancamento(id) ON DELETE CASCADE,
    dono_id       INTEGER NOT NULL REFERENCES dono(id),
    valor         INTEGER NOT NULL CHECK (valor >= 0),
    PRIMARY KEY (lancamento_id, dono_id)
);
CREATE INDEX ix_lancamento_parte_dono ON lancamento_parte(dono_id);

-- Quais meses de cada fixo ja foram gerados. Sobrevive a exclusao do
-- lancamento: um mes que voce pulou de proposito nao volta sozinho.
CREATE TABLE fixo_gerado (
    compra_id INTEGER NOT NULL REFERENCES compra(id) ON DELETE CASCADE,
    ref       TEXT    NOT NULL,
    PRIMARY KEY (compra_id, ref)
);

CREATE TABLE pagamento_fatura (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    fatura_ref TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    valor      INTEGER NOT NULL CHECK (valor > 0),
    criado_em  TEXT    NOT NULL
);
CREATE INDEX ix_pagamento_fatura ON pagamento_fatura(fatura_ref);
"""

CATEGORIAS_PADRAO = [
    ("Alimentação", "#FF8A65"),
    ("Mercado", "#FFD54F"),
    ("Transporte", "#4DD0E1"),
    ("Assinaturas", "#B388FF"),
    ("Moradia", "#7986CB"),
    ("Saúde", "#EF5350"),
    ("Lazer", "#F06292"),
    ("Educação", "#4FC3F7"),
    ("Compras", "#9575CD"),
    ("Serviços", "#90A4AE"),
    ("Impostos", "#A1887F"),
    ("Salário", "#66BB6A"),
    ("Outros", "#78909C"),
]


def conectar(caminho: Path | None = None) -> sqlite3.Connection:
    """Abre o banco, criando o schema na primeira vez."""
    caminho = caminho or caminho_banco()
    caminho.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(caminho)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    versao = conn.execute("PRAGMA user_version").fetchone()[0]
    if versao == 0:
        _criar(conn)
    elif versao > VERSAO_SCHEMA:
        conn.close()
        raise RuntimeError("banco criado por uma versao mais nova do NuControle")
    return conn


def _criar(conn: sqlite3.Connection) -> None:
    agora = date.today().isoformat()
    with conn:
        conn.executescript(SCHEMA)
        conn.executemany(
            "INSERT INTO config (chave, valor) VALUES (?, ?)",
            [
                ("dia_fechamento", "29"),
                ("dia_vencimento", "3"),
                ("saldo_inicial", "0"),
                ("data_inicio", date.today().replace(day=1).isoformat()),
            ],
        )
        conn.execute(
            "INSERT INTO dono (id, nome, tipo, cor, criado_em) VALUES (1, 'Eu', 'EU', '#9085E9', ?)",
            (agora,),
        )
        conn.executemany(
            "INSERT INTO categoria (nome, cor) VALUES (?, ?)", CATEGORIAS_PADRAO
        )
        conn.execute(f"PRAGMA user_version = {VERSAO_SCHEMA}")
