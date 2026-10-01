/* Dinheiro e divisao de valores.

   Regra que vale para TODO o projeto: dinheiro e sempre inteiro em centavos,
   do Postgres a tela. R$ 1.234,56 -> 123456. Nenhum valor quebrado atravessa
   uma fronteira, porque em dinheiro 0.1 + 0.2 !== 0.3 e inaceitavel.

   As tres divisoes do app, e a garantia comum a todas: a soma das partes e
   sempre EXATAMENTE o total. Nenhum centavo some e nenhum e inventado.

       dividirIgual(100_00, 3)            -> [33_34, 33_33, 33_33]
       ratear(1000, [1, 1, 1])            -> proporcional a pesos
       ratearMatriz([parcelas], [partes]) -> cada parcela dividida entre os donos */

/** 123456 -> 'R$ 1.234,56'. Negativo vira '-R$ 1.234,56'. */
export function formatarReais(centavos) {
  const n = Math.trunc(Number(centavos));
  const sinal = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const inteiro = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sinal}R$ ${inteiro},${String(abs % 100).padStart(2, "0")}`;
}

/** Aceita o que o usuario digitar e devolve centavos.
      inteiro    -> ja e centavos (e o que o formulario manda)
      '1.234,56' -> 123456   (formato brasileiro)
      '1234.56'  -> 123456
      '1234'     -> 123400 */
export function parseCentavos(valor) {
  if (typeof valor === "boolean") throw new Error("valor invalido");
  if (typeof valor === "number") {
    if (!Number.isSafeInteger(valor)) throw new Error("envie centavos inteiros");
    return valor;
  }
  if (typeof valor !== "string") throw new Error("valor invalido");

  let texto = valor.trim();
  const negativo = texto.startsWith("-");
  texto = texto.replace(/[^\d,.]/g, "");
  if (!texto) throw new Error(`valor invalido: ${JSON.stringify(valor)}`);

  // O ultimo separador presente e o decimal; os outros sao de milhar.
  if (texto.includes(",") && texto.includes(".")) {
    texto = texto.lastIndexOf(",") > texto.lastIndexOf(".")
      ? texto.replace(/\./g, "").replace(",", ".")
      : texto.replace(/,/g, "");
  } else if (texto.includes(",")) {
    texto = texto.replace(/,/g, ".");
  } else if ((texto.match(/\./g) || []).length > 1) {
    texto = texto.replace(/\./g, "");
  }

  const [inteiro, frac = ""] = texto.split(".", 2);
  if (texto.split(".").length > 2) throw new Error(`valor invalido: ${JSON.stringify(valor)}`);
  if (frac.length > 2) throw new Error(`mais de duas casas decimais: ${JSON.stringify(valor)}`);
  const centavos = Number(inteiro || "0") * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(centavos)) throw new Error("valor grande demais");
  return negativo ? -centavos : centavos;
}

/** Divide em N partes iguais. O centavo que sobra vai para as PRIMEIRAS.
    E como o Nubank parcela: R$ 100,00 em 3x -> 33,34 / 33,33 / 33,33.
    Serve tanto para parcelas quanto para "dividir igualmente entre donos". */
export function dividirIgual(total, n) {
  if (n < 1) throw new Error("precisa de pelo menos 1 parte");
  const base = Math.floor(total / n);
  const resto = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
}

/** Divide `total` proporcionalmente a `pesos` (metodo do maior resto).

    Cada parte recebe o piso da sua fatia exata; os centavos que faltam vao
    para as maiores fracoes descartadas (empate: quem vem primeiro). Assim a
    soma fecha exatamente e nenhuma parte fica mais de 1 centavo longe do
    valor proporcional exato. A conta e feita em BigInt: total * peso passa
    facil do limite de precisao de um Number. */
export function ratear(total, pesos) {
  const soma = pesos.reduce((s, p) => s + p, 0);
  if (soma <= 0 || pesos.some((p) => p < 0)) {
    throw new Error("pesos devem ser nao negativos e somar mais que zero");
  }
  const T = BigInt(total);
  const S = BigInt(soma);
  const pisos = pesos.map((p) => (T * BigInt(p)) / S);
  // fracao descartada de cada parte, na mesma escala inteira
  const fracoes = pesos.map((p, i) => T * BigInt(p) - pisos[i] * S);
  let faltam = Number(T - pisos.reduce((s, v) => s + v, 0n));
  const ordem = pesos.map((_, i) => i).sort((a, b) =>
    fracoes[a] > fracoes[b] ? -1 : fracoes[a] < fracoes[b] ? 1 : a - b);
  const r = pisos.map(Number);
  for (const i of ordem) {
    if (faltam-- <= 0) break;
    r[i] += 1;
  }
  return r;
}

/** Divide cada parcela (linha) entre os donos (colunas) proporcionalmente.

    Exemplo: celular de R$ 1.000,00 em 3x, R$ 600 meu e R$ 400 do Fulano.
        linhas  = [333_34, 333_33, 333_33]   (as parcelas)
        colunas = [600_00, 400_00]           (a parte de cada dono)

    Devolve m[i][j] = quanto da parcela i e do dono j, com DUAS garantias:
      - cada linha soma a parcela       (a fatura bate no centavo)
      - cada coluna soma a parte do dono (ninguem paga centavo a mais no total)

    Ratear cada parcela isoladamente nao garante a segunda: o centavo de
    arredondamento cairia sempre no mesmo dono. Por isso cada parcela e
    rateada sobre o que AINDA FALTA de cada dono, e a ultima leva o resto. */
export function ratearMatriz(linhas, colunas) {
  const soma = (xs) => xs.reduce((s, v) => s + v, 0);
  if (soma(linhas) !== soma(colunas)) {
    throw new Error("a soma das parcelas difere da soma das partes");
  }
  let restante = [...colunas];
  const matriz = [];
  linhas.forEach((parcela, i) => {
    let linha;
    if (i === linhas.length - 1) linha = [...restante];
    else if (parcela === 0) linha = colunas.map(() => 0);
    else linha = ratear(parcela, restante);
    restante = restante.map((r, j) => r - linha[j]);
    matriz.push(linha);
  });
  return matriz;
}
