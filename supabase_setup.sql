/* ================================================================
   SISTEMA M — PERAVIA
   Schema completo para Supabase
   Ejecutar en: Supabase → SQL Editor → New Query
   ================================================================ */


/* ────────────────────────────────────────────────────────────────
   PASO 1: TIPOS ENUMERADOS
   ──────────────────────────────────────────────────────────────── */

-- Roles del sistema
CREATE TYPE rol_enum AS ENUM (
  'Administrador',
  'Coordinador',
  'Supervisor',
  'Registrador',
  'Observador'
);

-- Estado de usuarios
CREATE TYPE estado_enum AS ENUM (
  'aprobado',
  'pendiente',
  'rechazado'
);


/* ────────────────────────────────────────────────────────────────
   PASO 2: TABLA — usuarios
   ──────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS usuarios (
  id               BIGSERIAL         PRIMARY KEY,
  auth_user_id     UUID              NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  nombre_completo  TEXT              NOT NULL,
  username         TEXT              NOT NULL UNIQUE,
  email            TEXT              NOT NULL UNIQUE,
  telefono         TEXT,
  rol              rol_enum          NOT NULL DEFAULT 'Observador',
  provincia        TEXT,             -- municipio asignado (Baní, Nizao, etc.)
  region           TEXT,             -- región dentro del municipio
  municipio        TEXT,             -- sección
  distrito         TEXT,
  zona             TEXT              NOT NULL DEFAULT '',
  estado           estado_enum       NOT NULL DEFAULT 'pendiente',
  created_at       TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ       NOT NULL DEFAULT now()
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_usuarios_auth_id    ON usuarios(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_username   ON usuarios(username);
CREATE INDEX IF NOT EXISTS idx_usuarios_email      ON usuarios(email);
CREATE INDEX IF NOT EXISTS idx_usuarios_rol        ON usuarios(rol);
CREATE INDEX IF NOT EXISTS idx_usuarios_provincia  ON usuarios(provincia);
CREATE INDEX IF NOT EXISTS idx_usuarios_estado     ON usuarios(estado);


/* ────────────────────────────────────────────────────────────────
   PASO 3: TABLA — registros (ciudadanos)
   ──────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS registros (
  id                     BIGSERIAL     PRIMARY KEY,
  nombre                 TEXT          NOT NULL,
  cedula                 TEXT          NOT NULL UNIQUE,
  telefono               TEXT,
  provincia              TEXT,         -- municipio (Baní, Nizao, etc.)
  region                 TEXT,
  municipio              TEXT,         -- sección
  distrito               TEXT,
  zona                   TEXT,
  sector                 TEXT,
  mesa                   TEXT,
  recinto                TEXT,
  observacion            TEXT,
  registrado_por_id      UUID,         -- auth.uid() del registrador
  registrado_por_nombre  TEXT,
  registrado_por_rol     TEXT,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_registros_cedula       ON registros(cedula);
CREATE INDEX IF NOT EXISTS idx_registros_nombre       ON registros USING gin(to_tsvector('spanish', nombre));
CREATE INDEX IF NOT EXISTS idx_registros_provincia    ON registros(provincia);
CREATE INDEX IF NOT EXISTS idx_registros_zona         ON registros(zona);
CREATE INDEX IF NOT EXISTS idx_registros_sector       ON registros(sector);
CREATE INDEX IF NOT EXISTS idx_registros_mesa         ON registros(mesa);
CREATE INDEX IF NOT EXISTS idx_registros_registrador  ON registros(registrado_por_id);
CREATE INDEX IF NOT EXISTS idx_registros_created      ON registros(created_at DESC);


/* ────────────────────────────────────────────────────────────────
   PASO 4: TABLA — auditoria
   ──────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS auditoria (
  id            BIGSERIAL     PRIMARY KEY,
  actor_id      UUID,         -- auth.uid() del actor
  actor_nombre  TEXT,
  actor_rol     TEXT,
  accion        TEXT          NOT NULL,
  objetivo      TEXT,         -- ID o nombre del objeto afectado
  detalles      TEXT,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_auditoria_actor    ON auditoria(actor_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_accion   ON auditoria(accion);
CREATE INDEX IF NOT EXISTS idx_auditoria_created  ON auditoria(created_at DESC);


/* ────────────────────────────────────────────────────────────────
   PASO 5: TRIGGER — updated_at automático
   ──────────────────────────────────────────────────────────────── */

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_usuarios_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_registros_updated_at
  BEFORE UPDATE ON registros
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


