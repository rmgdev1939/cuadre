-- CUADRE · Verificación automática de Pago Móvil (prototipo)
-- La app "Cuadre Escucha" (teléfono del dueño) publica cada aviso de pago del banco
-- en un canal; los teléfonos de caja del mismo comercio lo leen y lo emparejan con la venta.
--
-- Seguridad: el canal es un secreto aleatorio de 128 bits que solo conocen los teléfonos
-- del comercio. En la base se guarda su hash (SHA-256), nunca el canal. Nadie lee ni
-- escribe la tabla directamente: solo las dos funciones de abajo, con la clave pública.
-- Los avisos se borran solos a los 3 días.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.escucha_avisos (
  id         bigint generated always as identity primary key,
  canal_hash text        not null,
  texto      text        not null check (char_length(texto) <= 600),
  origen     text        not null default '' check (char_length(origen) <= 120),
  recibido   timestamptz not null default now(),
  creado     timestamptz not null default now()
);
create index if not exists escucha_avisos_canal_id on public.escucha_avisos (canal_hash, id);

alter table public.escucha_avisos enable row level security;
revoke all on public.escucha_avisos from anon, authenticated;

create or replace function public.escucha_hash(p_canal text)
returns text language sql immutable
set search_path = ''
as $$ select encode(extensions.digest(p_canal, 'sha256'), 'hex') $$;

-- Publica un aviso. Devuelve su id.
create or replace function public.escucha_publicar(p_canal text, p_texto text, p_origen text default '', p_recibido timestamptz default null)
returns bigint language plpgsql security definer
set search_path = ''
as $$
declare nuevo bigint;
begin
  if p_canal is null or char_length(p_canal) < 20 or char_length(p_canal) > 80 then
    raise exception 'canal inválido';
  end if;
  if p_texto is null or char_length(btrim(p_texto)) = 0 then
    raise exception 'aviso vacío';
  end if;
  -- Límite simple contra abuso: 120 avisos por canal en la última hora.
  if (select count(*) from public.escucha_avisos
      where canal_hash = public.escucha_hash(p_canal) and creado > now() - interval '1 hour') >= 120 then
    raise exception 'demasiados avisos';
  end if;
  insert into public.escucha_avisos (canal_hash, texto, origen, recibido)
  values (public.escucha_hash(p_canal), left(p_texto, 600), left(coalesce(p_origen, ''), 120),
          least(coalesce(p_recibido, now()), now()))
  returning id into nuevo;
  delete from public.escucha_avisos where creado < now() - interval '3 days';
  return nuevo;
end $$;

-- Lee los avisos del canal con id mayor que p_desde (máximo 50).
create or replace function public.escucha_leer(p_canal text, p_desde bigint default 0)
returns table (id bigint, texto text, origen text, recibido timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select a.id, a.texto, a.origen, a.recibido
  from public.escucha_avisos a
  where a.canal_hash = public.escucha_hash(p_canal) and a.id > coalesce(p_desde, 0)
  order by a.id
  limit 50
$$;

revoke all on function public.escucha_publicar(text, text, text, timestamptz) from public;
revoke all on function public.escucha_leer(text, bigint) from public;
grant execute on function public.escucha_publicar(text, text, text, timestamptz) to anon, authenticated;
grant execute on function public.escucha_leer(text, bigint) to anon, authenticated;
