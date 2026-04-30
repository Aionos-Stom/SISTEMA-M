/* ================================================================
   PATCH — Corrección de políticas RLS para registros
   Problema: Supervisor, Registrador y Observador no pueden ver
             sus propios registros después de registrarlos.
   
   Ejecutar en: Supabase → SQL Editor → New Query
   ================================================================ */

-- ----------------------------------------------------------------
-- 1. Eliminar políticas SELECT existentes de registros
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS "registros_select_admin" ON registros;
DROP POLICY IF EXISTS "registros_select_coord" ON registros;
DROP POLICY IF EXISTS "registros_select_own"   ON registros;

-- ----------------------------------------------------------------
-- 2. Crear una sola política SELECT consolidada
--    Supabase evalúa múltiples políticas con OR implícito, pero
--    consolidarlas en una evita problemas de evaluación con
--    funciones SECURITY DEFINER anidadas.
-- ----------------------------------------------------------------
CREATE POLICY "registros_select"
  ON registros FOR SELECT
  TO authenticated
  USING (
    -- Administrador ve todo
    get_mi_rol() = 'Administrador'
    OR
    -- Coordinador o superior ve su provincia
    (get_mi_nivel() >= 4 AND provincia = get_mi_provincia())
    OR
    -- Cualquier usuario aprobado ve sus propios registros
    (registrado_por_id = auth.uid() AND get_mi_estado() = 'aprobado')
  );

-- ----------------------------------------------------------------
-- 3. Verificar que las políticas quedaron correctas
-- ----------------------------------------------------------------
SELECT policyname, cmd, qual
FROM   pg_policies
WHERE  tablename = 'registros'
ORDER  BY policyname;
