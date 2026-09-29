"""
Testes do NuControle. Rodam num banco temporario, nunca no de verdade.

    python testes.py
"""

from __future__ import annotations

import os
import random
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

_TMP = tempfile.TemporaryDirectory()
os.environ["NUCONTROLE_DADOS"] = _TMP.name

from nucontrole import calendario as cal  # noqa: E402
from nucontrole import consultas, escrita  # noqa: E402
from nucontrole.base import ErroValidacao, fixar_hoje  # noqa: E402
from nucontrole.db import conectar  # noqa: E402
from nucontrole.dinheiro import (  # noqa: E402
    dividir_igual,
    formatar_reais,
    parse_centavos,
    ratear,
    ratear_matriz,
)

EU = 1


class Dinheiro(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_centavos("1.234,56"), 123456)
        self.assertEqual(parse_centavos("1234.56"), 123456)
        self.assertEqual(parse_centavos("1234"), 123400)
        self.assertEqual(parse_centavos("0,1"), 10)
        self.assertEqual(parse_centavos(999), 999)
        with self.assertRaises(ValueError):
            parse_centavos(1.5)
        with self.assertRaises(ValueError):
            parse_centavos("1,234")  # tres casas decimais

    def test_formatar(self):
        self.assertEqual(formatar_reais(123456789), "R$ 1.234.567,89")
        self.assertEqual(formatar_reais(-5), "-R$ 0,05")

    def test_dividir_igual(self):
        self.assertEqual(dividir_igual(10000, 3), [3334, 3333, 3333])
        self.assertEqual(dividir_igual(2, 3), [1, 1, 0])

    def test_ratear(self):
        self.assertEqual(ratear(100, [1, 1, 1]), [34, 33, 33])
        self.assertEqual(ratear(1000, [3, 1]), [750, 250])
        self.assertEqual(sum(ratear(99999, [7, 13, 1])), 99999)

    def test_ratear_matriz_exemplo(self):
        parcelas = dividir_igual(100000, 3)
        m = ratear_matriz(parcelas, [60000, 40000])
        self.assertEqual([sum(l) for l in m], parcelas)
        self.assertEqual([sum(c) for c in zip(*m)], [60000, 40000])

    def test_ratear_matriz_aleatorio(self):
        rnd = random.Random(42)
        for _ in range(3000):
            n = rnd.randint(1, 24)
            k = rnd.randint(1, 5)
            total = rnd.randint(n * k, 5_000_00)
            parcelas = dividir_igual(total, n)
            partes = ratear(total, [rnd.randint(1, 100) for _ in range(k)])
            if 0 in partes:
                continue
            m = ratear_matriz(parcelas, partes)
            self.assertEqual([sum(l) for l in m], parcelas)
            self.assertEqual([sum(c) for c in zip(*m)], partes)
            for i, linha in enumerate(m):
                for j, v in enumerate(linha):
                    self.assertGreaterEqual(v, 0)
                    exato = parcelas[i] * partes[j] / total
                    self.assertLess(abs(v - exato), 2.0)


class Calendario(unittest.TestCase):
    def _cobertura(self, fech, venc):
        d = date(2026, 1, 1)
        while d < date(2029, 1, 1):
            r = cal.fatura_de(d, fech, venc)
            c = cal.ciclo(r, fech, venc)
            self.assertTrue(c.inicio <= d <= c.fechamento, (d, r, c))
            self.assertLess(c.fechamento, c.vencimento)
            anterior = cal.ciclo(cal.somar_ref(r, -1), fech, venc)
            self.assertEqual(anterior.fechamento + timedelta(days=1), c.inicio)
            d += timedelta(days=1)

    def test_toda_data_em_uma_fatura(self):
        self._cobertura(29, 3)
        self._cobertura(31, 7)
        self._cobertura(5, 15)

    def test_exemplos(self):
        self.assertEqual(cal.fatura_de(date(2026, 9, 8), 29, 3), "2026-10")
        self.assertEqual(cal.fatura_de(date(2026, 9, 30), 29, 3), "2026-11")
        c = cal.ciclo("2026-10", 29, 3)
        self.assertEqual((c.inicio, c.fechamento, c.vencimento),
                         (date(2026, 8, 30), date(2026, 9, 29), date(2026, 10, 3)))


