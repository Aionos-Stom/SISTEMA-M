/* =========================================================
   ADMINISTRACIÓN PERAVIA — script.js
   Sistema completo: Auth, CRUD, Exports, UI, Auditoría
   ========================================================= */

'use strict';

/* ── CONFIGURACIÓN ─────────────────────────────────────── */
const SUPABASE_URL = 'TU_SUPABASE_URL';
const SUPABASE_ANON = 'TU_SUPABASE_ANON_KEY';

// Cliente de Supabase (global - única fuente de verdad)
if (!window.supabaseClient) {
  window.supabaseClient = null;
}

// Flag para modo demo (cuando no hay credenciales válidas)
let DEMO_MODE = false;

// Mock de Supabase para desarrollo
const createMockSupabase = () => ({
  auth: {
    signUp: async ({ email, password }) => ({
      data: { user: { id: `demo_${Date.now()}`, email } },
      error: null
    }),
    signInWithPassword: async ({ email, password }) => ({
      data: { user: { id: `demo_user`, email } },
      error: null
    }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => () => {},
    getSession: async () => ({ data: { session: null } }),
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ error: null })
  },
  from: (table) => ({
    select: function(cols, opts) {
      this._cols = cols;
      this._opts = opts;
      return this;
    },
    insert: async function() { return { error: null, data: [] }; },
    update: async function() { return { error: null }; },
    delete: async function() { return { error: null }; },
    eq: function(col, val) { return this; },
    single: async function() { return { error: null, data: null }; },
    maybeSingle: async function() { return { error: null, data: null }; },
    order: function() { return this; }
  })
});

// Helper para acceder a Supabase
const getSupabase = () => window.supabaseClient;

// Municipios de Peravia
const MUNICIPIOS_PERAVIA = [
  'Baní',
  'Nizao',
  'Los Cacaos',
  'Sabana Buey',
  'Matanzas',
  'Villa Fundación',
  'Paya',
  'Santana',
  'Pueblo Viejo'
];

// Roles del sistema
const ROLES = [
  { value: 'Administrador',    label: 'Administrador' },
  { value: 'Coordinador',      label: 'Coordinador municipal' },
  { value: 'Supervisor',       label: 'Supervisor de zona' },
  { value: 'Registrador',      label: 'Registrador' },
  { value: 'Observador',       label: 'Observador' }
];

// Jerarquía de roles (mayor = más permisos)
const ROLE_LEVEL = {
  'Administrador': 5,
  'Coordinador':   4,
  'Supervisor':    3,
  'Registrador':   2,
  'Observador':    1
};

/* ── ESTADO GLOBAL ─────────────────────────────────────── */
const APP = {
  currentUser:   null,
  currentProfile: null,
  allVoters:     [],
  allUsers:      [],
  filteredVoters: [],
  auditLogs:     [],
  auditPage:     1,
  AUDIT_PAGE_SIZE: 20,
  chart:         null,
  searchDebounce: null,
};

/* ══════════════════════════════════════════════════════════
   INICIALIZACIÓN
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Esperar a que Supabase JS esté disponible
  waitForSupabase().then(() => {
    init();
  });
});

function waitForSupabase() {
  return new Promise(resolve => {
    // Si las credenciales son placeholders, usar modo demo
    if (SUPABASE_URL === 'TU_SUPABASE_URL' || SUPABASE_ANON === 'TU_SUPABASE_ANON_KEY') {
      DEMO_MODE = true;
      window.supabaseClient = createMockSupabase();
      console.warn('⚠️ Modo demo activado - Supabase no está configurado');
      resolve();
      return;
    }

    // Esperar a que Supabase JS real esté disponible
    if (window.supabase && window.supabase.createClient) {
      window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
      resolve();
    } else {
      const maxAttempts = 50; // 5 segundos máximo
      let attempts = 0;
      const int = setInterval(() => {
        attempts++;
        if (window.supabase && window.supabase.createClient) {
          clearInterval(int);
          window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
          resolve();
        } else if (attempts >= maxAttempts) {
          clearInterval(int);
          // Fallback a modo demo si no se carga Supabase
          console.warn('⚠️ Supabase no disponible - usando modo demo');
          DEMO_MODE = true;
          window.supabaseClient = createMockSupabase();
          resolve();
        }
      }, 100);
    }
  });
}

async function init() {
  // Aplicar tema guardado
  applyTheme(localStorage.getItem('peravia_theme') || 'light');

  // Poblar selects
  populateSelects();

  // Manejar URL de recuperación de contraseña
  const hash = window.location.hash;
  if (hash.includes('type=recovery')) {
    showModal('resetPasswordModal');
  }

  // Listener de sesión de Supabase
  if (getSupabase().auth && getSupabase().auth.onAuthStateChange) {
    getSupabase().auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        APP.currentUser = session.user;
        await loadUserProfile();
        await showDashboard();
      } else if (event === 'SIGNED_OUT') {
        APP.currentUser = null;
        APP.currentProfile = null;
        showAuth();
      }
    });
  }

  // Verificar sesión existente
  try {
    const { data: sessionData } = await getSupabase().auth.getSession();
    const session = sessionData?.session;
    if (session) {
      APP.currentUser = session.user;
      await loadUserProfile();
      await showDashboard();
    } else {
      showAuth();
    }
  } catch (err) {
    console.warn('Error al verificar sesión:', err);
    showAuth();
  }

  bindEvents();
}

/* ══════════════════════════════════════════════════════════
   POBLAR SELECTS
══════════════════════════════════════════════════════════ */
function populateSelects() {
  const municipioSelects = [
    'registerProvince', 'voterProvince', 'filterProvince', 'editUserProvince'
  ];
  municipioSelects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isFilter = id === 'filterProvince';
    el.innerHTML = isFilter
      ? '<option value="">Todos</option>'
      : '<option value="">Seleccione municipio</option>';
    MUNICIPIOS_PERAVIA.forEach(m => {
      el.innerHTML += `<option value="${m}">${m}</option>`;
    });
  });

  const roleSelects = ['registerRole', 'editUserRole', 'filterRole'];
  roleSelects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const isFilter = id === 'filterRole';
    el.innerHTML = isFilter ? '<option value="">Todos</option>' : '<option value="">Seleccione</option>';
    ROLES.forEach(r => {
      el.innerHTML += `<option value="${r.value}">${r.label}</option>`;
    });
  });
}

/* ══════════════════════════════════════════════════════════
   AUTH — MOSTRAR / OCULTAR
══════════════════════════════════════════════════════════ */
function showAuth() {
  document.getElementById('authSection').classList.remove('hidden');
  document.getElementById('dashboardSection').classList.add('hidden');
  document.querySelector('.site-footer').style.display = '';
}

async function showDashboard() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('dashboardSection').classList.remove('hidden');
  document.querySelector('.site-footer').style.display = 'none';
  activatePanel('overview');
  updateSidebarUser();
  applyRolePermissions();
  await Promise.all([loadVoters(), loadUsers()]);
  renderOverview();
}

/* ══════════════════════════════════════════════════════════
   PERMISOS POR ROL
══════════════════════════════════════════════════════════ */
function getRoleLevel(role) {
  return ROLE_LEVEL[role] || 0;
}
function isAdmin()       { return APP.currentProfile?.rol === 'Administrador'; }
function isCoordOrAbove(){ return getRoleLevel(APP.currentProfile?.rol) >= 4; }