/* ────────────────────────────────────────────────────────────────
   PASO 6: FUNCIONES DE SEGURIDAD (necesarias para RLS)
   Estas funciones corren con privilegios elevados para poder
   leer el rol del usuario actual sin romper RLS.
   ──────────────────────────────────────────────────────────────── */

-- Retorna el rol del usuario autenticado actual
CREATE OR REPLACE FUNCTION get_mi_rol()
RETURNS TEXT AS $$
  SELECT rol::TEXT
  FROM   usuarios
  WHERE  auth_user_id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Retorna el estado del usuario autenticado actual
CREATE OR REPLACE FUNCTION get_mi_estado()
RETURNS TEXT AS $$
  SELECT estado::TEXT
  FROM   usuarios
  WHERE  auth_user_id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Retorna la provincia del usuario autenticado actual
CREATE OR REPLACE FUNCTION get_mi_provincia()
RETURNS TEXT AS $$
  SELECT provincia
  FROM   usuarios
  WHERE  auth_user_id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Nivel numérico del rol (mayor = más permisos)
CREATE OR REPLACE FUNCTION get_mi_nivel()
RETURNS INT AS $$
  SELECT CASE get_mi_rol()
    WHEN 'Administrador' THEN 5
    WHEN 'Coordinador'   THEN 4
    WHEN 'Supervisor'    THEN 3
    WHEN 'Registrador'   THEN 2
    WHEN 'Observador'    THEN 1
    ELSE 0
  END
$$ LANGUAGE SQL SECURITY DEFINER STABLE;


/* ────────────────────────────────────────────────────────────────
   PASO 6b: FUNCIONES RPC PARA OPERACIONES PRE-LOGIN
   Estas dos operaciones ocurren ANTES de que el usuario esté
   autenticado (login con username, check de username en registro),
   por lo que necesitan funciones SECURITY DEFINER accesibles
   desde el rol 'anon' (clave pública).
   ──────────────────────────────────────────────────────────────── */

