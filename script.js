/* =========================================================
   ADMINISTRACIÓN PERAVIA — script.js
   Sistema completo: Auth, CRUD, Exports, UI, Auditoría
   ========================================================= */

'use strict';

/* ── CONFIGURACIÓN ─────────────────────────────────────── */
const SUPABASE_URL  = 'https://nmvqqbwfotvslwxkohrt.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tdnFxYndmb3R2c2x3eGtvaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MTc4NTksImV4cCI6MjA5Mjk5Mzg1OX0.lpvLNqaRy6XElWsxe_R09XecvFpWffdiye1uet0oxFU';

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

const getSupabase = () => window.supabaseClient;

/* ── Timeout wrapper — evita que llamadas lentas queden colgadas ─ */
async function withTimeout(promise, ms = 12000, label = '') {
  let timer;
  const race = new Promise((_, reject) => {
    timer = setTimeout(() => reject(
      new Error('Tiempo de espera agotado' + (label ? `: ${label}` : ''))
    ), ms);
  });
  try { return await Promise.race([promise, race]); }
  finally { clearTimeout(timer); }
}

/* ── Despertar Supabase Free antes del login ────────────────────── */
// Supabase Free pausa el proyecto tras inactividad (~1 semana).
// Al mostrar el formulario de login disparamos una llamada barata
// para que el servidor esté despierto cuando el usuario pulse "Entrar".
function _warmUpSupabase() {
  if (DEMO_MODE) return;
  try {
    getSupabase()
      .rpc('check_username_exists', { p_username: '__ping__' })
      .then(() => console.log('[SISTEMA M] Servidor listo'))
      .catch(() => {});
  } catch (_) {}
}

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

const ROLES = [
  { value: 'Administrador',    label: 'Administrador' },
  { value: 'Coordinador',      label: 'Coordinador municipal' },
  { value: 'Supervisor',       label: 'Supervisor de zona' },
  { value: 'Registrador',      label: 'Registrador' },
  { value: 'Observador',       label: 'Observador' }
];

const ROLE_LEVEL = {
  'Administrador': 5,
  'Coordinador':   4,
  'Supervisor':    3,
  'Registrador':   2,
  'Observador':    1
};

/* ── ESTADO GLOBAL ─────────────────────────────────────── */
const APP = {
  currentUser:     null,
  currentProfile:  null,
  allVoters:       [],
  allUsers:        [],
  filteredVoters:  [],
  auditLogs:       [],
  auditPage:       1,
  AUDIT_PAGE_SIZE: 20,
  votersPage:      1,       // Paginación de tabla de registros
  VOTERS_PAGE_SIZE: 50,     // Registros por página en consulta
  chart:           null,
  searchDebounce:  null,
  _loginInProgress: false,  // Flag para evitar race conditions en auth
};

/* ══════════════════════════════════════════════════════════
   AUTO-LOGOUT POR INACTIVIDAD — 30 minutos
   • Detecta actividad del usuario (mouse, teclado, táctil, scroll)
   • Avisa a los 28 minutos con un banner
   • Cierra la sesión automáticamente a los 30 minutos
══════════════════════════════════════════════════════════ */
const INACTIVITY_LOGOUT_MS = 30 * 60 * 1000;   // 30 minutos → cierre
const INACTIVITY_WARN_MS   = 28 * 60 * 1000;   // 28 minutos → aviso
const INACTIVITY_CHECK_MS  = 20 * 1000;         // revisar cada 20 seg

let _lastActivity    = Date.now();
let _inactivityTimer = null;
let _warnShown       = false;
let _activityThrottle = 0;

/** Reinicia el contador de actividad */
function resetActivity() {
  const now = Date.now();
  if (now - _activityThrottle < 4000) return; // throttle: máximo 1 reset cada 4 seg
  _activityThrottle = now;
  _lastActivity = now;
  if (_warnShown) { _warnShown = false; hideInactivityWarning(); }
}

/** Inicia la vigilancia de inactividad (llamar al entrar al dashboard) */
function startInactivityWatch() {
  _lastActivity = Date.now();
  _warnShown    = false;

  const events = ['mousemove','mousedown','keydown','touchstart','scroll','click','pointerdown'];
  events.forEach(ev => document.addEventListener(ev, resetActivity, { passive: true }));

  if (_inactivityTimer) clearInterval(_inactivityTimer);
  _inactivityTimer = setInterval(_checkInactivity, INACTIVITY_CHECK_MS);
  console.info('[Peravia] Vigilancia de inactividad activa — cierre en 30 min');
}

/** Detiene la vigilancia (llamar al cerrar sesión) */
function stopInactivityWatch() {
  if (_inactivityTimer) { clearInterval(_inactivityTimer); _inactivityTimer = null; }
  hideInactivityWarning();
  _warnShown = false;
}

/** Comprueba inactividad y actúa según el tiempo transcurrido */
function _checkInactivity() {
  if (!APP.currentUser) return;
  const idle = Date.now() - _lastActivity;

  if (idle >= INACTIVITY_LOGOUT_MS) {
    // ── Cerrar sesión ──────────────────────────────────────────
    hideInactivityWarning();
    showNotif('warning', 'Sesión cerrada por inactividad',
      'Pasaron 30 minutos sin actividad.');
    handleLogout();
    return;
  }

  if (idle >= INACTIVITY_WARN_MS && !_warnShown) {
    // ── Mostrar aviso ──────────────────────────────────────────
    _warnShown = true;
    showInactivityWarning();
  }
}

/** Muestra el banner de advertencia antes del cierre */
function showInactivityWarning() {
  let el = document.getElementById('inactivityWarning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'inactivityWarning';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.innerHTML = `
      <div class="ina-inner">
        <div class="ina-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="13"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div class="ina-text">
          <strong>¿Sigues ahí?</strong>
          <span>La sesión se cerrará en <strong id="inaCountdown">2:00</strong> por inactividad.</span>
        </div>
        <button class="ina-btn" id="inactivityStayBtn" type="button">Continuar</button>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('inactivityStayBtn')?.addEventListener('click', () => {
      resetActivity();
      _lastActivity = Date.now(); // forzar reset aunque el throttle esté activo
    });
  }
  el.classList.add('visible');

  // Cuenta regresiva de 2 minutos
  const countEl = document.getElementById('inaCountdown');
  let secsLeft = Math.round((INACTIVITY_LOGOUT_MS - (Date.now() - _lastActivity)) / 1000);
  if (secsLeft < 0) secsLeft = 0;

  const countInt = setInterval(() => {
    if (!_warnShown) { clearInterval(countInt); return; }
    secsLeft = Math.round((INACTIVITY_LOGOUT_MS - (Date.now() - _lastActivity)) / 1000);
    if (secsLeft <= 0) { clearInterval(countInt); return; }
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    if (countEl) countEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

/** Oculta el banner de advertencia */
function hideInactivityWarning() {
  const el = document.getElementById('inactivityWarning');
  if (el) el.classList.remove('visible');
}

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
    if (SUPABASE_URL === 'TU_SUPABASE_URL' || SUPABASE_ANON === 'TU_SUPABASE_ANON_KEY') {
      DEMO_MODE = true;
      window.supabaseClient = createMockSupabase();
      console.warn('⚠️ Modo demo activado');
      resolve();
      return;
    }

    // Crear cliente una sola vez
    const createClient = () => {
      if (!window.supabaseClient) {
        window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
            storageKey: 'peravia-auth-token', // clave única para evitar conflictos
          }
        });
      }
    };

    if (window.supabase?.createClient) {
      createClient();
      resolve();
      return;
    }

    let attempts = 0;
    const int = setInterval(() => {
      attempts++;
      if (window.supabase?.createClient) {
        clearInterval(int);
        createClient();
        resolve();
      } else if (attempts >= 50) {
        clearInterval(int);
        console.warn('⚠️ Supabase no disponible - modo demo');
        DEMO_MODE = true;
        window.supabaseClient = createMockSupabase();
        resolve();
      }
    }, 100);
  });
}