function applyRolePermissions() {
  const profile = APP.currentProfile;
  if (!profile) return;

  // Mostrar/ocultar sección auditoría
  const auditBtn = document.getElementById('navAuditBtn');
  if (isAdmin()) {
    auditBtn?.classList.remove('section-hidden');
  }

  // Mostrar/ocultar columna acciones en tabla de registros
  const actionsHead = document.getElementById('voterActionsHead');
  if (!isCoordOrAbove() && actionsHead) {
    actionsHead.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════
   PERFIL DE USUARIO
══════════════════════════════════════════════════════════ */
async function loadUserProfile() {
  if (!APP.currentUser) return;
  
  // En modo demo, usar perfil demo
  if (DEMO_MODE) {
    APP.currentProfile = {
      auth_user_id: APP.currentUser.id,
      nombre_completo: 'Usuario Demo',
      username: APP.currentUser.email?.split('@')[0] || 'demo',
      email: APP.currentUser.email,
      rol: 'Administrador',
      estado: 'aprobado',
      provincia: 'Baní'
    };
    return;
  }
  
  try {
    const { data, error } = await getSupabase()
      .from('usuarios')
      .select('*')
      .eq('auth_user_id', APP.currentUser.id)
      .single();
    if (!error && data) {
      APP.currentProfile = data;
    }
  } catch (err) {
    console.warn('Error loading user profile:', err);
  }
}

function updateSidebarUser() {
  const p = APP.currentProfile;
  if (!p) return;
  const nameEl   = document.getElementById('sidebarUserName');
  const roleEl   = document.getElementById('sidebarUserRole');
  const avatarEl = document.getElementById('sidebarAvatar');
  if (nameEl)   nameEl.textContent   = p.nombre_completo || p.username || '—';
  if (roleEl)   roleEl.textContent   = p.rol || '—';
  if (avatarEl) avatarEl.textContent = (p.nombre_completo || p.username || '?').charAt(0).toUpperCase();
}

/* ══════════════════════════════════════════════════════════
   LOGIN
══════════════════════════════════════════════════════════ */
async function handleLogin(e) {
  e.preventDefault();
  const userInput = document.getElementById('loginUser').value.trim();
  const password  = document.getElementById('loginPassword').value;
  
  if (!userInput) return showAuthMsg('error', 'Ingrese correo o nombre de usuario.');
  if (!password) return showAuthMsg('error', 'Ingrese su contraseña.');

  setSubmitLoading('loginForm', true);
  try {
    // En modo demo, aceptar cualquier credencial
    if (DEMO_MODE) {
      showAuthMsg('success', '✓ Acceso en modo demo - Bienvenido');
      setTimeout(() => {
        APP.currentUser = { id: 'demo_user', email: userInput };
        APP.currentProfile = {
          auth_user_id: 'demo_user',
          nombre_completo: 'Usuario Demo',
          username: userInput,
          rol: 'Administrador',
          estado: 'aprobado'
        };
        showDashboard();
      }, 1000);
      return;
    }

    let email = userInput;
    
    // Si no parece un email, buscar por username
    if (!userInput.includes('@')) {
      const { data: found, error: findErr } = await getSupabase()
        .from('usuarios')
        .select('email')
        .eq('username', userInput)
        .maybeSingle();
      
      if (findErr) throw findErr;
      if (!found?.email) {
        showAuthMsg('error', 'Usuario o correo no encontrado.');
        return;
      }
      email = found.email;
    }

    const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) throw error;

    if (!data?.user?.id) {
      throw new Error('No se pudo verificar la identidad del usuario.');
    }

    // Verificar aprobación del usuario
    const { data: profile, error: profileErr } = await getSupabase()
      .from('usuarios')
      .select('estado')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();
    
    if (profileErr) throw profileErr;
    
    if (!profile) {
      await getSupabase().auth.signOut();
      showAuthMsg('error', 'Perfil de usuario no encontrado.');
      return;
    }
    
    if (profile.estado === 'pendiente') {
      await getSupabase().auth.signOut();
      showAuthMsg('error', 'Su cuenta está pendiente de aprobación por un administrador.');
      return;
    }
    
    if (profile.estado === 'rechazado') {
      await getSupabase().auth.signOut();
      showAuthMsg('error', 'Su cuenta ha sido rechazada. Contacte al administrador.');
      return;
    }

    await logAudit('SESSION_LOGIN', data.user.id, 'Inicio de sesión exitoso');
    showAuthMsg('success', 'Accediendo al sistema...');
  } catch (err) {
    console.error('Error de login:', err);
    showAuthMsg('error', getAuthError(err.message));
  } finally {
    setSubmitLoading('loginForm', false);
  }
}

/* ══════════════════════════════════════════════════════════
   REGISTRO DE USUARIO
══════════════════════════════════════════════════════════ */
async function handleRegister(e) {
  e.preventDefault();
  const name       = document.getElementById('registerName').value.trim();
  const username   = document.getElementById('registerUsername').value.trim();
  const email      = document.getElementById('registerEmail').value.trim();
  const phone      = document.getElementById('registerPhone').value.trim();
  const role       = document.getElementById('registerRole').value;
  const province   = document.getElementById('registerProvince').value;
  const region     = document.getElementById('registerRegion').value.trim();
  const municipio  = document.getElementById('registerMunicipio').value.trim();
  const distrito   = document.getElementById('registerDistrito').value.trim();
  const zone       = document.getElementById('registerZone').value.trim();
  const password   = document.getElementById('registerPassword').value;
  const confirm    = document.getElementById('registerPasswordConfirm').value;

  // Validaciones
  if (!name) return showAuthMsg('error', 'Nombre completo es requerido.');
  if (!username) return showAuthMsg('error', 'Nombre de usuario es requerido.');
  if (username.length < 3) return showAuthMsg('error', 'El nombre de usuario debe tener al menos 3 caracteres.');
  if (!email) return showAuthMsg('error', 'Correo electrónico es requerido.');
  if (!email.includes('@')) return showAuthMsg('error', 'Ingrese un correo válido.');
  if (!phone) return showAuthMsg('error', 'Teléfono es requerido.');
  if (!role) return showAuthMsg('error', 'Debe seleccionar un rol.');
  if (!province) return showAuthMsg('error', 'Debe seleccionar un municipio.');
  if (!zone) return showAuthMsg('error', 'Zona o demarcación es requerida.');
  if (!password) return showAuthMsg('error', 'Contraseña es requerida.');
  if (password.length < 6) return showAuthMsg('error', 'La contraseña debe tener al menos 6 caracteres.');
  if (password !== confirm) return showAuthMsg('error', 'Las contraseñas no coinciden.');

  setSubmitLoading('registerForm', true);
  try {
    // En modo demo, simplemente aceptar el registro
    if (DEMO_MODE) {
      showAuthMsg('success', '✓ Usuario creado exitosamente en modo demo');
      document.getElementById('registerForm').reset();
      setTimeout(() => {
        document.getElementById('showLogin').click();
      }, 1500);
      return;
    }

    // Verificar si username ya existe
    try {
      const { data: existUser, error: checkErr } = await getSupabase()
        .from('usuarios')
        .select('id')
        .eq('username', username)
        .maybeSingle();
      
      if (existUser) {
        showAuthMsg('error', 'El nombre de usuario ya está en uso. Intente con otro.');
        return;
      }
    } catch (err) {
      console.warn('No se pudo verificar username:', err);
    }

    // Crear usuario en Supabase Auth
    let authData;
    try {
      const { data: data_, error: authErr } = await getSupabase().auth.signUp({ email, password });
      if (authErr) {
        if (authErr.message?.includes('already registered')) {
          throw new Error('Este correo ya está registrado en el sistema.');
        }
        throw authErr;
      }
      authData = data_;
    } catch (err) {
      throw new Error('Error en autenticación: ' + (err.message || err));
    }

    if (!authData?.user?.id) throw new Error('No se pudo crear la cuenta de autenticación.');

    // Determinar si es primer usuario (auto-aprobar)
    let estado = 'pendiente';
    let rolFinal = role;
    
    try {
      const { count, error: countErr } = await getSupabase()
        .from('usuarios')
        .select('id', { count: 'exact', head: true });
      
      if (count === 0 || count === null) {
        estado = 'aprobado';
        rolFinal = 'Administrador';
      }
    } catch (err) {
      console.warn('No se pudo contar usuarios:', err);
      // Continuar con valores por defecto
    }

    // Insertar perfil
    try {
      const { error: profileErr } = await getSupabase().from('usuarios').insert({
        auth_user_id:    authData.user.id,
        nombre_completo: name,
        username,
        email,
        telefono:        phone,
        rol:             rolFinal,
        provincia:       province,
        region,
        municipio,
        distrito,
        zona:            zone,
        estado,
        created_at:      new Date().toISOString()
      });
      
      if (profileErr) throw profileErr;
    } catch (err) {
      throw new Error('Error al crear perfil: ' + (err.message || err));
    }

    const msgEst = estado === 'aprobado'
      ? '✓ Usuario administrador creado. Ya puede iniciar sesión.'
      : '✓ Solicitud enviada. Espere la aprobación de un administrador.';
    showAuthMsg('success', msgEst);
    
    // Limpiar formulario
    document.getElementById('registerForm').reset();
    
    // Cambiar a pestaña de login después de 2 segundos
    if (estado === 'aprobado') {
      setTimeout(() => {
        document.getElementById('showLogin').click();
      }, 2000);
    }
    
    try {
      await logAudit('USER_CREATE', authData.user.id, `Usuario ${username} registrado con rol ${rolFinal}`);
    } catch (err) {
      console.warn('No se pudo registrar auditoría:', err);
    }
  } catch (err) {
    console.error('Error en registro:', err);
    showAuthMsg('error', getAuthError(err.message || 'Error desconocido al registrar'));
  } finally {
    setSubmitLoading('registerForm', false);
  }
}

/* ══════════════════════════════════════════════════════════
   RECUPERAR / RESTABLECER CONTRASEÑA
══════════════════════════════════════════════════════════ */
async function handleForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return showStatusMsg('forgotMessage', 'error', 'Ingrese su correo.');
  try {
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) throw error;
    showStatusMsg('forgotMessage', 'success', 'Se envió el enlace de recuperación a su correo.');
  } catch (err) {
    showStatusMsg('forgotMessage', 'error', getAuthError(err.message));
  }
}