class ComBanco(unittest.TestCase):
    def setUp(self):
        self.caminho = Path(_TMP.name) / f"{self.id()}.db"
        self.conn = conectar(self.caminho)
        fixar_hoje(date(2026, 9, 15))
        escrita.salvar_config(self.conn, {
            "dia_fechamento": 29, "dia_vencimento": 3,
            "saldo_inicial": 1_000_00, "data_inicio": "2026-09-01",
        })
        self.fulano = escrita.salvar_dono(self.conn, {"nome": "Fulano", "tipo": "PESSOA", "cor": "#22D3EE"})
        self.genesys = escrita.salvar_dono(self.conn, {"nome": "Genesys", "tipo": "ORG", "cor": "#FB923C"})

    def tearDown(self):
        fixar_hoje(None)
        self.conn.close()

    def compra(self, **kw):
        dados = {"descricao": "Teste", "fluxo": "SAIDA", "natureza": "AVULSO",
                 "meio": "CREDITO", "valor": 100_00, "data": "2026-09-10"}
        dados.update(kw)
        return escrita.salvar_compra(self.conn, dados)

    def partes_de(self, compra_id):
        return self.conn.execute(
            "SELECT l.parcela_num, p.dono_id, p.valor, l.fatura_ref FROM lancamento l "
            "JOIN lancamento_parte p ON p.lancamento_id = l.id WHERE l.compra_id = ? "
            "ORDER BY l.data, p.dono_id", (compra_id,)).fetchall()


class Divisao(ComBanco):
    def test_sem_divisao_e_tudo_meu(self):
        cid = self.compra()
        self.assertEqual([(r["dono_id"], r["valor"]) for r in self.partes_de(cid)], [(EU, 100_00)])

    def test_igual_centavo_extra_vai_para_mim(self):
        cid = self.compra(divisao={"modo": "igual", "donos": [self.fulano, self.genesys, EU]})
        partes = {r["dono_id"]: r["valor"] for r in self.partes_de(cid)}
        self.assertEqual(partes, {EU: 3334, self.fulano: 3333, self.genesys: 3333})

    def test_valor_precisa_fechar(self):
        with self.assertRaisesRegex(ErroValidacao, "faltam R\\$ 0,01"):
            self.compra(divisao={"modo": "valor", "partes": [
                {"dono_id": EU, "valor": 50_00}, {"dono_id": self.fulano, "valor": 49_99}]})
        with self.assertRaisesRegex(ErroValidacao, "sobram"):
            self.compra(divisao={"modo": "valor", "partes": [
                {"dono_id": EU, "valor": 60_00}, {"dono_id": self.fulano, "valor": 49_99}]})

    def test_terceiro_sem_mim(self):
        cid = self.compra(divisao={"modo": "igual", "donos": [self.genesys]})
        self.assertEqual([(r["dono_id"], r["valor"]) for r in self.partes_de(cid)],
                         [(self.genesys, 100_00)])

    def test_parcelamento_dividido_proporcional(self):
        cid = self.compra(natureza="PARCELAMENTO", valor=1_000_00, num_parcelas=3,
                          divisao={"modo": "valor", "partes": [
                              {"dono_id": EU, "valor": 600_00},
                              {"dono_id": self.fulano, "valor": 400_00}]})
        linhas = self.partes_de(cid)
        por_dono = {}
        por_parcela = {}
        for r in linhas:
            por_dono[r["dono_id"]] = por_dono.get(r["dono_id"], 0) + r["valor"]
            por_parcela[r["parcela_num"]] = por_parcela.get(r["parcela_num"], 0) + r["valor"]
        self.assertEqual(por_dono, {EU: 600_00, self.fulano: 400_00})
        self.assertEqual(por_parcela, {1: 333_34, 2: 333_33, 3: 333_33})
        faturas = sorted({r["fatura_ref"] for r in linhas})
        self.assertEqual(faturas, ["2026-10", "2026-11", "2026-12"])

    def test_parcela_inicial(self):
        cid = self.compra(natureza="PARCELAMENTO", valor=1_200_00, num_parcelas=12,
                          parcela_inicial=10)
        nums = [r["parcela_num"] for r in self.partes_de(cid)]
        self.assertEqual(nums, [10, 11, 12])

    def test_parcelamento_fim_de_mes_nao_repete_fatura(self):
        cid = self.compra(natureza="PARCELAMENTO", valor=300_00, num_parcelas=3, data="2027-01-30")
        faturas = [r["fatura_ref"] for r in self.partes_de(cid)]
        self.assertEqual(faturas, ["2027-03", "2027-04", "2027-05"])

    def test_dono_arquivado_nao_entra_em_compra_nova(self):
        escrita.arquivar_dono(self.conn, self.fulano, False)
        with self.assertRaisesRegex(ErroValidacao, "arquivado"):
            self.compra(divisao={"modo": "igual", "donos": [EU, self.fulano]})

    def test_editar_compra_de_dono_arquivado(self):
        cid = self.compra(divisao={"modo": "igual", "donos": [EU, self.fulano]})
        escrita.arquivar_dono(self.conn, self.fulano, False)
        escrita.salvar_compra(self.conn, {
            "descricao": "Editada", "fluxo": "SAIDA", "natureza": "AVULSO", "meio": "CREDITO",
            "valor": 80_00, "data": "2026-09-10",
            "divisao": {"modo": "igual", "donos": [EU, self.fulano]}}, cid)
        partes = {r["dono_id"]: r["valor"] for r in self.partes_de(cid)}
        self.assertEqual(partes, {EU: 40_00, self.fulano: 40_00})

    def test_entrada_e_sempre_minha(self):
        cid = self.compra(fluxo="ENTRADA", meio="DEBITO",
                          divisao={"modo": "igual", "donos": [self.fulano]})
        self.assertEqual([r["dono_id"] for r in self.partes_de(cid)], [EU])