-- Buscar el email de un usuario dado su username (para login con username)
CREATE OR REPLACE FUNCTION get_email_from_username(p_username TEXT)
RETURNS TEXT AS $$
  SELECT email
  FROM   usuarios
  WHERE  LOWER(username) = LOWER(p_username)
  LIMIT  1
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Verificar si un username ya existe (para registro)
CREATE OR REPLACE FUNCTION check_username_exists(p_username TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuarios WHERE LOWER(username) = LOWER(p_username)
  )
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Dar permiso de ejecución al rol anónimo (clave pública)
GRANT EXECUTE ON FUNCTION get_email_from_username(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION check_username_exists(TEXT)   TO anon;


/* ────────────────────────────────────────────────────────────────
   PASO 7: ROW LEVEL SECURITY (RLS)
   ──────────────────────────────────────────────────────────────── */

-- Activar RLS en todas las tablas
ALTER TABLE usuarios   ENABLE ROW LEVEL SECURITY;
ALTER TABLE registros  ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria  ENABLE ROW LEVEL SECURITY;

/* ── POLÍTICAS: usuarios ─────────────────────────────────────── */

-- Cualquier usuario autenticado y aprobado puede ver todos los usuarios
-- (necesario para gestión de usuarios y búsqueda por username en login)
CREATE POLICY "usuarios_select"
  ON usuarios FOR SELECT
  TO authenticated
  USING (
    get_mi_estado() = 'aprobado'
    OR auth_user_id = auth.uid()  -- siempre puede ver su propio perfil
  );

-- Solo admins pueden ver usuarios pendientes/rechazados de otros
CREATE POLICY "usuarios_select_admin"
  ON usuarios FOR SELECT
  TO authenticated
  USING (get_mi_rol() = 'Administrador');

-- Insertar: cualquier autenticado puede insertar su propio perfil
-- (el primer usuario se inserta al registrarse antes de tener estado)
CREATE POLICY "usuarios_insert"
  ON usuarios FOR INSERT
  TO authenticated
  WITH CHECK (auth_user_id = auth.uid());

-- Actualizar: admins pueden editar a cualquiera; usuarios solo a sí mismos
CREATE POLICY "usuarios_update_admin"
  ON usuarios FOR UPDATE
  TO authenticated
  USING (get_mi_rol() = 'Administrador')
  WITH CHECK (get_mi_rol() = 'Administrador');

CREATE POLICY "usuarios_update_self"
  ON usuarios FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- Eliminar: solo Administrador
CREATE POLICY "usuarios_delete"
  ON usuarios FOR DELETE
  TO authenticated
  USING (get_mi_rol() = 'Administrador');


/* ── POLÍTICAS: registros ────────────────────────────────────── */

-- SELECT: Administrador ve todo; Coordinador+ ve su provincia; otros ven los suyos
CREATE POLICY "registros_select_admin"
  ON registros FOR SELECT
  TO authenticated
  USING (get_mi_rol() = 'Administrador');

CREATE POLICY "registros_select_coord"
  ON registros FOR SELECT
  TO authenticated
  USING (
    get_mi_nivel() >= 4   -- Coordinador o superior
    AND provincia = get_mi_provincia()
  );

CREATE POLICY "registros_select_own"
  ON registros FOR SELECT
  TO authenticated
  USING (registrado_por_id = auth.uid());

-- INSERT: Registrador o superior (nivel >= 2), estado aprobado
CREATE POLICY "registros_insert"
  ON registros FOR INSERT
  TO authenticated
  WITH CHECK (
    get_mi_nivel() >= 2
    AND get_mi_estado() = 'aprobado'
  );

-- UPDATE: Supervisor o superior puede editar registros
CREATE POLICY "registros_update"
  ON registros FOR UPDATE
  TO authenticated
  USING (
    get_mi_nivel() >= 3
    AND get_mi_estado() = 'aprobado'
  );

-- DELETE: Solo Administrador y Coordinador
CREATE POLICY "registros_delete"
  ON registros FOR DELETE
  TO authenticated
  USING (
    get_mi_nivel() >= 4
    AND get_mi_estado() = 'aprobado'
  );


/* ── POLÍTICAS: auditoria ────────────────────────────────────── */

-- SELECT: Coordinador o superior (nivel >= 4)
CREATE POLICY "auditoria_select"
  ON auditoria FOR SELECT
  TO authenticated
  USING (
    get_mi_nivel() >= 4
    AND get_mi_estado() = 'aprobado'
  );

-- INSERT: usuarios autenticados aprobados + rol anon para logins fallidos
CREATE POLICY "auditoria_insert_auth"
  ON auditoria FOR INSERT
  TO authenticated
  WITH CHECK (
    get_mi_estado() = 'aprobado'
    OR actor_id = auth.uid()
  );

-- Permitir insertar logins fallidos sin sesión (actor_id siempre null aquí)
-- Solo acepta la acción específica para minimizar el riesgo
CREATE POLICY "auditoria_insert_anon_failed_login"
  ON auditoria FOR INSERT
  TO anon
  WITH CHECK (accion = 'SESSION_LOGIN_FAILED');

-- Nadie puede modificar ni borrar el historial de auditoría
-- (sin políticas UPDATE/DELETE = bloqueado por defecto con RLS activo)


/* ────────────────────────────────────────────────────────────────
   PASO 8: DATOS INICIALES (opcional — para pruebas)
   Descomenta si quieres insertar datos de ejemplo
   ──────────────────────────────────────────────────────────────── */

/*
-- Ejemplo: insertar un registro de prueba en auditoría del sistema
INSERT INTO auditoria (actor_nombre, actor_rol, accion, objetivo, detalles)
VALUES ('Sistema', 'Sistema', 'SYSTEM_INIT', 'database', 'Base de datos inicializada correctamente');
*/


/* ────────────────────────────────────────────────────────────────
   PASO 9: VERIFICACIÓN FINAL
   Ejecuta esto para confirmar que todo se creó correctamente
   ──────────────────────────────────────────────────────────────── */

SELECT tablename AS table_name, rowsecurity AS rls_enabled
FROM   pg_tables
WHERE  schemaname = 'public'
  AND  tablename IN ('usuarios', 'registros', 'auditoria');
