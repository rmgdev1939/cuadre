-- CUADRE · Pendiente de aplicar en Supabase (la herramienta pide confirmación por ser borrado/revocación).
-- 1) Nadie con la clave pública toca la tabla directo (RLS ya lo impide; esto lo deja explícito).
revoke all on public.escucha_avisos from anon, authenticated;
revoke all on function public.escucha_hash(text) from public, anon, authenticated;
revoke all on function public.escucha_publicar(text, text, text, timestamptz) from public;
revoke all on function public.escucha_leer(text, bigint) from public;
grant execute on function public.escucha_publicar(text, text, text, timestamptz) to anon, authenticated;
grant execute on function public.escucha_leer(text, bigint) to anon, authenticated;

-- 2) Los avisos se borran a los 3 días (pg_cron, una vez al día).
create extension if not exists pg_cron;
select cron.schedule('escucha-limpieza', '15 4 * * *',
  $$delete from public.escucha_avisos where creado < now() - interval '3 days'$$);