async function init() {
  applyTheme(localStorage.getItem('peravia_theme') || 'light');
  populateSelects();
  bindEvents();

  // Recuperación de contraseña via URL hash
  const hash = window.location.hash;
  if (hash.includes('type=recovery')) {
    showAuth();
    showModal('resetPasswordModal');
    return;
  }

  // Solo TOKEN_REFRESHED y SIGNED_OUT — NO SIGNED_IN (evita auto-login desde sesión guardada)
  const sb = getSupabase();
  if (sb?.auth?.onAuthStateChange) {
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session) {
        APP.currentUser = session.user;
      }
      if (event === 'SIGNED_OUT') {
        APP.currentUser      = null;
        APP.currentProfile   = null;
        APP._loginInProgress = false;
        showAuth();
      }
    });
  }

  showAuth();
  _warmUpSupabase();
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
  // Limpiar formulario de login y mensajes al volver
  document.getElementById('loginForm')?.reset();
  const msg = document.getElementById('authMessage');
  if (msg) { msg.className = 'status-message'; msg.textContent = ''; }
  // Asegurar que se muestra la pestaña de login
  document.getElementById('loginForm')?.classList.add('active');
  document.getElementById('registerForm')?.classList.remove('active');
  document.getElementById('showLogin')?.classList.add('active');
  document.getElementById('showRegister')?.classList.remove('active');
}

async function showDashboard() {
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('dashboardSection').classList.remove('hidden');
  document.querySelector('.site-footer').style.display = 'none';
  activatePanel('overview');
  updateSidebarUser();        // incluye updateSidebarAvatar()
  applyRolePermissions();
  startInactivityWatch();     // ← Vigilancia de 30 min de inactividad
  ['totalVoters','totalUsers','todayVoters','activeProvinces'].forEach(id => setEl(id, '…'));

  // Cargar datos en background — no bloquea el UI ni el flujo de login
  Promise.all([loadVoters(), loadUsers()])
    .then(() => renderOverview())
    .catch(err => {
      console.warn('Error cargando datos del dashboard:', err);
      renderOverview(); // Mostrar resumen con lo que haya
    });

  if (!DEMO_MODE) {
    console.info(`[Peravia] Sesión activa: ${APP.currentProfile?.nombre_completo} (${APP.currentProfile?.rol}) — cargando datos en segundo plano…`);
  }
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

  const admin = isAdmin();

  // Auditoría — solo Admin
  const auditBtn = document.getElementById('navAuditBtn');
  if (admin) {
    auditBtn?.classList.remove('section-hidden');
  } else {
    auditBtn?.classList.add('section-hidden');
  }

  // Usuarios — solo Admin
  const usersBtn = document.getElementById('manageUsersBtn');
  if (admin) {
    usersBtn?.classList.remove('section-hidden');
  } else {
    usersBtn?.classList.add('section-hidden');
  }

  // Columna acciones en tabla de registros — solo Coord o superior
  const actionsHead = document.getElementById('voterActionsHead');
  if (!isCoordOrAbove() && actionsHead) {
    actionsHead.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════════
   PERFIL DE USUARIO
══════════════════════════════════════════════════════════ */
function updateSidebarUser() {
  const p = APP.currentProfile;
  if (!p) return;
  const nameEl   = document.getElementById('sidebarUserName');
  const roleEl   = document.getElementById('sidebarUserRole');
  if (nameEl) nameEl.textContent = p.nombre_completo || p.username || '—';
  if (roleEl) roleEl.textContent = p.rol || '—';
  updateSidebarAvatar();
}

/* Actualiza el avatar del sidebar (foto o inicial) */
function updateSidebarAvatar() {
  const avatarEl = document.getElementById('sidebarAvatar');
  if (!avatarEl) return;
  const saved = localStorage.getItem(`peravia_avatar_${APP.currentUser?.id}`);
  if (saved) {
    avatarEl.innerHTML = `<img src="${saved}" alt="Foto de perfil" />`;
  } else {
    const initial = (APP.currentProfile?.nombre_completo || APP.currentProfile?.username || '?').charAt(0).toUpperCase();
    avatarEl.textContent = initial;
  }
}

/* ══════════════════════════════════════════════════════════
   PANEL DE PERFIL — Abrir / Cerrar
══════════════════════════════════════════════════════════ */
function openProfileModal() {
  const p = APP.currentProfile;
  if (!p) return;

  // Rellenar datos del héroe
  const heroRole   = document.getElementById('profileHeroRole');
  const heroEmail  = document.getElementById('profileHeroEmail');
  const heroMunici = document.getElementById('profileHeroMunici');
  if (heroRole)   heroRole.textContent   = p.rol || '—';
  if (heroEmail)  heroEmail.textContent  = p.email || '—';
  if (heroMunici) heroMunici.textContent = p.provincia ? `📍 ${p.provincia}` : '';

  // Rellenar formulario
  const nameInput  = document.getElementById('profileModalName');
  const phoneInput = document.getElementById('profileModalPhone');
  const usernameEl = document.getElementById('profileModalUsername');
  if (nameInput)  nameInput.value     = p.nombre_completo || '';
  if (phoneInput) phoneInput.value    = p.telefono || '';
  if (usernameEl) usernameEl.textContent = p.username || '—';

  // Limpiar campos de contraseña
  ['profileCurrentPwd','profileNewPwd','profileConfirmPwd'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });

  // Mostrar foto o iniciales en el modal
  const img      = document.getElementById('profileAvatarImg');
  const initials = document.getElementById('profileAvatarInitials');
  const saved    = localStorage.getItem(`peravia_avatar_${APP.currentUser?.id}`);
  if (saved && img && initials) {
    img.src = saved;
    img.classList.remove('hidden');
    initials.style.display = 'none';
  } else if (img && initials) {
    img.classList.add('hidden');
    img.src = '';
    initials.style.display = 'flex';
    initials.textContent = (p.nombre_completo || '?').charAt(0).toUpperCase();
  }

  // Limpiar mensaje previo
  const msg = document.getElementById('profileMessage');
  if (msg) { msg.className = 'status-message'; msg.textContent = ''; }

  showModal('profileModal');
}

/* ── Subida de foto de perfil ─────────────────────────────────── */
function handlePhotoUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showStatusMsg('profileMessage', 'error', 'Seleccione una imagen válida (JPG, PNG, WEBP).');
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    showStatusMsg('profileMessage', 'error', 'La imagen no puede superar 2 MB.');
    return;
  }

  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    localStorage.setItem(`peravia_avatar_${APP.currentUser?.id}`, dataUrl);

    // Actualizar preview en el modal
    const img      = document.getElementById('profileAvatarImg');
    const initials = document.getElementById('profileAvatarInitials');
    if (img && initials) {
      img.src = dataUrl;
      img.classList.remove('hidden');
      initials.style.display = 'none';
    }

    // Actualizar sidebar
    updateSidebarAvatar();
    showStatusMsg('profileMessage', 'success', '✓ Foto actualizada.');
    showNotif('success', 'Foto de perfil actualizada', '');
  };
  reader.onerror = () => showStatusMsg('profileMessage', 'error', 'Error al leer la imagen.');
  reader.readAsDataURL(file);

  // Reset input para permitir subir la misma imagen de nuevo
  e.target.value = '';
}

