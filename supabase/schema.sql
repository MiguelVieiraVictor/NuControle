-- =============================================================================
-- NuControle -- banco no Supabase
--
-- Como aplicar: Supabase -> SQL Editor -> New query -> cole ESTE ARQUIVO
-- INTEIRO -> Run. Rode uma vez so, num projeto novo.
--
-- Seguranca (o que impede um usuario de ver ou mexer nos dados de outro):
--   1. Toda tabela tem user_id, preenchido pelo proprio banco com auth.uid().
--   2. RLS ligado em todas: cada usuario so enxerga, cria, altera e apaga
--      linhas com o SEU user_id.
--   3. Referencias entre tabelas incluem o user_id: uma compra so pode
--      apontar para categoria/dono do mesmo usuario.
--   4. O papel "anon" (quem nao fez login) nao tem acesso a nada.
--
-- Dinheiro e sempre bigint em centavos (R$ 1.234,56 = 123456).
-- Os ids sao UUID v7 gerados pelo site.
-- =============================================================================

-- ------------------------------------------------------------------ tabelas

create table public.config (
  id             uuid primary key,
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  dia_fechamento smallint not null check (dia_fechamento between 1 and 31),
  dia_vencimento smallint not null check (dia_vencimento between 1 and 31),
  saldo_inicial  bigint not null default 0 check (saldo_inicial >= 0),
  data_inicio    date not null,
  unique (user_id),
  check (dia_fechamento <> dia_vencimento)
);

-- Donos de gasto: "Eu" (um por usuario) e os terceiros que ele cadastra.
create table public.dono (
  id        uuid primary key,
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome      text not null check (length(nome) between 1 and 200),
  tipo      text not null check (tipo in ('EU', 'PESSOA', 'ORG')),
  cor       text not null check (cor ~ '^#[0-9A-Fa-f]{6}$'),
  ativo     boolean not null default true,
  criado_em date not null default current_date,
  unique (user_id, id)
);
create unique index dono_nome_unico on public.dono (user_id, lower(nome));
create unique index dono_um_eu on public.dono (user_id) where tipo = 'EU';

create table public.categoria (
  id      uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome    text not null check (length(nome) between 1 and 200),
  cor     text not null check (cor ~ '^#[0-9A-Fa-f]{6}$'),
  ativa   boolean not null default true,
  unique (user_id, id)
);
create unique index categoria_nome_unico on public.categoria (user_id, lower(nome));

-- Caixinhas e fundos imobiliarios.
create table public.reserva (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  nome          text not null check (length(nome) between 1 and 200),
  tipo          text not null check (tipo in ('CAIXINHA', 'FUNDO')),
  saldo_inicial bigint not null default 0 check (saldo_inicial >= 0),
  meta          bigint check (meta is null or meta > 0),
  criada_em     date not null default current_date,
  unique (user_id, id)
);

-- DEPOSITO: conta -> reserva.  SAQUE: reserva -> conta.
-- RENDIMENTO: a reserva cresce sem tocar na conta (juros, dividendo).
create table public.mov_reserva (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reserva_id uuid not null,
  data       date not null,
  tipo       text not null check (tipo in ('DEPOSITO', 'SAQUE', 'RENDIMENTO')),
  valor      bigint not null check (valor > 0),
  descricao  text not null default '' check (length(descricao) <= 200),
  criado_em  date not null default current_date,
  foreign key (user_id, reserva_id) references public.reserva (user_id, id) on delete cascade
);
create index mov_reserva_reserva on public.mov_reserva (reserva_id);