class Fixos(ComBanco):
    def refs(self, cid):
        return [r[0] for r in self.conn.execute(
            "SELECT ref FROM lancamento WHERE compra_id = ? ORDER BY ref", (cid,))]

    def test_gera_ate_dois_meses_a_frente(self):
        cid = self.compra(natureza="FIXO", valor=55_90, data="2026-08-05")
        self.assertEqual(self.refs(cid), ["2026-08", "2026-09", "2026-10", "2026-11"])
        fixar_hoje(date(2027, 1, 2))
        escrita.garantir_fixos(self.conn)
        self.assertEqual(self.refs(cid)[-1], "2027-03")

    def test_gera_ate_o_mes_visitado(self):
        cid = self.compra(natureza="FIXO", valor=55_90, data="2026-09-05")
        escrita.garantir_fixos(self.conn, "2027-02")
        self.assertEqual(self.refs(cid)[-1], "2027-02")
        escrita.garantir_fixos(self.conn, "2099-01")  # teto de 3 anos
        self.assertEqual(self.refs(cid)[-1], "2029-09")
        from nucontrole.ponte import Api
        self.assertTrue(Api().mes("2027-03")["ok"])

    def test_pular_mes_nao_volta(self):
        cid = self.compra(natureza="FIXO", valor=55_90, data="2026-09-05")
        lid = self.conn.execute(
            "SELECT id FROM lancamento WHERE compra_id = ? AND ref = '2026-10'", (cid,)).fetchone()[0]
        escrita.pular_mes_fixo(self.conn, lid)
        fixar_hoje(date(2026, 12, 1))
        escrita.garantir_fixos(self.conn)
        self.assertNotIn("2026-10", self.refs(cid))
        self.assertIn("2027-02", self.refs(cid))

    def test_editar_fixo_mantem_passado(self):
        cid = self.compra(natureza="FIXO", valor=50_00, data="2026-07-05", meio="DEBITO")
        escrita.salvar_compra(self.conn, {
            "descricao": "Aluguel", "fluxo": "SAIDA", "natureza": "FIXO", "meio": "DEBITO",
            "valor": 80_00, "data": "2026-07-05",
            "divisao": {"modo": "igual", "donos": [EU, self.fulano]}}, cid)
        valores = dict(self.conn.execute(
            "SELECT ref, valor FROM lancamento WHERE compra_id = ?", (cid,)).fetchall())
        self.assertEqual(valores["2026-07"], 50_00)
        self.assertEqual(valores["2026-08"], 50_00)
        self.assertEqual(valores["2026-09"], 80_00)
        self.assertEqual(valores["2026-11"], 80_00)

    def test_encerrar(self):
        cid = self.compra(natureza="FIXO", valor=50_00, data="2026-09-05")
        escrita.encerrar_fixo(self.conn, cid, "2026-10")
        fixar_hoje(date(2027, 3, 1))
        escrita.garantir_fixos(self.conn)
        self.assertEqual(self.refs(cid), ["2026-09", "2026-10"])

    def test_fixo_dividido(self):
        cid = self.compra(natureza="FIXO", valor=100_01, data="2026-09-05",
                          divisao={"modo": "igual", "donos": [EU, self.fulano]})
        partes = self.partes_de(cid)
        self.assertEqual({(r["dono_id"], r["valor"]) for r in partes},
                         {(EU, 50_01), (self.fulano, 50_00)})