/* ── Eliminar foto ────────────────────────────────────────────── */
function removeProfilePhoto() {
  localStorage.removeItem(`peravia_avatar_${APP.currentUser?.id}`);

  const img      = document.getElementById('profileAvatarImg');
  const initials = document.getElementById('profileAvatarInitials');
  if (img && initials) {
    img.classList.add('hidden');
    img.src = '';
    initials.style.display = 'flex';
    initials.textContent = (APP.currentProfile?.nombre_completo || '?').charAt(0).toUpperCase();
  }
  updateSidebarAvatar();
  showStatusMsg('profileMessage', 'info', 'Foto de perfil eliminada.');
}

/* ── Guardar cambios del perfil ───────────────────────────────── */
async function handleProfileUpdate(e) {
  e.preventDefault();

  const name       = document.getElementById('profileModalName')?.value.trim();
  const phone      = document.getElementById('profileModalPhone')?.value.trim();
  const currentPwd = document.getElementById('profileCurrentPwd')?.value;
  const newPwd     = document.getElementById('profileNewPwd')?.value;
  const confirmPwd = document.getElementById('profileConfirmPwd')?.value;

  if (!name) return showStatusMsg('profileMessage', 'error', 'El nombre no puede estar vacío.');

  // Validar contraseña si se intenta cambiar
  const changingPwd = newPwd || confirmPwd || currentPwd;
  if (changingPwd) {
    if (!currentPwd) return showStatusMsg('profileMessage', 'error', 'Ingrese su contraseña actual para cambiarla.');
    if (!newPwd)     return showStatusMsg('profileMessage', 'error', 'Ingrese la nueva contraseña.');
    if (newPwd !== confirmPwd) return showStatusMsg('profileMessage', 'error', 'Las contraseñas nuevas no coinciden.');
    if (newPwd.length < 6)    return showStatusMsg('profileMessage', 'error', 'La nueva contraseña debe tener al menos 6 caracteres.');
  }

  const saveBtn = document.getElementById('profileSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> Guardando…'; }

  try {
    let changed = false;

    // Actualizar datos del perfil en la BD
    if (name !== APP.currentProfile?.nombre_completo || phone !== (APP.currentProfile?.telefono || '')) {
      const { error } = await withTimeout(
        getSupabase().from('usuarios').update({ nombre_completo: name, telefono: phone }).eq('auth_user_id', APP.currentUser.id),
        10000, 'actualizar perfil'
      );
      if (error) throw error;
      APP.currentProfile = { ...APP.currentProfile, nombre_completo: name, telefono: phone };
      updateSidebarUser();
      changed = true;
    }

    // Cambiar contraseña
    if (changingPwd) {
      // Verificar contraseña actual re-autenticando
      const { error: loginErr } = await withTimeout(
        getSupabase().auth.signInWithPassword({ email: APP.currentProfile.email, password: currentPwd }),
        10000, 'verificar contraseña'
      );
      if (loginErr) throw new Error('Contraseña actual incorrecta.');

      const { error: pwdErr } = await withTimeout(
        getSupabase().auth.updateUser({ password: newPwd }),
        10000, 'cambiar contraseña'
      );
      if (pwdErr) throw pwdErr;

      // Limpiar campos
      ['profileCurrentPwd','profileNewPwd','profileConfirmPwd'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
      });
      changed = true;
    }

    if (changed) {
      showStatusMsg('profileMessage', 'success', '✓ Perfil actualizado correctamente.');
      showNotif('success', 'Perfil actualizado', APP.currentProfile.nombre_completo);
      await logAudit('PROFILE_UPDATE', APP.currentUser?.id, 'Perfil actualizado por el usuario');
    } else {
      showStatusMsg('profileMessage', 'info', 'No hubo cambios que guardar.');
    }

  } catch (err) {
    showStatusMsg('profileMessage', 'error', err.message || 'Error al actualizar el perfil.');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Guardar cambios`;
    }
  }
}

/* ══════════════════════════════════════════════════════════
   LOGIN
══════════════════════════════════════════════════════════ */
async function handleLogin(e) {
  e.preventDefault();
  const userInput = document.getElementById('loginUser').value.trim();
  const password  = document.getElementById('loginPassword').value;

  if (!userInput) return showAuthMsg('error', 'Ingrese correo o nombre de usuario.');
  if (!password)  return showAuthMsg('error', 'Ingrese su contraseña.');

  setSubmitLoading('loginForm', true);
  let _loginSlowTimer = null; // fuera del try para que finally pueda limpiar
  try {
    APP._loginInProgress = true;
    if (DEMO_MODE) {
      showAuthMsg('success', '✓ Acceso en modo demo - Bienvenido');
      APP.currentUser = { id: 'demo_user', email: userInput };
      APP.currentProfile = {
        auth_user_id: 'demo_user',
        nombre_completo: 'Usuario Demo',
        username: userInput,
        rol: 'Administrador',
        estado: 'aprobado'
      };
      await showDashboard();
      return;
    }

    // Avisar si tarda más de 5s (Supabase Free despertando)
    _loginSlowTimer = setTimeout(() => {
      showAuthMsg('info', '⏳ El servidor está iniciando, espere…');
    }, 5000);

    let email = userInput;
    if (!userInput.includes('@')) {
      showAuthMsg('info', 'Conectando al servidor…');
      const { data: foundEmail, error: findErr } = await withTimeout(
        getSupabase().rpc('get_email_from_username', { p_username: userInput }),
        30000, 'buscar usuario'
      );
      if (findErr) throw findErr;
      if (!foundEmail) {
        showAuthMsg('error', 'Usuario no encontrado. Verifique su nombre de usuario.');
        return;
      }
      email = foundEmail;
    }

    showAuthMsg('info', 'Verificando credenciales…');
    const { data, error } = await withTimeout(
      getSupabase().auth.signInWithPassword({ email, password }),
      30000, 'iniciar sesión'
    );
    if (error) throw error;
    if (!data?.user?.id) throw new Error('No se pudo verificar la identidad del usuario.');

    clearTimeout(_loginSlowTimer);
    _loginSlowTimer = null;

    showAuthMsg('info', 'Cargando perfil…');
    const { data: profile, error: profileErr } = await withTimeout(
      getSupabase().from('usuarios').select('*').eq('auth_user_id', data.user.id).maybeSingle(),
      12000, 'perfil de usuario'
    );
    if (profileErr) throw profileErr;

    if (!profile) {
      await getSupabase().auth.signOut();
      showAuthMsg('error', 'Perfil no encontrado. Contacte al administrador.');
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

    APP.currentUser    = data.user;
    APP.currentProfile = profile;
    logAudit('SESSION_LOGIN', data.user.id, `Inicio de sesión — ${profile.nombre_completo} (${profile.rol})`).catch(() => {});
    showAuthMsg('success', '✓ Accediendo al sistema...');
    showDashboard();

  } catch (err) {
    console.error('Error de login:', err);
    showAuthMsg('error', getAuthError(err.message));
    try {
      getSupabase().from('auditoria').insert({
        actor_id: null,
        actor_nombre: document.getElementById('loginUser')?.value?.trim() || 'Desconocido',
        actor_rol: '—', accion: 'SESSION_LOGIN_FAILED', objetivo: null,
        detalles: `Intento fallido: ${err.message}`,
        created_at: new Date().toISOString(),
      }).catch(() => {});
    } catch (_) {}
  } finally {
    if (_loginSlowTimer) clearTimeout(_loginSlowTimer);
    APP._loginInProgress = false;
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
  const distrito   = document.getElementById('registerDistrito').value.trim();
  const zone       = document.getElementById('registerZone').value.trim();
  const password   = document.getElementById('registerPassword').value;
  const confirm    = document.getElementById('registerPasswordConfirm').value;

  // Validaciones — sin tocar el botón todavía
  if (!name)              return showAuthMsg('error', 'Nombre completo es requerido.');
  if (!username)          return showAuthMsg('error', 'Nombre de usuario es requerido.');
  if (username.length < 3)return showAuthMsg('error', 'El usuario debe tener al menos 3 caracteres.');
  if (!email || !email.includes('@')) return showAuthMsg('error', 'Ingrese un correo válido.');
  if (!phone)             return showAuthMsg('error', 'Teléfono es requerido.');
  if (!role)              return showAuthMsg('error', 'Debe seleccionar un rol.');
  if (!province)          return showAuthMsg('error', 'Debe seleccionar un municipio.');
  if (!zone)              return showAuthMsg('error', 'Zona o demarcación es requerida.');
  if (!password)          return showAuthMsg('error', 'Contraseña es requerida.');
  if (password.length < 6)return showAuthMsg('error', 'La contraseña debe tener al menos 6 caracteres.');
  if (password !== confirm)return showAuthMsg('error', 'Las contraseñas no coinciden.');

  setSubmitLoading('registerForm', true);
  try {
    APP._loginInProgress = true; // Bloquear onAuthStateChange durante registro

    if (DEMO_MODE) {
      showAuthMsg('success', '✓ Usuario creado en modo demo. Puede iniciar sesión.');
      document.getElementById('registerForm').reset();
      // Cambiar a pestaña login sin setTimeout para que el finally corra
      document.getElementById('showLogin').click();
      return;
    }

    const { data: usernameExists } = await getSupabase()
      .rpc('check_username_exists', { p_username: username });
    if (usernameExists) {
      showAuthMsg('error', 'El nombre de usuario ya está en uso.');
      return;
    }

    const { data: authData, error: authErr } = await getSupabase().auth.signUp({ email, password });
    if (authErr) {
      if (authErr.message?.includes('already registered')) throw new Error('Este correo ya está registrado.');
      throw authErr;
    }
    if (!authData?.user?.id) throw new Error('No se pudo crear la cuenta de autenticación.');

    // Intentar insertar perfil via RPC; si no existe, INSERT directo
    let profileInserted = false;
    try {
      const { error: rpcErr } = await getSupabase()
        .rpc('register_user_profile', {
          p_auth_user_id:    authData.user.id,
          p_nombre_completo: name,
          p_username:        username,
          p_email:           email,
          p_telefono:        phone,
          p_rol:             role,
          p_provincia:       province,
          p_region:          region,
          p_distrito:        distrito,
          p_zona:            zone,
        });
      if (!rpcErr) profileInserted = true;
      else if (!rpcErr.message?.includes('does not exist') && !rpcErr.message?.includes('Could not find')) {
        throw new Error(rpcErr.message);
      }
    } catch (rpcEx) {
      if (!rpcEx.message?.includes('does not exist') && !rpcEx.message?.includes('Could not find')) {
        throw rpcEx;
      }
    }

    if (!profileInserted) {
      let estadoFallback = 'pendiente';
      try {
        const { count } = await getSupabase()
          .from('usuarios').select('*', { count: 'exact', head: true });
        if (count === 0) estadoFallback = 'aprobado';
      } catch (_) {}

      const { error: insertErr } = await getSupabase()
        .from('usuarios')
        .insert({
          auth_user_id:    authData.user.id,
          nombre_completo: name,
          username,
          email,
          telefono:  phone,
          rol:       role,
          provincia: province,
          region,
          distrito,
          zona:      zone,
          estado:    estadoFallback,
        });
      if (insertErr) throw new Error('Error al crear perfil: ' + insertErr.message);
      if (estadoFallback === 'aprobado') {
        showAuthMsg('success', '✓ Cuenta creada. Ya puede iniciar sesión.');
        document.getElementById('registerForm').reset();
        document.getElementById('showLogin').click();
        return;
      }
    }

    showAuthMsg('success', '✓ Solicitud enviada. Espere la aprobación del administrador.');
    document.getElementById('registerForm').reset();
  } catch (err) {
    console.error('Error en registro:', err);
    showAuthMsg('error', getAuthError(err.message || 'Error desconocido al registrar'));
  } finally {
    APP._loginInProgress = false;
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
    await getSupabase().from('auditoria').insert({
      actor_id: null, actor_nombre: email, actor_rol: '—',
      accion: 'PASSWORD_RESET_REQUEST', objetivo: email,
      detalles: `Solicitud de recuperación de contraseña para: ${email}`,
      created_at: new Date().toISOString(),
    });
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
    await logAudit('PASSWORD_RESET_COMPLETE', APP.currentUser?.id, 'Contraseña actualizada exitosamente');
    setTimeout(() => { closeModal('resetPasswordModal'); window.location.hash = ''; }, 2000);
  } catch (err) {
    showStatusMsg('resetMessage', 'error', getAuthError(err.message));
  }
}

/* ══════════════════════════════════════════════════════════
   LOGOUT
══════════════════════════════════════════════════════════ */
async function handleLogout() {
  stopInactivityWatch();
  try {
    await logAudit('SESSION_LOGOUT', APP.currentUser?.id, 'Cierre de sesión');
  } catch (_) {}
  APP.currentUser      = null;
  APP.currentProfile   = null;
  APP._loginInProgress = false;
  APP.allVoters        = [];
  APP.allUsers       = [];
  APP.filteredVoters = [];
  APP.auditLogs      = [];
  if (APP.chart) { APP.chart.destroy(); APP.chart = null; }
  await getSupabase().auth.signOut();
  showAuth(); // por si onAuthStateChange no dispara en demo
  showNotif('info', 'Sesión cerrada', 'Hasta luego.');
}

/* ══════════════════════════════════════════════════════════
   CARGAR DATOS
══════════════════════════════════════════════════════════ */
async function loadVoters() {
  try {
    if (DEMO_MODE) {
      APP.allVoters = [];
      APP.filteredVoters = [];
      renderVotersTable(APP.filteredVoters);
      updateFilterBadge(0);
      return;
    }

    const p = APP.currentProfile;
    // Sin perfil cargado, no cargar nada
    if (!p) return;

    // Límite razonable por consulta (500 en lugar de 2000)
    let query = getSupabase()
      .from('registros')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(500);

    if (isAdmin()) {
      // admin ve todo
    } else if (isCoordOrAbove()) {
      query = query.eq('provincia', p.provincia);
    } else {
      // Registrador, Supervisor, Observador — solo lo que ellos registraron
      query = query.eq('registrado_por_id', APP.currentUser.id);
    }

    const { data, error, count } = await withTimeout(query, 15000, 'cargar registros');

    if (error) {
      if (error.code === '42501' || error.message?.includes('policy') || error.message?.includes('permission')) {
        showNotif('error', 'Sin permisos de lectura', 'Aplica el archivo supabase_patch.sql en Supabase para corregir las políticas RLS.');
      }
      throw error;
    }

    APP.allVoters      = data || [];
    APP.filteredVoters = [...APP.allVoters];
    APP.votersPage     = 1; // Resetear página al recargar
    renderVotersTable(APP.filteredVoters);
    updateFilterBadge(APP.filteredVoters.length);
    populateDynamicFilters(APP.allVoters);

    const total = count ?? APP.allVoters.length;
    if (total > 500) {
      showNotif('info', `Mostrando 500 de ${total} registros`, 'Use filtros para refinar la búsqueda.');
    }
    console.info(`[Peravia] loadVoters → ${APP.allVoters.length} registros para ${p.nombre_completo} (${p.rol})`);
  } catch (err) {
    console.error('Error cargando registros:', err);
    APP.allVoters     = [];
    APP.filteredVoters = [];
    renderVotersTable([]);
    updateFilterBadge(0);
  }
}

async function loadUsers() {
  if (DEMO_MODE) {
    APP.allUsers = [];
    renderUsersTable([]);
    return;
  }

  const tbody = document.getElementById('usersTableBody');
  if (tbody) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="12">
      <span style="display:inline-flex;align-items:center;gap:8px">
        <span class="spinner"></span> Cargando usuarios…
      </span>
    </td></tr>`;
  }

  try {
    let query = getSupabase()
      .from('usuarios')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (!isAdmin()) {
      query = query.eq('provincia', APP.currentProfile?.provincia);
    }

    const { data, error } = await withTimeout(query, 15000, 'cargar usuarios');
    if (error) throw error;

    APP.allUsers = data || [];
    renderUsersTable(APP.allUsers);
    renderUserStats(APP.allUsers);
  } catch (err) {
    console.error('Error cargando usuarios:', err);
    APP.allUsers = [];
    if (tbody) {
      const isTimeout = err.message?.includes('Tiempo de espera');
      tbody.innerHTML = `<tr class="empty-row"><td colspan="12">
        <span style="color:var(--danger)">
          ${isTimeout ? '⏱ La consulta tardó demasiado.' : '⚠️ ' + esc(err.message || 'Error al cargar usuarios.')}
        </span>
        <button class="text-btn" style="margin-left:10px" onclick="loadUsers()">Reintentar</button>
      </td></tr>`;
    }
  }
}