-- O que o usuario digitou: uma compra avulsa, um parcelamento ou um fixo.
--   AVULSO / PARCELAMENTO: valor e o total da compra.
--   FIXO: valor e o de CADA mes; dia, inicio_ref e fim_ref dizem quando acontece.
create table public.compra (
  id              uuid primary key,
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  descricao       text not null check (length(descricao) between 1 and 200),
  fluxo           text not null check (fluxo in ('SAIDA', 'ENTRADA')),
  natureza        text not null check (natureza in ('AVULSO', 'PARCELAMENTO', 'FIXO')),
  meio            text not null check (meio in ('CREDITO', 'DEBITO')),
  categoria_id    uuid,
  valor           bigint not null check (valor > 0),
  data            date not null,
  num_parcelas    smallint not null default 1 check (num_parcelas between 1 and 120),
  parcela_inicial smallint not null default 1,
  dia             smallint check (dia is null or dia between 1 and 31),
  inicio_ref      text check (inicio_ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fim_ref         text check (fim_ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  observacao      text not null default '' check (length(observacao) <= 200),
  criado_em       date not null default current_date,
  check (parcela_inicial between 1 and num_parcelas),
  unique (user_id, id),
  -- apagar a categoria deixa a compra "sem categoria" (so a coluna categoria_id vira null)
  foreign key (user_id, categoria_id) references public.categoria (user_id, id) on delete set null (categoria_id)
);
create index compra_categoria on public.compra (categoria_id);

-- A divisao da compra entre donos. Soma sempre igual a compra.valor.
create table public.compra_parte (
  id        uuid primary key,
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  compra_id uuid not null,
  dono_id   uuid not null,
  valor     bigint not null check (valor > 0),
  unique (compra_id, dono_id),
  foreign key (user_id, compra_id) references public.compra (user_id, id) on delete cascade,
  foreign key (user_id, dono_id) references public.dono (user_id, id)
);
create index compra_parte_dono on public.compra_parte (dono_id);

-- Cada ocorrencia concreta: a compra avulsa, cada parcela, cada mes do fixo.
create table public.lancamento (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  compra_id     uuid not null,
  data          date not null,
  ref           text not null check (ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- mes da data
  valor         bigint not null check (valor > 0),
  fatura_ref    text check (fatura_ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- so no credito
  parcela_num   smallint,
  parcela_total smallint,
  unique (user_id, id),
  foreign key (user_id, compra_id) references public.compra (user_id, id) on delete cascade
);
create index lancamento_compra on public.lancamento (compra_id);

-- A divisao de CADA ocorrencia entre donos. Soma sempre igual a lancamento.valor.
create table public.lancamento_parte (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lancamento_id uuid not null,
  dono_id       uuid not null,
  valor         bigint not null check (valor >= 0),
  unique (lancamento_id, dono_id),
  foreign key (user_id, lancamento_id) references public.lancamento (user_id, id) on delete cascade,
  foreign key (user_id, dono_id) references public.dono (user_id, id)
);
create index lancamento_parte_dono on public.lancamento_parte (dono_id);

-- Quais meses de cada fixo ja foram gerados. Sobrevive a exclusao do
-- lancamento: um mes que voce pulou de proposito nao volta sozinho.
-- O UNIQUE tambem impede dois aparelhos de gerarem o mesmo mes ao mesmo tempo.
create table public.fixo_gerado (
  id        uuid primary key,
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  compra_id uuid not null,
  ref       text not null check (ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  unique (compra_id, ref),
  foreign key (user_id, compra_id) references public.compra (user_id, id) on delete cascade
);

create table public.pagamento_fatura (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fatura_ref text not null check (fatura_ref ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  data       date not null,
  valor      bigint not null check (valor > 0),
  criado_em  date not null default current_date
);
create index pagamento_fatura_user on public.pagamento_fatura (user_id);

-- ------------------------------------------------------------------ seguranca

do $$
declare
  t text;
begin
  foreach t in array array[
    'config', 'dono', 'categoria', 'reserva', 'mov_reserva', 'compra',
    'compra_parte', 'lancamento', 'lancamento_parte', 'fixo_gerado', 'pagamento_fatura'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy so_o_dono on public.%I for all to authenticated '
      'using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    -- quem nao fez login: nada. Quem fez: so o basico (TRUNCATE ignoraria o RLS).
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- ------------------------------------------------------------------ aplicar
--
-- Aplica de uma vez, numa transacao so, as alteracoes que o site calculou
-- (ver frontend/js/nucleo/banco.js). Tudo ou nada: se uma parte falha, nada
-- e gravado -- uma compra nunca fica sem as parcelas.
--
-- Roda com as permissoes de QUEM CHAMA (security invoker), entao o RLS vale
-- normalmente: a funcao nao permite nada que a API comum ja nao permitisse.
--
-- ops: [{"op": "inserir",   "tabela": "compra", "linhas": [{...}, ...]},
--       {"op": "atualizar", "tabela": "compra", "linhas": [{"id": ..., campo: ...}]},
--       {"op": "apagar",    "tabela": "compra", "ids": [...]}]
--
-- "atualizar" e "apagar" exigem que TODAS as linhas existam. Se alguma sumiu
-- (apagada em outro aparelho), da erro 40001 e o site recarrega os dados.

create or replace function public.aplicar(ops jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  op       jsonb;
  tipo     text;
  tabela   text;
  linhas   jsonb;
  colunas  text[];
  lista    text;
  sets     text;
  ids      uuid[];
  n        bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'Faça login novamente.' using errcode = '28000';
  end if;
  if jsonb_typeof(ops) is distinct from 'array' then
    raise exception 'Operações inválidas.' using errcode = '22023';
  end if;

  for op in select value from jsonb_array_elements(ops) loop
    tipo := op->>'op';
    tabela := op->>'tabela';
    if tabela is null or not (tabela = any (array[
      'config', 'dono', 'categoria', 'reserva', 'mov_reserva', 'compra',
      'compra_parte', 'lancamento', 'lancamento_parte', 'fixo_gerado', 'pagamento_fatura'
    ])) then
      raise exception 'Tabela inválida: %', tabela using errcode = '22023';
    end if;

    if tipo = 'apagar' then
      if jsonb_typeof(op->'ids') is distinct from 'array' then
        raise exception 'Operação inválida.' using errcode = '22023';
      end if;
      select coalesce(array_agg(distinct value::uuid), '{}') into ids
        from jsonb_array_elements_text(op->'ids');
      execute format('delete from public.%I where id = any ($1)', tabela) using ids;
      get diagnostics n = row_count;
      if n <> cardinality(ids) then
        raise exception 'Os dados mudaram em outro aparelho.' using errcode = '40001';
      end if;

    elsif tipo in ('inserir', 'atualizar') then
      linhas := op->'linhas';
      if jsonb_typeof(linhas) is distinct from 'array' or jsonb_array_length(linhas) = 0
         or jsonb_typeof(linhas->0) is distinct from 'object' then
        raise exception 'Operação inválida.' using errcode = '22023';
      end if;
      select array_agg(k order by k) into colunas from jsonb_object_keys(linhas->0) as c(k);
      if 'user_id' = any (colunas) or not ('id' = any (colunas)) then
        raise exception 'Operação inválida.' using errcode = '22023';
      end if;

      if tipo = 'inserir' then
        select string_agg(format('%I', k), ', ') into lista from unnest(colunas) as c(k);
        execute format(
          'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
          tabela, lista, lista, tabela) using linhas;
      else
        select string_agg(format('%I = r.%I', k, k), ', ') into sets
          from unnest(colunas) as c(k) where k <> 'id';
        if sets is null then
          raise exception 'Operação inválida.' using errcode = '22023';
        end if;
        execute format(
          'update public.%I as t set %s from jsonb_populate_recordset(null::public.%I, $1) as r where t.id = r.id',
          tabela, sets, tabela) using linhas;
        get diagnostics n = row_count;
        if n <> jsonb_array_length(linhas) then
          raise exception 'Os dados mudaram em outro aparelho.' using errcode = '40001';
        end if;
      end if;

    else
      raise exception 'Operação inválida: %', tipo using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke all on function public.aplicar(jsonb) from public, anon;
grant execute on function public.aplicar(jsonb) to authenticated;
