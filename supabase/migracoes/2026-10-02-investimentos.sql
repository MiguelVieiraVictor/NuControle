-- Investimentos: ajuste do fundo e dividendo que cai na conta.
-- Rode UMA vez no SQL Editor do Supabase, em quem ja rodou o schema.sql antes
-- de 02/10/2026. (Quem rodar o schema.sql novo nao precisa disto.)

begin;

-- Fundo valoriza / desvaloriza sem tocar na conta.
alter table public.mov_reserva drop constraint mov_reserva_tipo_check;
alter table public.mov_reserva add constraint mov_reserva_tipo_check
  check (tipo in ('DEPOSITO', 'SAQUE', 'RENDIMENTO', 'VALORIZACAO', 'DESVALORIZACAO'));

-- Dividendo: uma entrada na conta que lembra de qual fundo veio.
alter table public.compra add column reserva_id uuid;
alter table public.compra add constraint compra_reserva_fk
  foreign key (user_id, reserva_id) references public.reserva (user_id, id) on delete set null (reserva_id);
create index compra_reserva on public.compra (reserva_id);

commit;