async function handleResetPassword(e) {
  e.preventDefault();
  const pwd  = document.getElementById('resetPassword').value;
  const conf = document.getElementById('resetPasswordConfirm').value;
  if (pwd !== conf) return showStatusMsg('resetMessage', 'error', 'Las contraseñas no coinciden.');
  if (pwd.length < 6) return showStatusMsg('resetMessage', 'error', 'Mínimo 6 caracteres.');
  try {
    const { error } = await getSupabase().auth.updateUser({ password: pwd });
    if (error) throw error;
    showStatusMsg('resetMessage', 'success', 'Contraseña actualizada. Puede iniciar sesión.');
    setTimeout(() => { closeModal('resetPasswordModal'); window.location.hash = ''; }, 2000);
  } catch (err) {
    showStatusMsg('resetMessage', 'error', getAuthError(err.message));
  }
}

/* ══════════════════════════════════════════════════════════
   LOGOUT
══════════════════════════════════════════════════════════ */
async function handleLogout() {
  await logAudit('SESSION_LOGOUT', APP.currentUser?.id, 'Cierre de sesión');
  await getSupabase().auth.signOut();
  // En modo demo, el onAuthStateChange no se dispara, forzar showAuth
  if (DEMO_MODE) {
    APP.currentUser = null;
    APP.currentProfile = null;
    showAuth();
  }
  showNotif('info', 'Sesión cerrada', 'Hasta luego.');
}

/* ══════════════════════════════════════════════════════════
   CARGAR DATOS
══════════════════════════════════════════════════════════ */
async function loadVoters() {
  try {
    // En modo demo, no hay datos que cargar
    if (DEMO_MODE) {
      APP.allVoters = [];
      APP.filteredVoters = [];
      renderVotersTable(APP.filteredVoters);
      updateFilterBadge(0);
      return;
    }

    let query = getSupabase().from('registros').select('*').order('created_at', { ascending: false });

    // Filtrar por provincia según rol
    const p = APP.currentProfile;
    if (p && !isAdmin() && !isCoordOrAbove()) {
      query = query.eq('registrado_por_id', APP.currentUser.id);
    } else if (p && !isAdmin() && isCoordOrAbove()) {
      query = query.eq('provincia', p.provincia);
    }

    const { data, error } = await query;
    if (error) throw error;
    APP.allVoters = data || [];
    APP.filteredVoters = [...APP.allVoters];
    renderVotersTable(APP.filteredVoters);
    updateFilterBadge(APP.filteredVoters.length);
    populateDynamicFilters(APP.allVoters);
  } catch (err) {
    console.error('Error cargando registros:', err);
    APP.allVoters = [];
    APP.filteredVoters = [];
  }
}

async function loadUsers() {
  try {
    // En modo demo, no hay usuarios que cargar
    if (DEMO_MODE) {
      APP.allUsers = [];
      renderUsersTable([]);
      return;
    }

    let query = getSupabase().from('usuarios').select('*').order('created_at', { ascending: false });
    if (!isAdmin()) {
      query = query.eq('provincia', APP.currentProfile?.provincia);
    }
    const { data, error } = await query;
    if (error) throw error;
    APP.allUsers = data || [];
    renderUsersTable(APP.allUsers);
  } catch (err) {
    console.error('Error cargando usuarios:', err);
    APP.allUsers = [];
  }
}

async function loadAuditLogs() {
  try {
    if (!isAdmin()) return;
    
    // En modo demo, no hay logs que cargar
    if (DEMO_MODE) {
      APP.auditLogs = [];
      renderAuditTable([]);
      renderAuditStats([]);
      return;
    }

    const { data, error } = await supabase
      .from('auditoria')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    APP.auditLogs = data || [];
    renderAuditTable(APP.auditLogs);
    renderAuditStats(APP.auditLogs);
    populateAuditActors(APP.auditLogs);
  } catch (err) {
    console.error('Error cargando auditoría:', err);
    APP.auditLogs = [];
  }
}

