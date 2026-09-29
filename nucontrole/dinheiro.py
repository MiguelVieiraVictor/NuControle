"""
Dinheiro e divisao de valores.

Regra que vale para TODO o projeto: dinheiro e sempre `int` em centavos,
do SQLite ao JavaScript. R$ 1.234,56 -> 123456. Nenhum float atravessa uma
fronteira, porque em dinheiro `0.1 + 0.2 != 0.3` e inaceitavel.

As tres divisoes do app, e a garantia comum a todas: a soma das partes e
sempre EXATAMENTE o total. Nenhum centavo some e nenhum e inventado.

    dividir_igual(100_00, 3)            -> [33_34, 33_33, 33_33]
    ratear(1000, [1, 1, 1])             -> proporcional a pesos
    ratear_matriz([parcelas], [partes]) -> cada parcela dividida entre os donos
"""

from __future__ import annotations

import re


def formatar_reais(centavos: int) -> str:
    """123456 -> 'R$ 1.234,56'. Negativo vira '-R$ 1.234,56'."""
    sinal = "-" if centavos < 0 else ""
    inteiro, resto = divmod(abs(int(centavos)), 100)
    return f"{sinal}R$ {inteiro:,d}".replace(",", ".") + f",{resto:02d}"


def parse_centavos(valor: str | int) -> int:
    """Aceita o que o usuario digitar e devolve centavos.

    int  -> ja e centavos (e o que o front manda)
    '1.234,56' -> 123456   (formato brasileiro)
    '1234.56'  -> 123456
    '1234'     -> 123400
    """
    if isinstance(valor, bool):
        raise ValueError("valor invalido")
    if isinstance(valor, int):
        return valor
    if isinstance(valor, float):
        raise ValueError("envie centavos inteiros, nao float")

    texto = str(valor).strip()
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

    inteiro, _, frac = texto.partition(".")
    if len(frac) > 2:
        raise ValueError(f"mais de duas casas decimais: {valor!r}")
    centavos = int(inteiro or "0") * 100 + int((frac + "00")[:2])
    return -centavos if negativo else centavos


def dividir_igual(total: int, n: int) -> list[int]:
    """Divide em N partes iguais. O centavo que sobra vai para as PRIMEIRAS.

    E como o Nubank parcela: R$ 100,00 em 3x -> 33,34 / 33,33 / 33,33.
    Serve tanto para parcelas quanto para "dividir igualmente entre donos".
    """
    if n < 1:
        raise ValueError("precisa de pelo menos 1 parte")
    base, resto = divmod(int(total), n)
    return [base + (1 if i < resto else 0) for i in range(n)]


def ratear(total: int, pesos: list[int]) -> list[int]:
    """Divide `total` proporcionalmente a `pesos` (metodo do maior resto).

    Cada parte recebe o piso da sua fatia exata; os centavos que faltam vao
    para as maiores fracoes descartadas (empate: quem vem primeiro). Assim a
    soma fecha exatamente e nenhuma parte fica mais de 1 centavo longe do
    valor proporcional exato.
    """
    soma = sum(pesos)
    if soma <= 0 or any(p < 0 for p in pesos):
        raise ValueError("pesos devem ser nao negativos e somar mais que zero")

    pisos = [total * p // soma for p in pesos]
    # fracao descartada de cada parte, na mesma escala inteira (sem float)
    fracoes = [total * p - piso * soma for p, piso in zip(pesos, pisos)]
    faltam = total - sum(pisos)
    ordem = sorted(range(len(pesos)), key=lambda i: (-fracoes[i], i))
    for i in ordem[:faltam]:
        pisos[i] += 1
    return pisos


def ratear_matriz(linhas: list[int], colunas: list[int]) -> list[list[int]]:
    """Divide cada parcela (linha) entre os donos (colunas) proporcionalmente.

    Exemplo: celular de R$ 1.000,00 em 3x, R$ 600 meu e R$ 400 do Fulano.
        linhas  = [333_34, 333_33, 333_33]   (as parcelas)
        colunas = [600_00, 400_00]           (a parte de cada dono)

    Devolve m[i][j] = quanto da parcela i e do dono j, com DUAS garantias:
      - cada linha soma a parcela       (a fatura bate no centavo)
      - cada coluna soma a parte do dono (ninguem paga centavo a mais no total)

    Ratear cada parcela isoladamente nao garante a segunda: o centavo de
    arredondamento cairia sempre no mesmo dono. Por isso cada parcela e
    rateada sobre o que AINDA FALTA de cada dono, e a ultima leva o resto.
    """
    if sum(linhas) != sum(colunas):
        raise ValueError("a soma das parcelas difere da soma das partes")

    restante = list(colunas)
    matriz: list[list[int]] = []
    for i, parcela in enumerate(linhas):
        if i == len(linhas) - 1:
            linha = list(restante)
        elif parcela == 0:
            linha = [0] * len(colunas)
        else:
            linha = ratear(parcela, restante)
        restante = [r - v for r, v in zip(restante, linha)]
        matriz.append(linha)
    return matriz
