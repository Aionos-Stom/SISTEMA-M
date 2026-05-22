/* ================================================================
   SISTEMA M — MEJORAS, CORRECCIONES Y OPTIMIZACIONES
   Ejecutar DESPUÉS de supabase_setup.sql
   Supabase → SQL Editor → New Query
   ================================================================

   Este archivo corrige:
   1. Política SELECT duplicada en usuarios (causa comportamiento inesperado)
   2. Función register_user_profile (faltaba — causaba fallo al registrar)
   3. Función delete_auth_user (faltaba — causaba error al eliminar usuarios)
   4. Índices compuestos para mejorar rendimiento de consultas frecuentes
   5. Funciones de seguridad con SET search_path (previene SQL injection)
   6. Política de auditoría anon más restrictiva
   7. Función insert_audit_log como SECURITY DEFINER (evita fallos de RLS)
   ================================================================ */


/* ────────────────────────────────────────────────────────────────
   FIX 1: Corregir política SELECT duplicada en usuarios
   Tener dos políticas SELECT (usuarios_select + usuarios_select_admin)
   causa evaluación ambigua. Se consolida en una sola.
   ──────────────────────────────────────────────────────────────── */
DROP POLICY IF EXISTS "usuarios_select"        ON usuarios;
DROP POLICY IF EXISTS "usuarios_select_admin"  ON usuarios;

CREATE POLICY "usuarios_select"
  ON usuarios FOR SELECT
  TO authenticated
  USING (
    auth_user_id = auth.uid()          -- siempre puede ver su propio perfil
    OR get_mi_estado() = 'aprobado'    -- aprobados ven a todos
    OR get_mi_rol()   = 'Administrador'-- admin ve pendientes/rechazados
  );


/* ────────────────────────────────────────────────────────────────
   FIX 2: Función register_user_profile
   Era llamada desde el frontend pero NO EXISTÍA en la BD.
   El primer usuario registrado se aprueba automáticamente como Admin.
   ──────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION register_user_profile(
  p_auth_user_id    UUID,
  p_nombre_completo TEXT,
  p_username        TEXT,
  p_email           TEXT,
  p_telefono        TEXT    DEFAULT '',
  p_rol             TEXT    DEFAULT 'Registrador',
  p_provincia       TEXT    DEFAULT '',
  p_region          TEXT    DEFAULT '',
  p_municipio       TEXT    DEFAULT '',
  p_distrito        TEXT    DEFAULT '',
  p_zona            TEXT    DEFAULT ''
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado  estado_enum := 'pendiente';
  v_count   BIGINT;
BEGIN
  -- Verificar que el auth_user_id pertenece al usuario actual
  IF p_auth_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No autorizado: no puede crear perfiles de otros usuarios';
  END IF;

  -- El primer usuario registrado se aprueba automáticamente
  SELECT COUNT(*) INTO v_count FROM usuarios;
  IF v_count = 0 THEN
    v_estado := 'aprobado';
  END IF;

  INSERT INTO usuarios (
    auth_user_id, nombre_completo, username, email, telefono,
    rol, provincia, region, municipio, distrito, zona, estado
  ) VALUES (
    p_auth_user_id,
    TRIM(p_nombre_completo),
    TRIM(p_username),
    LOWER(TRIM(p_email)),
    COALESCE(TRIM(p_telefono), ''),
    p_rol::rol_enum,
    COALESCE(TRIM(p_provincia), ''),
    COALESCE(TRIM(p_region),    ''),
    COALESCE(TRIM(p_municipio), ''),
    COALESCE(TRIM(p_distrito),  ''),
    COALESCE(TRIM(p_zona),      ''),
    v_estado
  );

  RETURN json_build_object('estado', v_estado::TEXT, 'ok', TRUE);

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'El usuario o correo ya existe en el sistema';
  WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Rol inválido: %', p_rol;
END;
$$;

-- Usuarios autenticados pueden llamarla al registrarse
GRANT EXECUTE ON FUNCTION register_user_profile(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;


/* ────────────────────────────────────────────────────────────────
   FIX 3: Función delete_auth_user
   Era llamada desde el frontend pero NO EXISTÍA.
   Solo administradores pueden ejecutarla.
   ──────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION delete_auth_user(p_auth_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  -- Solo administradores aprobados
  IF get_mi_rol()    IS DISTINCT FROM 'Administrador'
  OR get_mi_estado() IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'Permiso denegado: solo Administradores aprobados pueden eliminar usuarios';
  END IF;

  -- No puede eliminarse a sí mismo
  IF p_auth_user_id = auth.uid() THEN
    RAISE EXCEPTION 'No puede eliminar su propia cuenta de esta forma';
  END IF;

  -- Eliminar de auth.users (el CASCADE borrará el perfil en usuarios)
  DELETE FROM auth.users WHERE id = p_auth_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_auth_user(UUID) TO authenticated;


/* ────────────────────────────────────────────────────────────────
   FIX 4: Función insert_audit_log (SECURITY DEFINER)
   Permite a usuarios con permisos limitados insertar logs de auditoría
   sin que la política RLS les bloquee.
   ──────────────────────────────────────────────────────────────── */