/* ══════════════════════════════════════════════════════════
   REGISTROS (VOTERS) — CRUD
══════════════════════════════════════════════════════════ */
async function handleVoterSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById('editingVoterId').value;
  const payload = {
    nombre:              document.getElementById('voterName').value.trim(),
    cedula:              document.getElementById('voterCedula').value.trim(),
    telefono:            document.getElementById('voterPhone').value.trim(),
    provincia:           document.getElementById('voterProvince').value,
    region:              document.getElementById('voterRegion').value.trim(),
    municipio:           document.getElementById('voterMunicipio').value.trim(),
    distrito:            document.getElementById('voterDistrito').value.trim(),
    zona:                document.getElementById('voterZone').value.trim(),
    sector:              document.getElementById('voterSector').value.trim(),
    mesa:                document.getElementById('voterMesa').value.trim(),
    recinto:             document.getElementById('voterRecinto').value.trim(),
    observacion:         document.getElementById('voterObservation').value.trim(),
    registrado_por_id:   APP.currentUser?.id,
    registrado_por_nombre: APP.currentProfile?.nombre_completo || APP.currentProfile?.username,
    registrado_por_rol:  APP.currentProfile?.rol,
  };

  const requiredFields = ['nombre','cedula','telefono','provincia','municipio','zona','sector','mesa','recinto'];
  for (const f of requiredFields) {
    if (!payload[f]) return showStatusMsg('voterMessage', 'error', 'Complete todos los campos obligatorios.');
  }

  setSubmitLoading('voterForm', true);
  try {
    if (editId) {
      // Editar
      const { error } = await getSupabase().from('registros').update(payload).eq('id', editId);
      if (error) throw error;
      showStatusMsg('voterMessage', 'success', 'Registro actualizado correctamente.');
      showNotif('success', 'Registro actualizado', payload.nombre);
      await logAudit('VOTER_EDIT', editId, `Registro ${payload.nombre} (${payload.cedula}) editado`);
      cancelEditVoter();
    } else {
      // Verificar duplicado
      const { data: dup } = await supabase
        .from('registros')
        .select('id, registrado_por_nombre')
        .eq('cedula', payload.cedula)
        .single();
      if (dup) {
        await logAudit('VOTER_DUPLICATE', dup.id, `Intento de duplicado: ${payload.cedula}`);
        showDuplicateModal(payload.nombre, dup.registrado_por_nombre);
        return;
      }
      payload.created_at = new Date().toISOString();
      const { error } = await getSupabase().from('registros').insert(payload);
      if (error) throw error;
      showStatusMsg('voterMessage', 'success', '¡Ciudadano registrado exitosamente!');
      showNotif('success', 'Registro creado', payload.nombre);
      document.getElementById('voterForm').reset();
      await logAudit('VOTER_CREATE', null, `Nuevo registro: ${payload.nombre} (${payload.cedula})`);
    }
    await loadVoters();
    renderOverview();
  } catch (err) {
    showStatusMsg('voterMessage', 'error', 'Error al guardar el registro: ' + err.message);
  } finally {
    setSubmitLoading('voterForm', false);
  }
}

