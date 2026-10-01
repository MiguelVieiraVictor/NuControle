-- Confere a seguranca do banco. Rode no SQL Editor depois do schema.sql.
-- Todas as linhas precisam sair com "ok" = true.

select 'RLS ligado em ' || c.relname as item, c.relrowsecurity as ok
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'

union all
select 'politica so_o_dono em ' || c.relname,
       exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.policyname = 'so_o_dono')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'

union all
select 'anon sem acesso a ' || c.relname,
       not has_table_privilege('anon', c.oid, 'select')
       and not has_table_privilege('anon', c.oid, 'insert')
       and not has_table_privilege('anon', c.oid, 'update')
       and not has_table_privilege('anon', c.oid, 'delete')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'

union all
select 'anon nao executa aplicar', not has_function_privilege('anon', 'public.aplicar(jsonb)', 'execute')

union all
select 'aplicar roda como quem chama (security invoker)',
       not (select prosecdef from pg_proc where oid = 'public.aplicar(jsonb)'::regprocedure)

order by ok, item;