CREATE OR REPLACE FUNCTION insert_audit_log(
  p_accion   TEXT,
  p_objetivo TEXT DEFAULT NULL,
  p_detalles TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile usuarios%ROWTYPE;
BEGIN
  SELECT * INTO v_profile FROM usuarios WHERE auth_user_id = auth.uid();

  INSERT INTO auditoria (
    actor_id, actor_nombre, actor_rol,
    accion, objetivo, detalles, created_at
  ) VALUES (
    auth.uid(),
    COALESCE(v_profile.nombre_completo, v_profile.username, 'Sistema'),
    COALESCE(v_profile.rol::TEXT, '—'),
    p_accion,
    SUBSTRING(COALESCE(p_objetivo, ''), 1, 255),
    SUBSTRING(COALESCE(p_detalles, ''), 1, 1000),
    NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION insert_audit_log(TEXT, TEXT, TEXT) TO authenticated;


/* ────────────────────────────────────────────────────────────────
   FIX 5: Reconstruir funciones de seguridad con SET search_path
   (previene ataques de search_path injection en funciones SECURITY DEFINER)
   ──────────────────────────────────────────────────────────────── */

CREATE OR REPLACE FUNCTION get_mi_rol()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT rol::TEXT FROM usuarios WHERE auth_user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION get_mi_estado()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT estado::TEXT FROM usuarios WHERE auth_user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION get_mi_provincia()
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT provincia FROM usuarios WHERE auth_user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION get_mi_nivel()
RETURNS INT LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT CASE get_mi_rol()
    WHEN 'Administrador' THEN 5
    WHEN 'Coordinador'   THEN 4
    WHEN 'Supervisor'    THEN 3
    WHEN 'Registrador'   THEN 2
    WHEN 'Observador'    THEN 1
    ELSE 0
  END
$$;

CREATE OR REPLACE FUNCTION get_email_from_username(p_username TEXT)
RETURNS TEXT LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT email FROM usuarios WHERE LOWER(username) = LOWER(p_username) LIMIT 1
$$;

CREATE OR REPLACE FUNCTION check_username_exists(p_username TEXT)
RETURNS BOOLEAN LANGUAGE SQL SECURITY DEFINER STABLE
SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM usuarios WHERE LOWER(username) = LOWER(p_username))
$$;

-- Asegurar permisos en funciones públicas
GRANT EXECUTE ON FUNCTION get_email_from_username(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION check_username_exists(TEXT)   TO anon, authenticated;


/* ────────────────────────────────────────────────────────────────
   FIX 6: Política anon de auditoría más restrictiva
   Evita que usuarios anónimos inserten entradas con datos arbitrarios
   ──────────────────────────────────────────────────────────────── */
DROP POLICY IF EXISTS "auditoria_insert_anon_failed_login" ON auditoria;

CREATE POLICY "auditoria_insert_anon_failed_login"
  ON auditoria FOR INSERT
  TO anon
  WITH CHECK (
    accion    = 'SESSION_LOGIN_FAILED'
    AND actor_id IS NULL
    AND LENGTH(COALESCE(detalles, '')) <= 500  -- limitar tamaño
    AND actor_rol = '—'                         -- rol siempre —
  );


/* ────────────────────────────────────────────────────────────────
   FIX 7: Índices adicionales para mejorar el rendimiento
   ──────────────────────────────────────────────────────────────── */

-- Índice compuesto para filtrar por provincia + fecha (Coordinador)
CREATE INDEX IF NOT EXISTS idx_registros_prov_date
  ON registros(provincia, created_at DESC);

-- Índice compuesto para ver registros propios + fecha (Registrador)
CREATE INDEX IF NOT EXISTS idx_registros_reg_date
  ON registros(registrado_por_id, created_at DESC);

-- Índice case-insensitive para username (búsqueda de login)
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_username_ci
  ON usuarios(LOWER(username));

-- Índice case-insensitive para email
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_ci
  ON usuarios(LOWER(email));

-- Índice parcial en auditoría: solo registros recientes (últimos 90 días)
-- Acelera el dashboard de auditoría sin afectar el histórico completo
CREATE INDEX IF NOT EXISTS idx_auditoria_recent
  ON auditoria(created_at DESC)
  WHERE created_at > (NOW() - INTERVAL '90 days');

-- Índice en auditoria por actor (para filtros de auditoría)
CREATE INDEX IF NOT EXISTS idx_auditoria_actor_nombre
  ON auditoria(actor_nombre, created_at DESC);


/* ────────────────────────────────────────────────────────────────
   VERIFICACIÓN FINAL
   Ejecuta esto para confirmar que todo se creó correctamente
   ──────────────────────────────────────────────────────────────── */

-- Verificar funciones
SELECT
  routine_name    AS funcion,
  security_type   AS seguridad
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_mi_rol', 'get_mi_estado', 'get_mi_provincia', 'get_mi_nivel',
    'get_email_from_username', 'check_username_exists',
    'register_user_profile', 'delete_auth_user', 'insert_audit_log'
  )
ORDER BY routine_name;

-- Verificar índices
SELECT
  indexname  AS indice,
  tablename  AS tabla,
  indexdef   AS definicion
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('usuarios', 'registros', 'auditoria')
ORDER BY tablename, indexname;

-- Verificar políticas RLS
SELECT
  tablename   AS tabla,
  policyname  AS politica,
  cmd         AS operacion,
  roles
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;