function editVoter(voter) {
  document.getElementById('editingVoterId').value     = voter.id;
  document.getElementById('voterName').value           = voter.nombre     || '';
  document.getElementById('voterCedula').value         = voter.cedula     || '';
  document.getElementById('voterPhone').value          = voter.telefono   || '';
  document.getElementById('voterProvince').value       = voter.provincia  || '';
  document.getElementById('voterRegion').value         = voter.region     || '';
  document.getElementById('voterMunicipio').value      = voter.municipio  || '';
  document.getElementById('voterDistrito').value       = voter.distrito   || '';
  document.getElementById('voterZone').value           = voter.zona       || '';
  document.getElementById('voterSector').value         = voter.sector     || '';
  document.getElementById('voterMesa').value           = voter.mesa       || '';
  document.getElementById('voterRecinto').value        = voter.recinto    || '';
  document.getElementById('voterObservation').value    = voter.observacion|| '';
  document.getElementById('voterFormTitle').textContent       = 'Editar registro';
  document.getElementById('voterFormDescription').textContent = 'Modifique los datos y guarde los cambios.';
  document.getElementById('cancelEditVoterBtn').classList.remove('hidden');
  activatePanel('registro');
  document.getElementById('voterForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditVoter() {
  document.getElementById('editingVoterId').value = '';
  document.getElementById('voterForm').reset();
  document.getElementById('voterFormTitle').textContent       = 'Registrar ciudadano / simpatizante';
  document.getElementById('voterFormDescription').textContent = 'Complete todos los datos requeridos con precisión.';
  document.getElementById('cancelEditVoterBtn').classList.add('hidden');
}

async function deleteVoter(id, name) {
  if (!confirm(`¿Eliminar el registro de "${name}"? Esta acción no se puede deshacer.`)) return;
  const { error } = await getSupabase().from('registros').delete().eq('id', id);
  if (error) { showNotif('error', 'Error', 'No se pudo eliminar el registro.'); return; }
  showNotif('warning', 'Registro eliminado', name);
  await logAudit('VOTER_DELETE', id, `Registro eliminado: ${name}`);
  await loadVoters();
  renderOverview();
}

/* ══════════════════════════════════════════════════════════
   USUARIOS — CRUD
══════════════════════════════════════════════════════════ */
async function handleUserEdit(e) {
  e.preventDefault();
  const id = document.getElementById('editUserId').value;
  const payload = {
    nombre_completo: document.getElementById('editUserName').value.trim(),
    username:        document.getElementById('editUserUsername').value.trim(),
    email:           document.getElementById('editUserEmail').value.trim(),
    telefono:        document.getElementById('editUserPhone').value.trim(),
    rol:             document.getElementById('editUserRole').value,
    provincia:       document.getElementById('editUserProvince').value,
    region:          document.getElementById('editUserRegion').value.trim(),
    municipio:       document.getElementById('editUserMunicipio').value.trim(),
    distrito:        document.getElementById('editUserDistrito').value.trim(),
    zona:            document.getElementById('editUserZone').value.trim(),
  };
  try {
    const { error } = await getSupabase().from('usuarios').update(payload).eq('id', id);
    if (error) throw error;
    showStatusMsg('userEditMessage', 'success', 'Usuario actualizado correctamente.');
    showNotif('success', 'Usuario actualizado', payload.nombre_completo);
    await logAudit('USER_EDIT', id, `Usuario ${payload.username} editado`);
    await loadUsers();
    setTimeout(() => closeModal('userEditModal'), 1400);
  } catch (err) {
    showStatusMsg('userEditMessage', 'error', 'Error: ' + err.message);
  }
}

function openEditUser(user) {
  document.getElementById('editUserId').value         = user.id;
  document.getElementById('editUserName').value       = user.nombre_completo || '';
  document.getElementById('editUserUsername').value   = user.username        || '';
  document.getElementById('editUserEmail').value      = user.email           || '';
  document.getElementById('editUserPhone').value      = user.telefono        || '';
  document.getElementById('editUserRole').value       = user.rol             || '';
  document.getElementById('editUserProvince').value   = user.provincia       || '';
  document.getElementById('editUserRegion').value     = user.region          || '';
  document.getElementById('editUserMunicipio').value  = user.municipio       || '';
  document.getElementById('editUserDistrito').value   = user.distrito        || '';
  document.getElementById('editUserZone').value       = user.zona            || '';

  // Poblar selects del modal
  const provSel = document.getElementById('editUserProvince');
  provSel.innerHTML = '<option value="">Seleccione municipio</option>';
  MUNICIPIOS_PERAVIA.forEach(m => provSel.innerHTML += `<option value="${m}">${m}</option>`);
  provSel.value = user.provincia || '';

  const rolSel = document.getElementById('editUserRole');
  rolSel.innerHTML = '<option value="">Seleccione</option>';
  ROLES.forEach(r => rolSel.innerHTML += `<option value="${r.value}">${r.label}</option>`);
  rolSel.value = user.rol || '';

  showModal('userEditModal');
}

async function toggleUserStatus(userId, currentStatus, userName) {
  if (!isAdmin()) return;
  const newStatus = currentStatus === 'aprobado' ? 'rechazado' : 'aprobado';
  const label = newStatus === 'aprobado' ? 'aprobar' : 'rechazar';
  if (!confirm(`¿Desea ${label} al usuario "${userName}"?`)) return;
  const { error } = await getSupabase().from('usuarios').update({ estado: newStatus }).eq('id', userId);
  if (error) { showNotif('error', 'Error', 'No se pudo actualizar el estado.'); return; }
  const action = newStatus === 'aprobado' ? 'USER_APPROVE' : 'USER_DELETE';
  showNotif(newStatus === 'aprobado' ? 'success' : 'warning',
    `Usuario ${newStatus}`, userName);
  await logAudit(action, userId, `${userName} → ${newStatus}`);
  await loadUsers();
}

async function deleteUser(userId, userName) {
  if (!isAdmin()) return;
  if (!confirm(`¿Eliminar al usuario "${userName}" permanentemente?`)) return;
  const { error } = await getSupabase().from('usuarios').delete().eq('id', userId);
  if (error) { showNotif('error', 'Error', 'No se pudo eliminar el usuario.'); return; }
  showNotif('warning', 'Usuario eliminado', userName);
  await logAudit('USER_DELETE', userId, `${userName} eliminado`);
  await loadUsers();
}

/* ══════════════════════════════════════════════════════════
   RENDERIZADO — TABLAS
══════════════════════════════════════════════════════════ */
function renderVotersTable(voters) {
  const tbody = document.getElementById('votersTableBody');
  if (!tbody) return;
  if (!voters.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="16">No hay registros para mostrar.</td></tr>`;
    return;
  }
  const canEdit = isCoordOrAbove() || isAdmin();
  tbody.innerHTML = voters.map(v => `
    <tr>
      <td><strong>${esc(v.nombre)}</strong></td>
      <td>${esc(v.cedula)}</td>
      <td>${esc(v.telefono)}</td>
      <td>${esc(v.region)}</td>
      <td>${esc(v.provincia)}</td>
      <td>${esc(v.municipio)}</td>
      <td>${esc(v.distrito)}</td>
      <td>${esc(v.zona)}</td>
      <td>${esc(v.sector)}</td>
      <td>${esc(v.mesa)}</td>
      <td>${esc(v.recinto)}</td>
      <td class="td-obs">${esc(v.observacion || '—')}</td>
      <td>${esc(v.registrado_por_nombre || '—')}</td>
      <td><span class="status-badge status-approved">${esc(v.registrado_por_rol || '—')}</span></td>
      <td>${formatDate(v.created_at)}</td>
      <td>${canEdit ? `
        <div class="td-actions">
          <button class="icon-btn edit-btn" onclick="editVoter(${JSON.stringify(v).replace(/"/g, '&quot;')})" title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn delete-btn" onclick="deleteVoter('${v.id}','${esc(v.nombre)}')" title="Eliminar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>` : '—'}
      </td>
    </tr>
  `).join('');
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="12">No hay usuarios para mostrar.</td></tr>`;
    return;
  }
  const canManage = isAdmin();
  tbody.innerHTML = users.map(u => {
    const isMe = u.auth_user_id === APP.currentUser?.id;
    return `
    <tr>
      <td><strong>${esc(u.nombre_completo)}</strong></td>
      <td>${esc(u.username)}</td>
      <td>${esc(u.email)}</td>
      <td><span class="status-badge status-approved">${esc(u.rol)}</span></td>
      <td>${esc(u.telefono || '—')}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${esc(u.provincia || '—')}</td>
      <td>${esc(u.municipio || '—')}</td>
      <td>${esc(u.distrito || '—')}</td>
      <td>${esc(u.zona || '—')}</td>
      <td><span class="status-badge ${u.estado === 'aprobado' ? 'status-approved' : u.estado === 'pendiente' ? 'status-pending' : 'status-rejected'}">${u.estado || '—'}</span></td>
      <td>
        <div class="td-actions">
          <button class="icon-btn edit-btn" onclick="openEditUser(${JSON.stringify(u).replace(/"/g, '&quot;')})" title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${canManage && !isMe ? `
          <button class="icon-btn approve-btn" onclick="toggleUserStatus('${u.id}','${u.estado}','${esc(u.nombre_completo)}')" title="${u.estado === 'aprobado' ? 'Desactivar' : 'Aprobar'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
          <button class="icon-btn delete-btn" onclick="deleteUser('${u.id}','${esc(u.nombre_completo)}')" title="Eliminar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderAuditTable(logs) {
  const tbody = document.getElementById('auditTableBody');
  if (!tbody) return;
  const page = APP.auditPage;
  const size = APP.AUDIT_PAGE_SIZE;
  const slice = logs.slice((page - 1) * size, page * size);

  if (!slice.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No hay registros de auditoría.</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(l => `
      <tr>
        <td>${formatDate(l.created_at, true)}</td>
        <td><strong>${esc(l.actor_nombre || '—')}</strong></td>
        <td><span class="status-badge status-approved">${esc(l.actor_rol || '—')}</span></td>
        <td><span class="action-tag ${getActionClass(l.accion)}">${esc(l.accion || '—')}</span></td>
        <td>${esc(l.objetivo || '—')}</td>
        <td>${esc(l.detalles || '—')}</td>
      </tr>
    `).join('');
  }

  renderAuditPagination(logs.length);
}

function renderAuditStats(logs) {
  const container = document.getElementById('auditStats');
  if (!container) return;
  const counts = {};
  logs.forEach(l => counts[l.accion] = (counts[l.accion] || 0) + 1);
  const top4 = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,4);
  container.innerHTML = top4.map(([action, count]) => `
    <div class="audit-stat-chip">
      <span class="action-tag ${getActionClass(action)}">${action}</span>
      <strong>${count}</strong>
      <span>eventos</span>
    </div>
  `).join('');
}

function renderAuditPagination(total) {
  const container = document.getElementById('auditPagination');
  if (!container) return;
  const pages = Math.ceil(total / APP.AUDIT_PAGE_SIZE);
  container.innerHTML = '';
  for (let i = 1; i <= pages; i++) {
    const btn = document.createElement('button');
    btn.className = `page-btn${i === APP.auditPage ? ' active' : ''}`;
    btn.textContent = i;
    btn.addEventListener('click', () => { APP.auditPage = i; renderAuditTable(getFilteredAuditLogs()); });
    container.appendChild(btn);
  }
}

function populateAuditActors(logs) {
  const sel = document.getElementById('auditFilterActor');
  if (!sel) return;
  const actors = [...new Set(logs.map(l => l.actor_nombre).filter(Boolean))];
  sel.innerHTML = '<option value="">Todos los actores</option>';
  actors.forEach(a => sel.innerHTML += `<option value="${a}">${a}</option>`);
}

/* ══════════════════════════════════════════════════════════
   PANEL RESUMEN (OVERVIEW)
══════════════════════════════════════════════════════════ */
function renderOverview() {
  const voters = APP.allVoters;
  const users  = APP.allUsers;
  const today  = new Date().toDateString();
  const todayCount = voters.filter(v => new Date(v.created_at).toDateString() === today).length;
  const municiSet  = new Set(voters.map(v => v.provincia).filter(Boolean));

  setEl('totalVoters',    voters.length);
  setEl('totalUsers',     users.length);
  setEl('todayVoters',    todayCount);
  setEl('activeProvinces', municiSet.size);

  // Construir datos para gráfica
  const byMunici = {};
  voters.forEach(v => { if (v.provincia) byMunici[v.provincia] = (byMunici[v.provincia] || 0) + 1; });
  const labels = Object.keys(byMunici).sort((a, b) => byMunici[b] - byMunici[a]);
  const values = labels.map(l => byMunici[l]);

  const badge = document.getElementById('chartSummaryBadge');
  if (badge) badge.textContent = `${labels.length} municipios activos`;

  renderChart(labels, values);
  renderRanking(labels, values);
}

function renderChart(labels, values) {
  const canvas = document.getElementById('provinceChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (APP.chart) APP.chart.destroy();

  const colors = [
    '#2A8A8A','#E8572A','#F4A99A','#EBE0C4','#3BA5A5',
    '#D4785A','#1D6B6B','#CF4A22','#5BBFBF','#F5ECD5'
  ];

  APP.chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => colors[i % colors.length] + 'CC'),
        borderColor:     labels.map((_, i) => colors[i % colors.length]),
        borderWidth: 2,
        borderRadius: 8,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1D6B6B',
          titleFont: { family: "'DM Sans', sans-serif", weight: 700 },
          bodyFont:  { family: "'DM Sans', sans-serif" },
          cornerRadius: 8,
          callbacks: {
            label: ctx => ` ${ctx.parsed.y} registros`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: "'DM Sans', sans-serif", size: 11 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(42,138,138,0.08)' },
          ticks: { font: { family: "'DM Sans', sans-serif", size: 11 }, precision: 0 }
        }
      }
    }
  });
}

