/* Meses e ciclo da fatura.

   Dois conceitos de tempo que o app nunca mistura:

     MES     -- mes do calendario (01/09 a 30/09). "Quanto eu gastei em setembro",
                em qualquer meio de pagamento. Identificado por 'AAAA-MM'.

     FATURA  -- ciclo do cartao (30/08 a 29/09, vence 03/10). "Quanto eu pago dia 3".
                Identificada pelo mes em que VENCE: a fatura '2026-10' acima.

   Datas circulam como texto ISO 'AAAA-MM-DD' (o mesmo formato do Postgres).
   Texto ISO compara certo com < e >, e nao tem fuso horario para atrapalhar. */

export const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const dois = (n) => String(n).padStart(2, "0");

export function iso(ano, mes, dia) {
  return `${String(ano).padStart(4, "0")}-${dois(mes)}-${dois(dia)}`;
}

export function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** Dia 31 em fevereiro vira o ultimo dia de fevereiro. */
export function clampDia(ano, mes, dia) {
  return iso(ano, mes, Math.min(dia, diasNoMes(ano, mes)));
}

/** (2026, 12) + 1 -> [2027, 1]. Aceita delta negativo. */
export function somarMeses(ano, mes, delta) {
  const total = ano * 12 + (mes - 1) + delta;
  const a = Math.floor(total / 12);
  return [a, total - a * 12 + 1];
}

/** '2026-09' -> [2026, 9]. */
export function partes(ref) {
  if (typeof ref !== "string" || !/^\d{4}-\d{2}$/.test(ref)) {
    throw new Error(`mes invalido: ${JSON.stringify(ref)} (use AAAA-MM)`);
  }
  const ano = Number(ref.slice(0, 4));
  const mes = Number(ref.slice(5));
  if (mes < 1 || mes > 12) throw new Error(`mes invalido: ${JSON.stringify(ref)}`);
  return [ano, mes];
}

export function ref(ano, mes) {
  return `${String(ano).padStart(4, "0")}-${dois(mes)}`;
}

/** '2026-09-08' -> '2026-09'. */
export function refDe(data) {
  return data.slice(0, 7);
}

export function somarRef(r, delta) {
  return ref(...somarMeses(...partes(r), delta));
}

/** '2026-09' -> 'Setembro 2026'. */
export function rotulo(r) {
  const [ano, mes] = partes(r);
  return `${MESES[mes - 1]} ${ano}`;
}

/** '2026-09-08' -> [2026, 9, 8]. */
export function partesData(data) {
  return [Number(data.slice(0, 4)), Number(data.slice(5, 7)), Number(data.slice(8, 10))];
}

/** Valida e devolve a data ISO. Lanca Error se nao for uma data real. */
export function dataIso(texto) {
  if (typeof texto !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    throw new Error(`data invalida: ${JSON.stringify(texto)}`);
  }
  const [a, m, d] = partesData(texto);
  if (m < 1 || m > 12 || d < 1 || d > diasNoMes(a, m) || a < 1) {
    throw new Error(`data invalida: ${JSON.stringify(texto)}`);
  }
  return texto;
}

export function somarDias(data, n) {
  const [a, m, d] = partesData(data);
  const t = new Date(Date.UTC(a, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Dia `dia` do mes `r`, respeitando o tamanho do mes. */
export function dataNoMes(r, dia) {
  return clampDia(...partes(r), dia);
}

/** Hoje no fuso do aparelho (nao em UTC: as 22h de Brasilia ainda e hoje). */
export function hojeLocal(agora = new Date()) {
  return iso(agora.getFullYear(), agora.getMonth() + 1, agora.getDate());
}

/** O ciclo da fatura que VENCE no mes `r`. Com fechamento 29 e vencimento 3,
    a fatura '2026-10' e: compras de 30/08/2026 a 29/09/2026, fecha 29/09,
    vence 03/10. O ciclo comeca no dia seguinte ao fechamento anterior, entao
    nenhuma compra cai em duas faturas nem fica de fora -- inclusive em fevereiro. */
export function ciclo(r, diaFechamento, diaVencimento) {
  const [ano, mes] = partes(r);
  const vencimento = clampDia(ano, mes, diaVencimento);
  // Vencimento no inicio do mes (ex.: dia 3) -> fechou no mes anterior.
  // Vencimento depois do fechamento no mesmo mes (ex.: fecha 5, vence 15)
  // -> fechou no proprio mes.
  const delta = diaVencimento > diaFechamento ? 0 : -1;
  const fechamento = clampDia(...somarMeses(ano, mes, delta), diaFechamento);
  const anterior = clampDia(...somarMeses(ano, mes, delta - 1), diaFechamento);
  return { ref: r, rotulo: rotulo(r), inicio: somarDias(anterior, 1), fechamento, vencimento };
}

/** Em qual fatura cai uma compra feita no dia `data`.
    Fecha 29, vence 3: compra em 08/09 -> fecha 29/09 -> vence 03/10 -> '2026-10'.
                      compra em 30/09 -> fecha 29/10 -> vence 03/11 -> '2026-11'. */
export function faturaDe(data, diaFechamento, diaVencimento) {
  const [a, m] = partesData(data);
  const fechamentoDoMes = clampDia(a, m, diaFechamento);
  // [ano, mes] em que a fatura FECHA
  const [ano, mes] = data <= fechamentoDoMes ? [a, m] : somarMeses(a, m, 1);
  const delta = diaVencimento > diaFechamento ? 0 : 1;
  return ref(...somarMeses(ano, mes, delta));
}