class Saldo(ComBanco):
    def saldo(self):
        return consultas.conta(self.conn, consultas.Config.ler(self.conn))["saldo"]

    def test_credito_nao_move_saldo(self):
        self.compra(meio="CREDITO", valor=500_00)
        self.assertEqual(self.saldo(), 1_000_00)

    def test_debito_move_so_ate_hoje(self):
        self.compra(meio="DEBITO", valor=100_00, data="2026-09-10")
        self.compra(meio="DEBITO", valor=50_00, data="2026-09-20")
        self.assertEqual(self.saldo(), 900_00)
        conta = consultas.conta(self.conn, consultas.Config.ler(self.conn))
        self.assertEqual(conta["a_sair_debito"], 50_00)

    def test_antes_do_inicio_nao_conta(self):
        self.compra(meio="DEBITO", valor=100_00, data="2026-08-31")
        self.assertEqual(self.saldo(), 1_000_00)

    def test_divisao_nao_muda_saldo(self):
        self.compra(meio="DEBITO", valor=300_00,
                    divisao={"modo": "igual", "donos": [EU, self.fulano, self.genesys]})
        self.assertEqual(self.saldo(), 700_00)

    def test_previsao_por_mes(self):
        # hoje 15/09, saldo inicial 1.000
        self.compra(natureza="FIXO", meio="DEBITO", valor=100_00, data="2026-09-20")
        self.compra(meio="CREDITO", valor=200_00, data="2026-09-10")  # fatura 2026-10, vence 03/10
        cfg = consultas.Config.ler(self.conn)
        setembro = consultas.conta(self.conn, cfg, "2026-09")
        self.assertEqual(setembro["saldo"], 1_000_00)
        self.assertEqual(setembro["previsao_fim_mes"], 900_00)
        self.assertEqual(setembro["a_sair_mes"], 100_00)
        outubro = consultas.conta(self.conn, cfg, "2026-10")
        self.assertEqual(outubro["saldo"], 1_000_00)  # saldo e sempre o de hoje
        self.assertEqual(outubro["a_sair_fatura"], 200_00)
        self.assertEqual(outubro["a_sair_debito"], 100_00)
        self.assertEqual(outubro["previsao_fim_mes"], 1_000_00 - 100_00 - 100_00 - 200_00)
        # pagar a fatura antes nao muda a previsao de outubro (so troca de lado)
        escrita.pagar_fatura(self.conn, {"fatura_ref": "2026-10", "valor": 200_00, "data": "2026-10-03"})
        self.assertEqual(consultas.conta(self.conn, cfg, "2026-10")["previsao_fim_mes"], 600_00)
        agosto = consultas.conta(self.conn, cfg, "2026-08")
        self.assertTrue(agosto["mes_passado"])
        self.assertEqual(agosto["previsao_fim_mes"], 1_000_00)

    def test_visao_geral_de_outro_mes(self):
        self.compra(valor=100_00, data="2026-10-05", divisao={"modo": "igual", "donos": [EU, self.fulano]})
        v = consultas.visao_geral(self.conn, "2026-10")
        self.assertFalse(v["mes_atual"])
        self.assertEqual(v["fatura"]["ref"], "2026-10")
        self.assertEqual({g["dono"]["id"]: g["total"] for g in v["gastos_por_dono"]},
                         {EU: 50_00, self.fulano: 50_00})

    def test_pagamento_e_caixinhas(self):
        escrita.pagar_fatura(self.conn, {"fatura_ref": "2026-09", "valor": 200_00, "data": "2026-09-03"})
        rid = escrita.salvar_reserva(self.conn, {"nome": "Reserva", "tipo": "CAIXINHA", "saldo_inicial": 50_00})
        escrita.criar_mov_reserva(self.conn, {"reserva_id": rid, "tipo": "DEPOSITO", "valor": 300_00, "data": "2026-09-05"})
        escrita.criar_mov_reserva(self.conn, {"reserva_id": rid, "tipo": "SAQUE", "valor": 100_00, "data": "2026-09-06"})
        escrita.criar_mov_reserva(self.conn, {"reserva_id": rid, "tipo": "RENDIMENTO", "valor": 1_23, "data": "2026-09-07"})
        self.assertEqual(self.saldo(), 1_000_00 - 200_00 - 300_00 + 100_00)
        r = consultas.reservas(self.conn)["reservas"][0]
        self.assertEqual(r["saldo"], 50_00 + 300_00 - 100_00 + 1_23)
        with self.assertRaisesRegex(ErroValidacao, "insuficiente"):
            escrita.criar_mov_reserva(self.conn, {"reserva_id": rid, "tipo": "SAQUE", "valor": 999_00, "data": "2026-09-08"})