function renderRanking(labels, values) {
  const list = document.getElementById('provinceRanking');
  if (!list) return;
  const max = values[0] || 1;
  const rankClasses = ['gold', 'silver', 'bronze'];
  list.innerHTML = labels.slice(0, 8).map((label, i) => `
    <div class="ranking-item">
      <div class="ranking-item-rank ${rankClasses[i] || ''}">${i + 1}</div>
      <div style="flex:1">
        <div class="ranking-item-name">${esc(label)}</div>
        <div class="ranking-bar"><div class="ranking-bar-fill" style="width:${Math.round((values[i]/max)*100)}%"></div></div>
      </div>
      <div class="ranking-item-count">${values[i]}</div>
    </div>
  `).join('');
}

/* ══════════════════════════════════════════════════════════
   FILTROS Y BÚSQUEDA
══════════════════════════════════════════════════════════ */
function populateDynamicFilters(voters) {
  const fields = {
    filterMunicipio: v => v.municipio,
    filterSector:    v => v.sector,
    filterMesa:      v => v.mesa,
    filterRegistrar: v => v.registrado_por_nombre,
  };
  Object.entries(fields).forEach(([selId, getter]) => {
    const el = document.getElementById(selId);
    if (!el) return;
    const prev = el.value;
    const vals = [...new Set(voters.map(getter).filter(Boolean))].sort();
    const allLabel = selId === 'filterMunicipio' ? 'Todas' : selId === 'filterMesa' ? 'Todas' : 'Todos';
    el.innerHTML = `<option value="">${allLabel}</option>`;
    vals.forEach(v => el.innerHTML += `<option value="${v}">${v}</option>`);
    if (vals.includes(prev)) el.value = prev;
  });
}

function applyFilters() {
  const search    = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const province  = document.getElementById('filterProvince')?.value  || '';
  const municipio = document.getElementById('filterMunicipio')?.value || '';
  const sector    = document.getElementById('filterSector')?.value    || '';
  const mesa      = document.getElementById('filterMesa')?.value      || '';
  const role      = document.getElementById('filterRole')?.value      || '';
  const registrar = document.getElementById('filterRegistrar')?.value || '';

  APP.filteredVoters = APP.allVoters.filter(v => {
    const text = [v.nombre, v.cedula, v.telefono, v.zona, v.recinto, v.sector, v.mesa, v.municipio].join(' ').toLowerCase();
    return (
      (!search    || text.includes(search)) &&
      (!province  || v.provincia === province) &&
      (!municipio || v.municipio === municipio) &&
      (!sector    || v.sector === sector) &&
      (!mesa      || v.mesa === mesa) &&
      (!role      || v.registrado_por_rol === role) &&
      (!registrar || v.registrado_por_nombre === registrar)
    );
  });
  renderVotersTable(APP.filteredVoters);
  updateFilterBadge(APP.filteredVoters.length);
}

function clearFilters() {
  ['searchInput','filterProvince','filterMunicipio','filterSector','filterMesa','filterRole','filterRegistrar']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  APP.filteredVoters = [...APP.allVoters];
  renderVotersTable(APP.filteredVoters);
  updateFilterBadge(APP.filteredVoters.length);
}

function updateFilterBadge(count) {
  const el = document.getElementById('filteredCountBadge');
  if (el) el.textContent = `${count} resultado${count !== 1 ? 's' : ''}`;
}

function handleTopbarSearch(query) {
  clearTimeout(APP.searchDebounce);
  APP.searchDebounce = setTimeout(() => {
    if (!query.trim()) return;
    const q = query.toLowerCase();
    const results = APP.allVoters.filter(v =>
      [v.nombre, v.cedula, v.telefono, v.municipio, v.zona].join(' ').toLowerCase().includes(q)
    ).slice(0, 8);
    renderQuickSearch(results, query);
  }, 300);
}