async function loadAuditLogs() {
  try {
    if (!isAdmin()) return; // Solo administradores

    if (DEMO_MODE) {
      APP.auditLogs = [];
      renderAuditTable([]);
      renderAuditStats([]);
      return;
    }

    const { data, error } = await withTimeout(
      getSupabase()
        .from('auditoria')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500),    // Máximo 500 entradas de auditoría por consulta
      15000, 'cargar auditoría'
    );
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

  const requiredFields = ['nombre','cedula','telefono','provincia','zona','sector','mesa','recinto'];
  for (const f of requiredFields) {
    if (!payload[f]) return showStatusMsg('voterMessage', 'error', 'Complete todos los campos obligatorios.');
  }

  setSubmitLoading('voterForm', true);
  try {
    if (editId) {
      // Editar
      const { error: updateErr } = await getSupabase().from('registros').update(payload).eq('id', editId);
      if (updateErr) {
        if (updateErr.code === '42501' || updateErr.message?.includes('policy')) {
          throw new Error('Sin permisos para editar este registro (RLS).');
        }
        throw updateErr;
      }
      showStatusMsg('voterMessage', 'success', 'Registro actualizado correctamente.');
      showNotif('success', 'Registro actualizado', payload.nombre);
      await logAudit('VOTER_EDIT', editId, `Registro ${payload.nombre} (${payload.cedula}) editado`);
      cancelEditVoter();
    } else {
      // Verificar duplicado
      const { data: dup } = await getSupabase()
        .from('registros')
        .select('id, registrado_por_nombre')
        .eq('cedula', payload.cedula)
        .maybeSingle();
      if (dup) {
        await logAudit('VOTER_DUPLICATE', dup.id, `Intento de duplicado: ${payload.cedula}`);
        showDuplicateModal(payload.nombre, dup.registrado_por_nombre);
        return;
      }
      payload.created_at = new Date().toISOString();
      const { error: insertErr } = await getSupabase().from('registros').insert(payload);
      if (insertErr) {
        // Mensaje específico según tipo de error
        if (insertErr.code === '42501' || insertErr.message?.includes('policy')) {
          throw new Error('Sin permisos para guardar registros. Contacte al administrador (RLS).');
        }
        throw insertErr;
      }
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
    distrito:        document.getElementById('editUserDistrito').value.trim(),
    zona:            document.getElementById('editUserZone').value.trim(),
  };

  // Validaciones básicas
  if (!payload.nombre_completo) return showStatusMsg('userEditMessage', 'error', 'El nombre no puede estar vacío.');
  if (!payload.username)        return showStatusMsg('userEditMessage', 'error', 'El usuario no puede estar vacío.');
  if (!payload.rol)             return showStatusMsg('userEditMessage', 'error', 'Debe seleccionar un rol.');

  const saveBtn = e.target.querySelector('button[type="submit"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner"></span> Guardando…'; }

  try {
    const { error } = await withTimeout(
      getSupabase().from('usuarios').update(payload).eq('id', id),
      12000, 'actualizar usuario'
    );
    if (error) throw error;

    showStatusMsg('userEditMessage', 'success', '✓ Usuario actualizado correctamente.');
    showNotif('success', 'Usuario actualizado', payload.nombre_completo);
    await logAudit('USER_EDIT', id, `Usuario ${payload.username} editado`);
    await loadUsers();
    setTimeout(() => closeModal('userEditModal'), 1400);
  } catch (err) {
    const msg = err.message?.includes('duplicate') || err.message?.includes('unique')
      ? 'El usuario o correo ya existe en el sistema.'
      : (err.message || 'No se pudo actualizar el usuario.');
    showStatusMsg('userEditMessage', 'error', msg);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Guardar cambios`;
    }
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

async function toggleUserStatus(userId, currentStatus, userName, authUserId) {
  if (!isAdmin()) return;
  // Si está aprobado → rechazar = borrar completamente
  // Si está pendiente/rechazado → aprobar
  if (currentStatus === 'aprobado') {
    if (!confirm(`¿Rechazar y ELIMINAR al usuario "${userName}"?\n\nEsta acción borrará su cuenta completamente y no se puede deshacer.`)) return;
    await _deleteUserCompletely(userId, authUserId, userName, 'USER_REJECT');
  } else {
    if (!confirm(`¿Aprobar al usuario "${userName}"?\n\nTendrá acceso completo al sistema según su rol.`)) return;
    try {
      const { error } = await withTimeout(
        getSupabase().from('usuarios').update({ estado: 'aprobado' }).eq('id', userId),
        12000, 'aprobar usuario'
      );
      if (error) throw error;
      showNotif('success', 'Usuario aprobado ✓', userName);
      await logAudit('USER_APPROVE', userId, `${userName} → aprobado`);
      await loadUsers();
    } catch (err) {
      showNotif('error', 'Error al aprobar', err.message || 'No se pudo aprobar el usuario.');
    }
  }
}

async function _deleteUserCompletely(userId, authUserId, userName, auditAction) {
  try {
    // 1. Borrar perfil de la tabla usuarios
    const { error: delErr } = await withTimeout(
      getSupabase().from('usuarios').delete().eq('id', userId),
      12000, 'eliminar perfil'
    );
    if (delErr) throw delErr;

    // Borrar de Auth via RPC (opcional)
    try {
      await withTimeout(
        getSupabase().rpc('delete_auth_user', { p_auth_user_id: authUserId }),
        10000, 'eliminar cuenta auth'
      );
    } catch (_) {
      // RPC opcional — perfil ya fue borrado; correo queda libre en auth
    }

    showNotif('warning', 'Usuario eliminado', userName);
    await logAudit(auditAction || 'USER_DELETE', userId, `${userName} eliminado completamente`);
    await loadUsers();
  } catch (err) {
    showNotif('error', 'Error al eliminar', err.message || 'No se pudo eliminar el usuario.');
  }
}

async function deleteUser(userId, userName, authUserId) {
  if (!isAdmin()) return;
  if (!confirm(`¿Eliminar al usuario "${userName}" permanentemente? Se borrará su cuenta y podrá registrarse de nuevo.`)) return;
  await _deleteUserCompletely(userId, authUserId, userName, 'USER_DELETE');
}

/* ══════════════════════════════════════════════════════════
   RENDERIZADO — TABLAS
══════════════════════════════════════════════════════════ */
function renderVotersTable(voters) {
  const tbody = document.getElementById('votersTableBody');
  if (!tbody) return;

  const page  = APP.votersPage;
  const size  = APP.VOTERS_PAGE_SIZE;
  const total = voters.length;
  const slice = voters.slice((page - 1) * size, page * size);

  if (!slice.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="15">No hay registros para mostrar.</td></tr>`;
    renderVotersPagination(total);
    return;
  }
  const canEdit = isCoordOrAbove() || isAdmin();
  tbody.innerHTML = slice.map(v => `
    <tr>
      <td><strong>${esc(v.nombre)}</strong></td>
      <td>${esc(v.cedula)}</td>
      <td>${esc(v.telefono)}</td>
      <td>${esc(v.region)}</td>
      <td>${esc(v.provincia)}</td>
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

  renderVotersPagination(total);
}

/* ── Paginación de la tabla de registros ────────────────────────── */
function renderVotersPagination(total) {
  // Crear/obtener el contenedor de paginación
  let container = document.getElementById('votersPagination');
  if (!container) {
    const tableCard = document.querySelector('#panelConsulta .table-card, #panelConsulta .card');
    if (!tableCard) return;
    container = document.createElement('div');
    container.id = 'votersPagination';
    container.className = 'audit-pagination voters-pagination';
    tableCard.appendChild(container);
  }

  const size  = APP.VOTERS_PAGE_SIZE;
  const pages = Math.ceil(total / size);

  container.innerHTML = '';

  if (pages <= 1) return;

  // Info de página actual
  const info = document.createElement('span');
  info.className = 'page-info';
  const from = (APP.votersPage - 1) * size + 1;
  const to   = Math.min(APP.votersPage * size, total);
  info.textContent = `${from}–${to} de ${total}`;
  container.appendChild(info);

  // Botón Anterior
  const prev = document.createElement('button');
  prev.className = 'page-btn';
  prev.textContent = '‹ Anterior';
  prev.disabled = APP.votersPage === 1;
  prev.addEventListener('click', () => {
    if (APP.votersPage > 1) { APP.votersPage--; renderVotersTable(APP.filteredVoters); container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  container.appendChild(prev);

  // Botones de página (con ellipsis)
  for (let i = 1; i <= pages; i++) {
    const gap = Math.abs(i - APP.votersPage);
    if (pages > 8 && gap > 2 && i !== 1 && i !== pages) {
      if (i === 2 || i === pages - 1) {
        const dot = document.createElement('span');
        dot.textContent = '…';
        dot.style.cssText = 'padding: 0 4px; color: var(--text-muted); line-height: 32px;';
        container.appendChild(dot);
      }
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `page-btn${i === APP.votersPage ? ' active' : ''}`;
    btn.textContent = i;
    btn.addEventListener('click', () => { APP.votersPage = i; renderVotersTable(APP.filteredVoters); container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    container.appendChild(btn);
  }

  // Botón Siguiente
  const next = document.createElement('button');
  next.className = 'page-btn';
  next.textContent = 'Siguiente ›';
  next.disabled = APP.votersPage === pages;
  next.addEventListener('click', () => {
    if (APP.votersPage < pages) { APP.votersPage++; renderVotersTable(APP.filteredVoters); container.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
  container.appendChild(next);
}

/* ── Clase CSS según el rol del usuario ─────────────────────────── */
function getUserRoleClass(role) {
  const map = {
    'Administrador': 'role-admin',
    'Coordinador':   'role-coord',
    'Supervisor':    'role-super',
    'Registrador':   'role-reg',
    'Observador':    'role-obs',
  };
  return map[role] || 'role-obs';
}

/* ── Contador de usuarios por estado ────────────────────────────── */
function renderUserStats(users) {
  const container = document.getElementById('userStatsBar');
  if (!container) return;
  const total    = users.length;
  const approved = users.filter(u => u.estado === 'aprobado').length;
  const pending  = users.filter(u => u.estado === 'pendiente').length;
  const rejected = users.filter(u => u.estado === 'rechazado').length;
  container.innerHTML = `
    <span class="user-stat-chip chip-total">${total} usuario${total !== 1 ? 's' : ''}</span>
    <span class="user-stat-chip chip-approved">${approved} aprobado${approved !== 1 ? 's' : ''}</span>
    ${pending  ? `<span class="user-stat-chip chip-pending">${pending} pendiente${pending !== 1 ? 's' : ''}</span>` : ''}
    ${rejected ? `<span class="user-stat-chip chip-rejected">${rejected} rechazado${rejected !== 1 ? 's' : ''}</span>` : ''}
  `;
}

/* ── Filtro de usuarios (client-side) ───────────────────────────── */
function filterUsers() {
  const search = (document.getElementById('usersSearch')?.value || '').toLowerCase();
  const role   = document.getElementById('usersFilterRole')?.value  || '';
  const estado = document.getElementById('usersFilterEstado')?.value || '';

  const filtered = APP.allUsers.filter(u => {
    const text = [u.nombre_completo, u.username, u.email, u.provincia, u.zona].join(' ').toLowerCase();
    return (
      (!search || text.includes(search)) &&
      (!role   || u.rol    === role) &&
      (!estado || u.estado === estado)
    );
  });
  renderUsersTable(filtered);
  renderUserStats(filtered);
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="12">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      No hay usuarios para mostrar.
    </td></tr>`;
    return;
  }
  const canManage = isAdmin();
  tbody.innerHTML = users.map(u => {
    const isMe     = u.auth_user_id === APP.currentUser?.id;
    const isPending = u.estado === 'pendiente';
    const isRejected = u.estado === 'rechazado';
    const rowClass = isPending ? ' class="user-row-pending"' : isRejected ? ' class="user-row-rejected"' : '';
    return `
    <tr${rowClass}>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="user-avatar-mini">${(u.nombre_completo || u.username || '?').charAt(0).toUpperCase()}</div>
          <strong>${esc(u.nombre_completo)}</strong>
          ${isMe ? '<span class="badge" style="font-size:0.65rem;padding:1px 6px">Tú</span>' : ''}
        </div>
      </td>
      <td>${esc(u.username)}</td>
      <td style="font-size:0.8rem">${esc(u.email)}</td>
      <td><span class="status-badge ${getUserRoleClass(u.rol)}">${esc(u.rol)}</span></td>
      <td>${esc(u.telefono || '—')}</td>
      <td>${esc(u.region || '—')}</td>
      <td>${esc(u.provincia || '—')}</td>
      <td>${esc(u.distrito || '—')}</td>
      <td>${esc(u.zona || '—')}</td>
      <td><span class="status-badge ${u.estado === 'aprobado' ? 'status-approved' : u.estado === 'pendiente' ? 'status-pending' : 'status-rejected'}">${u.estado || '—'}</span></td>
      <td>
        <div class="td-actions">
          <button class="icon-btn edit-btn" onclick="openEditUser(${JSON.stringify(u).replace(/"/g, '&quot;')})" title="Editar usuario">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${canManage && !isMe ? `
          <button class="icon-btn ${u.estado === 'aprobado' ? 'delete-btn' : 'approve-btn'}"
            onclick="toggleUserStatus('${u.id}','${u.estado}','${esc(u.nombre_completo)}','${u.auth_user_id || ''}')"
            title="${u.estado === 'aprobado' ? 'Rechazar / Eliminar' : 'Aprobar usuario'}">
            ${u.estado === 'aprobado'
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
            }
          </button>
          <button class="icon-btn delete-btn" onclick="deleteUser('${u.id}','${esc(u.nombre_completo)}','${u.auth_user_id || ''}')" title="Eliminar permanentemente">
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
    filterSector:    v => v.sector,
    filterMesa:      v => v.mesa,
    filterRegistrar: v => v.registrado_por_nombre,
  };
  Object.entries(fields).forEach(([selId, getter]) => {
    const el = document.getElementById(selId);
    if (!el) return;
    const prev = el.value;
    const vals = [...new Set(voters.map(getter).filter(Boolean))].sort();
    const allLabel = selId === 'filterMesa' ? 'Todas' : 'Todos';
    el.innerHTML = `<option value="">${allLabel}</option>`;
    vals.forEach(v => el.innerHTML += `<option value="${v}">${v}</option>`);
    if (vals.includes(prev)) el.value = prev;
  });
}

function applyFilters() {
  const search    = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const province  = document.getElementById('filterProvince')?.value  || '';
  const sector    = document.getElementById('filterSector')?.value    || '';
  const mesa      = document.getElementById('filterMesa')?.value      || '';
  const role      = document.getElementById('filterRole')?.value      || '';
  const registrar = document.getElementById('filterRegistrar')?.value || '';

  APP.filteredVoters = APP.allVoters.filter(v => {
    const text = [v.nombre, v.cedula, v.telefono, v.zona, v.recinto, v.sector, v.mesa].join(' ').toLowerCase();
    return (
      (!search    || text.includes(search)) &&
      (!province  || v.provincia === province) &&
      (!sector    || v.sector === sector) &&
      (!mesa      || v.mesa === mesa) &&
      (!role      || v.registrado_por_rol === role) &&
      (!registrar || v.registrado_por_nombre === registrar)
    );
  });
  APP.votersPage = 1; // Volver a primera página al filtrar
  renderVotersTable(APP.filteredVoters);
  updateFilterBadge(APP.filteredVoters.length);
}

function clearFilters() {
  ['searchInput','filterProvince','filterSector','filterMesa','filterRole','filterRegistrar']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  APP.filteredVoters = [...APP.allVoters];
  APP.votersPage = 1; // Volver a primera página al limpiar
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
  ws['!cols'] = [
    { wch: 32 }, // Nombre
    { wch: 14 }, // Cédula
    { wch: 16 }, // Teléfono
    { wch: 14 }, // Región
    { wch: 20 }, // Municipio
    { wch: 18 }, // Distrito
    { wch: 14 }, // Zona
    { wch: 18 }, // Sector
    { wch: 8  }, // Mesa
    { wch: 22 }, // Recinto
    { wch: 30 }, // Observación
    { wch: 24 }, // Registrado por
    { wch: 16 }, // Rol registrador
    { wch: 16 }, // Fecha
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
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
  ws['!cols'] = [
    { wch: 20 }, // Fecha/Hora
    { wch: 28 }, // Actor
    { wch: 16 }, // Rol
    { wch: 20 }, // Acción
    { wch: 18 }, // Objetivo
    { wch: 50 }, // Detalles
  ];
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws, 'Auditoría');
  XLSX.writeFile(wb, `Peravia_Auditoria_${new Date().toISOString().substring(0,10)}.xlsx`);
  logAudit('AUDIT_EXPORT', null, `Exportación de auditoría: ${data.length} registros`);
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
  document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('usersSection')?.classList.add('section-hidden');
  document.getElementById('panelAudit')?.classList.add('section-hidden');

  document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); b.removeAttribute('aria-current'); });
  document.querySelectorAll(`[data-panel="${panelId}"]`).forEach(b => { b.classList.add('active'); b.setAttribute('aria-current', 'page'); });

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
      if (!isAdmin()) { activatePanel('overview'); return; }
      document.getElementById('usersSection')?.classList.remove('section-hidden');
      break;
    case 'auditoria':
      if (!isAdmin()) { activatePanel('overview'); return; }
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

  if (loading) {
    // Guardar HTML original solo si no está ya en loading
    if (!btn.dataset.originalHtml) {
      btn.dataset.originalHtml = btn.innerHTML;
    }
    btn.disabled = true;
    btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px"><span class="spinner"></span> Procesando…</span>';
  } else {
    btn.disabled = false;
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml; // Limpiar para próxima vez
    }
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
    'tiempo de espera agotado': 'El servidor tardó en responder. Inténtelo de nuevo.',
    'fetch failed': 'Sin conexión. Verifique su internet e inténtelo de nuevo.',
    'networkerror': 'Sin conexión. Verifique su internet e inténtelo de nuevo.',
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
  document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
  document.getElementById('registerForm')?.addEventListener('submit', handleRegister);
  document.getElementById('forgotForm')?.addEventListener('submit', handleForgotPassword);
  document.getElementById('resetForm')?.addEventListener('submit', handleResetPassword);

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

  document.getElementById('forgotPasswordBtn')?.addEventListener('click', () => showModal('forgotPasswordModal'));
  document.getElementById('closeForgotModalBtn')?.addEventListener('click', () => closeModal('forgotPasswordModal'));
  document.getElementById('cancelForgotBtn')?.addEventListener('click', () => closeModal('forgotPasswordModal'));

  document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
  document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);
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

  document.querySelectorAll('.nav-group-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const target = document.getElementById(hdr.dataset.target);
      if (!target) return;
      hdr.classList.toggle('open');
      target.classList.toggle('collapsed');
    });
    hdr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hdr.click(); } });
  });

  document.getElementById('voterForm')?.addEventListener('submit', handleVoterSubmit);
  document.getElementById('cancelEditVoterBtn')?.addEventListener('click', cancelEditVoter);
  document.getElementById('userEditForm')?.addEventListener('submit', handleUserEdit);
  document.getElementById('closeUserEditModalBtn')?.addEventListener('click', () => closeModal('userEditModal'));
  document.getElementById('cancelUserEditBtn')?.addEventListener('click', () => closeModal('userEditModal'));

  ['usersSearch','usersFilterRole','usersFilterEstado'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', filterUsers);
  });
  document.getElementById('usersRefreshBtn')?.addEventListener('click', () => {
    loadUsers();
    ['usersSearch','usersFilterRole','usersFilterEstado'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  document.getElementById('closeDupVoterBtn')?.addEventListener('click', () => closeModal('duplicateVoterModal'));

  const filterIds = ['searchInput','filterProvince','filterSector','filterMesa','filterRole','filterRegistrar'];
  filterIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', applyFilters);
  });
  document.getElementById('clearFiltersBtn')?.addEventListener('click', clearFilters);

  document.getElementById('topbarSearchInput')?.addEventListener('input', e => handleTopbarSearch(e.target.value));

  ['auditSearch','auditFilterAction','auditFilterActor','auditFilterFrom','auditFilterTo'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      APP.auditPage = 1;
      renderAuditTable(getFilteredAuditLogs());
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => closeModal(m.id));
    }
  });

  // Modal Mi Perfil
  const sidebarUserBox = document.getElementById('sidebarUserBox');
  if (sidebarUserBox) {
    sidebarUserBox.addEventListener('click', openProfileModal);
    sidebarUserBox.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfileModal(); }
    });
  }

  document.getElementById('closeProfileModalBtn')?.addEventListener('click', () => closeModal('profileModal'));
  document.getElementById('profilePhotoInput')?.addEventListener('change', handlePhotoUpload);
  document.getElementById('removePhotoBtn')?.addEventListener('click', removeProfilePhoto);
  document.getElementById('profileForm')?.addEventListener('submit', handleProfileUpdate);
}

/* ══════════════════════════════════════════════════════════
   EXPONER FUNCIONES GLOBALES (usadas en onclick del HTML)
══════════════════════════════════════════════════════════ */
window.editVoter          = editVoter;
window.deleteVoter        = deleteVoter;
window.openEditUser       = openEditUser;
window.toggleUserStatus   = toggleUserStatus;
window.deleteUser         = deleteUser;
window.removeProfilePhoto = removeProfilePhoto;
window.loadUsers          = loadUsers;
window.openProfileModal   = openProfileModal;
window.openProfileModal   = openProfileModal;