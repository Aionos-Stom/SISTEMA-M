# 📋 Administración Peravia — Sistema de Gestión Territorial

Sistema integral de gestión territorial para la Administración de la Provincia de Peravia, República Dominicana.

## 🚀 Inicio Rápido

### Modo Demo (Sin Supabase configurado)

Si no has configurado Supabase, el sistema funcionará en **MODO DEMO**:

1. **Abre `index.html`** en tu navegador
2. **Ingresa cualquier usuario y contraseña** en el formulario de login
3. **Acceso automático** como administrador

En modo demo:
- ✅ Puedes registrar nuevos usuarios (datos guardados localmente)
- ✅ Todas las funciones de UI funcionan
- ✅ No hay conexión a base de datos

### Con Supabase Real

Para usar Supabase:

1. Ve a [supabase.com](https://supabase.com) y crea un proyecto
2. En `Script.js`, actualiza:
   ```javascript
   const SUPABASE_URL = 'tu_url_aqui';
   const SUPABASE_ANON = 'tu_clave_aqui';
   ```
3. Crea las tablas en Supabase:
   - `usuarios` (con campos: auth_user_id, nombre_completo, username, email, telefono, rol, provincia, estado, etc.)
   - `registros` (para votantes)
   - `auditoria` (para logs)

## 📁 Estructura

```
SISTEMA M/
├── index.html          # Estructura HTML principal
├── Script.js           # Toda la lógica de la app
├── Styles.css          # Estilos (Light/Dark mode)
└── README.md           # Este archivo
```

## 🔐 Autenticación

### Login
- Usa correo electrónico o nombre de usuario
- Contraseña mínimo 6 caracteres
- En modo demo: acepta cualquier credencial

### Registro
- El primer usuario se hace automáticamente **Administrador**
- Usuarios posteriores requieren aprobación
- Validaciones completas de campos

## 👥 Roles

- **Administrador**: Acceso total, gestión de usuarios, auditoría
- **Coordinador municipal**: Gestión de su municipio
- **Supervisor de zona**: Supervisión de zonas
- **Registrador**: Registro de datos
- **Observador**: Solo lectura

## ⚠️ Errores Solucionados

### Error: "SyntaxError: Identifier 'supabase' has already been declared"
✅ **Arreglado**: Refactorizado para usar `window.supabaseClient`

### Error: "403 Permission error"
✅ **Arreglado**: Modo demo automático cuando Supabase no está configurado

### Validación de registro incompleta
✅ **Arreglado**: Validaciones campo por campo con mensajes específicos

### Manejo de errores de conexión
✅ **Arreglado**: Fallback robusto a modo demo

## 🛠️ Funcionalidades

### Autenticación
- Registro con validación completa
- Login con email o usuario
- Recuperación de contraseña
- Gestión de estados (aprobado/pendiente/rechazado)

### Gestión de Usuarios
- Crear, editar, eliminar usuarios
- Asignar roles y permisos
- Control por provincia/zona

### Registros (Votantes)
- CRUD completo de registros
- Filtrado por múltiples criterios
- Exportación a Excel
- Generación de PDF

### Auditoría
- Registro de todas las acciones
- Filtrado por actor, acción, fecha
- Estadísticas de actividad

### UI/UX
- Tema claro y oscuro
- Responsive (móvil/tablet/desktop)
- Animaciones suaves
- Mensajes de error contextualizados

## 🎨 Diseño

Paleta diseñada por **Moreila Guerrero** - Warm Executive:
- **Primario**: Turquesa (#2A8A8A)
- **Acento**: Naranja (#E8572A)
- **Paleta neutra**: Beiges y tonos cálidos

Tipografía:
- **Display**: Fraunces (Georgia serif)
- **Cuerpo**: DM Sans (sans-serif)

## 📝 Notas de Desarrollo

- **Fallback automático a modo demo** cuando Supabase no está disponible
- **Try/catch robustos** en todas las operaciones de BD
- **Estilos para spinner de carga** incluidos
- **Inicialización segura** de librerías externas

## 📞 Soporte

Para errores de conexión a Supabase, verifica:
1. La URL y clave están correctas
2. Las CORS están permitidas en Supabase
3. Tienes acceso a internet
4. El navegador permite cookies/almacenamiento local

## 📄 Licencia

Propiedad de la Administración de Peravia - 2026

---

**Versión**: 1.0 (Demo Ready)  
**Última actualización**: Abril 2026  
**Modo**: Auto-detección (Real o Demo)