function renderQuickSearch(results, query) {
  const container = document.getElementById('searchResults');
  if (!container) return;
  if (!results.length) {
    container.innerHTML = `<p style="font-size:0.8rem;color:var(--text-muted);padding:8px 0">Sin resultados para "${esc(query)}"</p>`;
    return;
  }
  container.innerHTML = results.map(v => `
    <div class="search-result-item" onclick="editVoter(${JSON.stringify(v).replace(/"/g, '&quot;')})">
      <div>
        <div class="search-result-name">${esc(v.nombre)}</div>
        <div class="search-result-meta">${esc(v.cedula)} · ${esc(v.municipio || '—')} · ${esc(v.zona || '—')}</div>
      </div>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

/* Filtro de auditoría */
function getFilteredAuditLogs() {
  const search = (document.getElementById('auditSearch')?.value || '').toLowerCase();
  const action = document.getElementById('auditFilterAction')?.value || '';
  const actor  = document.getElementById('auditFilterActor')?.value  || '';
  const from   = document.getElementById('auditFilterFrom')?.value   || '';
  const to     = document.getElementById('auditFilterTo')?.value     || '';

  return APP.auditLogs.filter(l => {
    const text = [l.actor_nombre, l.objetivo, l.detalles].join(' ').toLowerCase();
    const date = l.created_at?.substring(0, 10);
    return (
      (!search || text.includes(search)) &&
      (!action || l.accion === action) &&
      (!actor  || l.actor_nombre === actor) &&
      (!from   || date >= from) &&
      (!to     || date <= to)
    );
  });
}

/* ══════════════════════════════════════════════════════════
   EXPORTAR
══════════════════════════════════════════════════════════ */
function exportToExcel() {
  if (!APP.filteredVoters.length) { showNotif('warning', 'Sin datos', 'No hay registros para exportar.'); return; }
  const data = APP.filteredVoters.map(v => ({
    'Nombre':            v.nombre        || '',
    'Cédula':            v.cedula        || '',
    'Teléfono':          v.telefono      || '',
    'Región':            v.region        || '',
    'Municipio':         v.provincia     || '',
    'Sección':           v.municipio     || '',
    'Distrito':          v.distrito      || '',
    'Zona':              v.zona          || '',
    'Sector':            v.sector        || '',
    'Mesa':              v.mesa          || '',
    'Recinto':           v.recinto       || '',
    'Observación':       v.observacion   || '',
    'Registrado por':    v.registrado_por_nombre || '',
    'Rol registrador':   v.registrado_por_rol    || '',
    'Fecha':             formatDate(v.created_at),
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Registros Peravia');
  XLSX.writeFile(wb, `Peravia_Registros_${new Date().toISOString().substring(0,10)}.xlsx`);
  showNotif('success', 'Exportado', `${data.length} registros exportados.`);
  logAudit('DATA_EXPORT', null, `Exportación Excel: ${data.length} registros`);
}

function exportAuditToExcel() {
  const logs = getFilteredAuditLogs();
  if (!logs.length) { showNotif('warning', 'Sin datos', 'No hay logs para exportar.'); return; }
  const data = logs.map(l => ({
    'Fecha/Hora': formatDate(l.created_at, true),
    'Actor':     l.actor_nombre || '',
    'Rol':       l.actor_rol    || '',
    'Acción':    l.accion       || '',
    'Objetivo':  l.objetivo     || '',
    'Detalles':  l.detalles     || '',
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Auditoría');
  XLSX.writeFile(wb, `Peravia_Auditoria_${new Date().toISOString().substring(0,10)}.xlsx`);
}

/* ══════════════════════════════════════════════════════════
   AUDITORÍA — LOG
══════════════════════════════════════════════════════════ */
async function logAudit(accion, objetivo, detalles) {
  try {
    const p = APP.currentProfile;
    await getSupabase().from('auditoria').insert({
      actor_id:     APP.currentUser?.id,
      actor_nombre: p?.nombre_completo || p?.username || 'Sistema',
      actor_rol:    p?.rol || '—',
      accion,
      objetivo:     objetivo ? String(objetivo) : null,
      detalles,
      created_at:   new Date().toISOString(),
    });
  } catch (err) {
    console.warn('Audit log failed:', err);
  }
}

/* ══════════════════════════════════════════════════════════
   UI — NAVEGACIÓN DE PANELES
══════════════════════════════════════════════════════════ */
function activatePanel(panelId) {
  // Paneles de contenido
  document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('usersSection')?.classList.add('section-hidden');
  document.getElementById('panelAudit')?.classList.add('section-hidden');

  // Nav items
  document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  document.querySelectorAll(`[data-panel="${panelId}"]`).forEach(b => { b.classList.add('active'); b.setAttribute('aria-current', 'page'); });

  // Mostrar panel
  switch (panelId) {
    case 'overview':
      document.getElementById('panelOverview')?.classList.add('active');
      break;
    case 'registro':
      document.getElementById('panelRegistro')?.classList.add('active');
      break;
    case 'consulta':
      document.getElementById('panelConsulta')?.classList.add('active');
      break;
    case 'usuarios':
      document.getElementById('usersSection')?.classList.remove('section-hidden');
      break;
    case 'auditoria':
      document.getElementById('panelAudit')?.classList.remove('section-hidden');
      loadAuditLogs();
      break;
  }
}

/* ══════════════════════════════════════════════════════════
   TEMA CLARO / OSCURO
══════════════════════════════════════════════════════════ */
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('peravia_theme', theme);
  const sun  = document.getElementById('themeIconSun');
  const moon = document.getElementById('themeIconMoon');
  if (sun && moon) {
    sun.style.display  = theme === 'light' ? '' : 'none';
    moon.style.display = theme === 'dark'  ? '' : 'none';
  }
}

/* ══════════════════════════════════════════════════════════
   MODALES
══════════════════════════════════════════════════════════ */
function showModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.add('hidden'); document.body.style.overflow = ''; }
}
function showDuplicateModal(nombre, registradoPor) {
  document.getElementById('dupVoterBody').innerHTML =
    `<strong>${esc(nombre)}</strong> ya está registrado por <strong>${esc(registradoPor || 'otro usuario')}</strong>.`;
  showModal('duplicateVoterModal');
}

/* ══════════════════════════════════════════════════════════
   NOTIFICACIONES TOAST
══════════════════════════════════════════════════════════ */
function showNotif(type, title, body = '') {
  const icons = {
    success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>',
    info:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const notif = document.createElement('div');
  notif.className = `notif ${type}`;
  notif.innerHTML = `
    <div class="notif-icon">${icons[type] || icons.info}</div>
    <div class="notif-body">
      <strong>${esc(title)}</strong>
      ${body ? `<span>${esc(body)}</span>` : ''}
    </div>
  `;
  const container = document.getElementById('notifContainer');
  container?.appendChild(notif);
  setTimeout(() => {
    notif.classList.add('notif-out');
    setTimeout(() => notif.remove(), 250);
  }, 3500);
}

/* ══════════════════════════════════════════════════════════
   HELPERS DE UI
══════════════════════════════════════════════════════════ */
function showAuthMsg(type, msg) {
  const el = document.getElementById('authMessage');
  if (!el) return;
  
  // Limpiar timeout anterior si existe
  if (el.dataset.timeout) {
    clearTimeout(parseInt(el.dataset.timeout));
  }
  
  el.className = `status-message ${type}`;
  el.textContent = msg;
  
  // Auto-limpiar después de 6 segundos si es success, 5 si es error
  const duration = type === 'success' ? 6000 : 5000;
  const timeout = setTimeout(() => {
    el.className = 'status-message';
    el.textContent = '';
  }, duration);
  
  el.dataset.timeout = timeout;
}

function showStatusMsg(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `status-message ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => { el.className = 'status-message'; el.textContent = ''; }, 4000);
}

function setSubmitLoading(formId, loading) {
  const form = document.getElementById(formId);
  if (!form) return;
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  
  // Guardar el HTML original en la primera llamada
  if (!btn.dataset.originalHtml) {
    btn.dataset.originalHtml = btn.innerHTML;
  }
  
  btn.disabled = loading;
  
  if (loading) {
    btn.innerHTML = '<span style="display: inline-flex; align-items: center; gap: 8px;"><span class="spinner"></span> Procesando…</span>';
  } else {
    btn.innerHTML = btn.dataset.originalHtml;
  }
}