class Telas(ComBanco):
    def test_mes_por_dono(self):
        self.compra(valor=300_00, divisao={"modo": "igual", "donos": [EU, self.fulano, self.genesys]})
        self.compra(valor=40_00, natureza="AVULSO", divisao={"modo": "igual", "donos": [self.genesys]})
        m = consultas.mes(self.conn, "2026-09")
        totais = {a["dono"]["id"]: a["total"] for a in m["abas"]}
        self.assertEqual(totais, {EU: 100_00, self.fulano: 100_00, self.genesys: 140_00})
        self.assertEqual(m["total_saidas"], 340_00)

    def test_fatura_por_dono_fecha_com_total(self):
        self.compra(valor=300_00, divisao={"modo": "igual", "donos": [EU, self.fulano, self.genesys]})
        self.compra(valor=99_99, natureza="PARCELAMENTO", num_parcelas=4,
                    divisao={"modo": "igual", "donos": [EU, self.fulano]})
        f = consultas.fatura(self.conn, "2026-10")
        self.assertEqual(sum(g["valor"] for g in f["por_dono"]), f["total"])
        self.assertEqual(f["por_dono"][0]["dono_id"], EU)
        self.assertEqual(f["status"], "aberta")
        self.assertEqual(f["de_terceiros"], f["total"] - f["por_dono"][0]["valor"])

    def test_status_fatura(self):
        self.compra(valor=100_00, data="2026-08-10")  # fatura 2026-09, vence 03/09
        self.assertEqual(consultas.fatura(self.conn, "2026-09")["status"], "vencida")
        escrita.pagar_fatura(self.conn, {"fatura_ref": "2026-09", "valor": 100_00, "data": "2026-09-03"})
        self.assertEqual(consultas.fatura(self.conn, "2026-09")["status"], "paga")

    def test_fatura_antes_do_controle_nao_e_pendencia(self):
        self.compra(valor=100_00, data="2026-07-10")  # fatura 2026-08, vence 03/08 < inicio 01/09
        self.assertEqual(consultas.fatura(self.conn, "2026-08")["status"], "anterior")
        self.assertEqual(consultas.visao_geral(self.conn)["faturas_pendentes"], 0)

    def test_visao_geral_roda(self):
        self.compra(valor=100_00, divisao={"modo": "igual", "donos": [EU, self.fulano]})
        v = consultas.visao_geral(self.conn)
        self.assertEqual(v["fatura"]["ref"], "2026-10")
        self.assertEqual(v["patrimonio"], v["conta"]["saldo"])

    def test_mudar_ciclo_recalcula_faturas(self):
        cid = self.compra(valor=100_00, data="2026-09-10")
        escrita.salvar_config(self.conn, {"dia_fechamento": 5, "dia_vencimento": 15,
                                          "saldo_inicial": 0, "data_inicio": "2026-09-01"})
        self.assertEqual(self.partes_de(cid)[0]["fatura_ref"], "2026-10")
        escrita.salvar_config(self.conn, {"dia_fechamento": 8, "dia_vencimento": 15,
                                          "saldo_inicial": 0, "data_inicio": "2026-09-01"})
        self.assertEqual(self.partes_de(cid)[0]["fatura_ref"], "2026-10")