function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }
function esc(str) { return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return d.toLocaleDateString('es-DO', opts);
}
function getAuthError(msg) {
  if (!msg) return 'Error desconocido.';
  
  const msgLower = msg.toLowerCase();
  
  // Mapeo de errores comunes
  const errorMap = {
    'invalid login credentials': 'Credenciales inválidas. Verifique usuario y contraseña.',
    'invalid_credentials': 'Credenciales inválidas. Verifique usuario y contraseña.',
    'email not confirmed': 'Confirme su correo electrónico.',
    'user already registered': 'Este correo ya está registrado.',
    'already registered': 'Este correo ya está registrado.',
    'password should be at least 6 characters': 'La contraseña debe tener al menos 6 caracteres.',
    'password_too_short': 'La contraseña debe tener al menos 6 caracteres.',
    'for security purposes, you can only request this after': 'Espere un momento antes de volver a intentarlo.',
    'invalid email': 'Correo electrónico inválido.',
    'email already in use': 'Este correo ya está en uso.',
    'username already taken': 'Este nombre de usuario ya está registrado.',
    'supabase is not defined': 'Error de configuración: Supabase no está inicializado. Verifique las credenciales.',
    'cannot read properties of null': 'Error de conexión: No se pudo conectar con el servidor.',
  };
  
  for (const [key, value] of Object.entries(errorMap)) {
    if (msgLower.includes(key)) return value;
  }
  
  // Si no coincide con ninguno, devolver el mensaje original (limitado)
  return msg.substring(0, 150) || 'Error desconocido.';
}
function getActionClass(action) {
  if (!action) return '';
  if (action.includes('LOGIN'))     return 'action-login';
  if (action.includes('LOGOUT'))    return 'action-logout';
  if (action.includes('CREATE'))    return 'action-create';
  if (action.includes('EDIT'))      return 'action-edit';
  if (action.includes('DELETE'))    return 'action-delete';
  if (action.includes('EXPORT'))    return 'action-export';
  if (action.includes('DUPLICATE')) return 'action-duplicate';
  if (action.includes('APPROVE'))   return 'action-approve';
  return '';
}

/* ══════════════════════════════════════════════════════════
   EVENTOS
══════════════════════════════════════════════════════════ */
function bindEvents() {
  // Auth
  document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
  document.getElementById('registerForm')?.addEventListener('submit', handleRegister);
  document.getElementById('forgotForm')?.addEventListener('submit', handleForgotPassword);
  document.getElementById('resetForm')?.addEventListener('submit', handleResetPassword);

  // Tabs de auth
  document.getElementById('showLogin')?.addEventListener('click', () => {
    document.getElementById('loginForm').classList.add('active');
    document.getElementById('registerForm').classList.remove('active');
    document.getElementById('showLogin').classList.add('active');
    document.getElementById('showRegister').classList.remove('active');
    document.getElementById('authMessage').className = 'status-message';
    document.getElementById('authMessage').textContent = '';
  });
  document.getElementById('showRegister')?.addEventListener('click', () => {
    document.getElementById('registerForm').classList.add('active');
    document.getElementById('loginForm').classList.remove('active');
    document.getElementById('showRegister').classList.add('active');
    document.getElementById('showLogin').classList.remove('active');
    document.getElementById('authMessage').className = 'status-message';
    document.getElementById('authMessage').textContent = '';
  });

  // Modales auth
  document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => showModal('forgotPasswordModal'));
  document.getElementById('closeForgotModalBtn')?.addEventListener('click', () => closeModal('forgotPasswordModal'));
  document.getElementById('cancelForgotBtn')?.addEventListener('click', () => closeModal('forgotPasswordModal'));

  // Logout
  document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);

  // Tema
  document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);

  // Exportar
  document.getElementById('exportBtn')?.addEventListener('click', exportToExcel);
  document.getElementById('auditExportBtn')?.addEventListener('click', exportAuditToExcel);

  // Sidebar toggle (móvil)
  document.getElementById('sidebarToggleBtn')?.addEventListener('click', () => {
    const sidebar = document.getElementById('appSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('active');
  });
  document.getElementById('sidebarOverlay')?.addEventListener('click', () => {
    document.getElementById('appSidebar')?.classList.remove('open');
    document.getElementById('sidebarOverlay')?.classList.remove('active');
  });

  // Nav items
  document.querySelectorAll('.nav-item[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      activatePanel(btn.dataset.panel);
      // Cerrar sidebar en móvil
      if (window.innerWidth <= 768) {
        document.getElementById('appSidebar')?.classList.remove('open');
        document.getElementById('sidebarOverlay')?.classList.remove('active');
      }
    });
  });

  // Grupos de navegación colapsables
  document.querySelectorAll('.nav-group-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const target = document.getElementById(hdr.dataset.target);
      if (!target) return;
      hdr.classList.toggle('open');
      target.classList.toggle('collapsed');
    });
    hdr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hdr.click(); } });
  });

  // Registro
  document.getElementById('voterForm')?.addEventListener('submit', handleVoterSubmit);
  document.getElementById('cancelEditVoterBtn')?.addEventListener('click', cancelEditVoter);

  // Usuarios
  document.getElementById('userEditForm')?.addEventListener('submit', handleUserEdit);
  document.getElementById('closeUserEditModalBtn')?.addEventListener('click', () => closeModal('userEditModal'));
  document.getElementById('cancelUserEditBtn')?.addEventListener('click', () => closeModal('userEditModal'));

  // Modales — cerrar al clicar fondo
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Duplicate voter modal
  document.getElementById('closeDupVoterBtn')?.addEventListener('click', () => closeModal('duplicateVoterModal'));

  // Reset password modal
  document.getElementById('resetForm')?.addEventListener('submit', handleResetPassword);

  // Filtros
  const filterIds = ['searchInput','filterProvince','filterMunicipio','filterSector','filterMesa','filterRole','filterRegistrar'];
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', applyFilters);
  });
  document.getElementById('clearFiltersBtn')?.addEventListener('click', clearFilters);

  // Búsqueda del topbar
  document.getElementById('topbarSearchInput')?.addEventListener('input', e => handleTopbarSearch(e.target.value));

  // Filtros de auditoría
  ['auditSearch','auditFilterAction','auditFilterActor','auditFilterFrom','auditFilterTo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      APP.auditPage = 1;
      renderAuditTable(getFilteredAuditLogs());
    });
  });

  // Escape para cerrar modales
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => closeModal(m.id));
    }
  });

  // Modal Conóceme
  document.getElementById('conocemeBtn')?.addEventListener('click', () => showModal('conocemeModal'));
  document.getElementById('closeConocemeBtn')?.addEventListener('click', () => closeModal('conocemeModal'));
}

/* ══════════════════════════════════════════════════════════
   EXPONER FUNCIONES GLOBALES (usadas en onclick del HTML)
══════════════════════════════════════════════════════════ */
window.editVoter        = editVoter;
window.deleteVoter      = deleteVoter;
window.openEditUser     = openEditUser;
window.toggleUserStatus = toggleUserStatus;
window.deleteUser       = deleteUser;