class Donos(ComBanco):
    def test_nao_exclui_dono_usado(self):
        self.compra(divisao={"modo": "igual", "donos": [self.fulano]})
        with self.assertRaisesRegex(ErroValidacao, "Arquive"):
            escrita.excluir_dono(self.conn, self.fulano)
        escrita.excluir_dono(self.conn, self.genesys)

    def test_eu_e_protegido(self):
        with self.assertRaises(ErroValidacao):
            escrita.excluir_dono(self.conn, EU)
        with self.assertRaises(ErroValidacao):
            escrita.arquivar_dono(self.conn, EU, False)

    def test_nome_unico_sem_caixa(self):
        with self.assertRaisesRegex(ErroValidacao, "Já existe"):
            escrita.salvar_dono(self.conn, {"nome": "fulano", "tipo": "PESSOA", "cor": "#FFFFFF"})


class Backup(ComBanco):
    def test_exportar_e_restaurar(self):
        from nucontrole import backup
        self.compra(descricao="Antes do backup", divisao={"modo": "igual", "donos": [EU, self.fulano]})
        arquivo = backup.exportar(self.conn, Path(_TMP.name) / "bk" / "meu_backup")
        self.assertEqual(arquivo.suffix, ".db")  # extensao acrescentada
        resumo = backup.validar(arquivo)
        self.assertEqual((resumo["compras"], resumo["terceiros"]), (1, 2))

        # depois do backup: apaga um terceiro e cria outra compra
        escrita.excluir_dono(self.conn, self.genesys)
        self.compra(descricao="Depois do backup")
        copia = backup.restaurar(self.conn, arquivo)

        descricoes = [r[0] for r in self.conn.execute("SELECT descricao FROM compra")]
        self.assertEqual(descricoes, ["Antes do backup"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM dono").fetchone()[0], 3)
        # a copia de seguranca tem o estado de ANTES de restaurar
        self.assertEqual(backup.validar(copia)["compras"], 2)
        # e o banco restaurado continua funcionando normalmente
        self.compra(descricao="Depois de restaurar")
        self.assertEqual(consultas.fatura(self.conn, "2026-10")["total"], 200_00)

    def test_recusa_arquivos_errados(self):
        from nucontrole import backup
        lixo = Path(_TMP.name) / "lixo.db"
        lixo.write_bytes(b"isto nao e um banco" * 100)
        with self.assertRaisesRegex(ErroValidacao, "não é um banco"):
            backup.validar(lixo)
        v1 = Path(_TMP.name) / "v1.db"
        c = __import__("sqlite3").connect(v1)
        c.executescript("CREATE TABLE config(a); CREATE TABLE lancamento(a); CREATE TABLE reserva(a);")
        c.close()
        with self.assertRaisesRegex(ErroValidacao, "versão 1"):
            backup.validar(v1)
        with self.assertRaisesRegex(ErroValidacao, "não encontrado"):
            backup.validar(Path(_TMP.name) / "nao_existe.db")


class Ponte(unittest.TestCase):
    def test_envelope(self):
        from nucontrole.ponte import Api
        api = Api()
        self.assertTrue(api.estado()["ok"])
        r = api.salvar_compra({"descricao": "", "valor": 100})
        self.assertEqual(r, {"ok": False, "erro": "Informe a descrição."})
        self.assertTrue(api.visao_geral()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
