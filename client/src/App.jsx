import { useEffect, useState } from "react";
import Dashboard from "./Dashboard";
import Reports from "./Reports";
import POS from "./POS";
import useAuth from "./hooks/useAuth";
import { apiUrl } from "./api";
import AccountManagement from "./AccountManagement";
import "./mobile.css";

function NavIcon({ kind }) {
  if (kind === "dashboard") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4 12.8 12 5l8 7.8V20H4v-7.2Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M9 20v-4h6v4" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "pos") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="4" y="5" width="16" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M8 9h8M8 13h3" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "products") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4 8 12 4l8 4-8 4-8-4Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M4 12l8 4 8-4M4 16l8 4 8-4" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "inventory") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M5 6h14v12H5z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M8 10h8M8 14h8" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "deliveries") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M3 7h11v10H3zM14 10h4l3 3v4h-7z" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="8" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="18" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "sales") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M5 19V9M12 19V5M19 19v-7" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "reports") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M6 4h9l3 3v13H6z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M9 11h6M9 15h6" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  if (kind === "users") {
    return (
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.7" />
        <path d="M4 19a5 5 0 0 1 10 0" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="17" cy="10" r="2" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 9v6M9 12h6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function App() {
  const [status, setStatus] = useState("Loading...");
  const { token, setToken, role, setRole, vendorId, setVendorId, username, setUsername, profilePicture, setProfilePicture, clear } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState("dashboard");
  const [transitionDirection, setTransitionDirection] = useState("forward");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarHoverExpanded, setSidebarHoverExpanded] = useState(false);
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus("Unable to reach backend"));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token || !sidebarOpen || window.innerWidth > 980) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };

    document.addEventListener("keydown", closeOnEscape);
    document.body.classList.add("sidebar-scroll-locked");

    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.classList.remove("sidebar-scroll-locked");
    };
  }, [token, sidebarOpen]);

  useEffect(() => {
    if (!token) return undefined;

    let active = true;
    fetch(apiUrl("/api/dashboard"), {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (active && res.status === 401) {
          clear();
          setError("Your session expired. Please sign in again.");
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const loadCurrentUser = () => fetch(apiUrl("/api/users/me"), { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (body?.data) {
          setUsername(body.data.username || body.data.email || "");
          setProfilePicture(body.data.profile_picture || "");
        }
      })
      .catch(() => {});
    loadCurrentUser();
    window.addEventListener("accountUpdated", loadCurrentUser);
    return () => window.removeEventListener("accountUpdated", loadCurrentUser);
  }, [token]);

  const login = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Login failed");
        return;
      }
      const authToken = body.data.token;
      // save token and role/vendor info via useAuth setters
      setToken(authToken);
      setRole(body.data.role || "");
      setVendorId(body.data.vendor_id || null);
      setUsername(body.data.username || body.data.email || "");
      setProfilePicture(body.data.profile_picture || "");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError("Unable to authenticate");
    }
  };

  const logout = () => {
    if (!window.confirm("Are you sure you want to log out?")) {
      return;
    }
    clear();
    setError(null);
  };

  const navigate = (nextView) => {
    const orderedViews = [
      "dashboard",
      ...(role !== "VENDOR" ? ["pos"] : []),
      "deliveries",
      ...(role !== "VENDOR" ? ["sales-history"] : []),
      "inventory",
      ...((role === "SUPERADMIN" || role === "ADMIN" || role === "STAFF") ? ["products"] : []),
      "reports",
      ...(role === "SUPERADMIN" ? ["users"] : []),
    ];

    const currentIndex = orderedViews.indexOf(view);
    const nextIndex = orderedViews.indexOf(nextView);

    if (currentIndex !== -1 && nextIndex !== -1 && nextIndex < currentIndex) {
      setTransitionDirection("backward");
    } else {
      setTransitionDirection("forward");
    }

    setView(nextView);
    setSidebarOpen(false);
  };

  const navItems = [
    { id: "dashboard", label: "Dashboard", description: "Overview and management", icon: "dashboard", view: "dashboard" },
    ...(role !== "VENDOR" ? [{ id: "pos", label: "POS", description: "Sales entry and pickup recording", icon: "pos", view: "pos" }] : []),
    { id: "deliveries", label: "Vendor Deliveries", description: "Pickup list and vendor returns", icon: "deliveries", view: "deliveries" },
    ...(role !== "VENDOR" ? [{ id: "sales-history", label: "Sales History", description: "Recorded POS sales (view-only)", icon: "sales", view: "sales-history" }] : []),
    { id: "inventory", label: "Inventory", description: "Stock movement", icon: "inventory", view: "inventory" },
    ...((role === "SUPERADMIN" || role === "ADMIN" || role === "STAFF") ? [{ id: "products", label: "Products", description: "Product catalog", icon: "products", view: "products" }] : []),
    { id: "reports", label: "Reports", description: "Sales and inventory reports", icon: "reports", view: "reports" },
    ...(role === "SUPERADMIN" ? [{ id: "users", label: "Users", description: "Account management", icon: "users", view: "users" }] : []),
  ];

  const accountName = username || "Account";

  const activeNavId = view;

  const handleNavClick = (item) => {
    if (item.view) {
      navigate(item.view);
      return;
    }
  };

  const toggleSidebarFromHeader = () => {
    if (window.innerWidth <= 980) {
      setSidebarOpen((current) => !current);
      return;
    }
    setSidebarCollapsed((current) => !current);
  };

  const handleSidebarCascade = () => {
    if (window.innerWidth <= 980) {
      setSidebarOpen(false);
      return;
    }
    setSidebarCollapsed((current) => !current);
  };

  const dateLabel = clock.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const timeLabel = clock.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`app-shell ${token ? "app-shell-auth" : "app-shell-guest"}`}>
      {token && (
        <header className="app-header">
          <div className="app-header-brand">
            <div className="app-header-mark">NCSA</div>
            <div>
              <span className="app-header-kicker">New Clarin Sports Arena</span>
              <h1>Sports Arena <em>POS</em></h1>
            </div>
          </div>
        </header>
      )}

      <main>
        {!token ? (
          <section className="login-layout">
            <div className="login-hero">
              <div className="login-hero-overlay" />
              <div className="login-hero-content">
                <div className="login-hero-badge">
                  <span className="login-hero-badge-mark">NCSA</span>
                  <span>Sports Arena</span>
                </div>
                <p className="login-brand-mark">New Clarin Sports Arena</p>
                <h2>
                  NEW CLARIN
                  <br />
                  SPORTS ARENA
                  <span>POS</span>
                </h2>
                <p className="login-hero-subtitle">Beverage inventory system</p>
                <p className="login-hero-copy">A reliable and easy-to-use system for managing beverage inventory, sales, and vendor deliveries in New Clarin Sports Arena.</p>

                <div className="login-stadium-art" aria-hidden="true" />

                <div className="login-feature-grid">
                  <article>
                    <strong>Real-time</strong>
                    <span>Monitoring</span>
                  </article>
                  <article>
                    <strong>Accurate</strong>
                    <span>Records</span>
                  </article>
                  <article>
                    <strong>Inventory</strong>
                    <span>Control</span>
                  </article>
                  <article>
                    <strong>Detailed</strong>
                    <span>Reports</span>
                  </article>
                </div>

              </div>
            </div>

            <div className="login-pane">
              <section className="login-card login-card-modern">
                <header className="login-card-header">
                  <h3>Welcome Back!</h3>
                  <p>Sign in to continue to your account.</p>
                </header>

                <form onSubmit={login} className="login-form login-form-modern">
                  <label>
                    Email Address
                    <span className="field-input-wrap">
                      <span className="field-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M4 7h16v10H4z" stroke="currentColor" strokeWidth="1.7"/>
                          <path d="m4 8 8 6 8-6" stroke="currentColor" strokeWidth="1.7"/>
                        </svg>
                      </span>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Enter email address"
                        autoComplete="email"
                        required
                      />
                    </span>
                  </label>
                  <label>
                    Password
                    <span className="field-input-wrap">
                      <span className="field-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.7"/>
                          <path d="M8 11V8a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.7"/>
                        </svg>
                      </span>
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter your password"
                        autoComplete="current-password"
                        required
                      />
                      <button
                        type="button"
                        className="field-trailing-icon"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword((current) => !current)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M2 12s3.6-5.5 10-5.5S22 12 22 12s-3.6 5.5-10 5.5S2 12 2 12Z" stroke="currentColor" strokeWidth="1.7"/>
                          <circle cx="12" cy="12" r="2.3" stroke="currentColor" strokeWidth="1.7"/>
                        </svg>
                      </button>
                    </span>
                  </label>

                  <div className="login-inline-controls">
                    <label className="remember-row">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                      />
                      <span>Remember me</span>
                    </label>
                    <button type="button" className="link-button" onClick={() => setError("Please contact your administrator to reset your password.")}>Forgot password?</button>
                  </div>

                  <button type="submit" className="login-submit-button">Sign In</button>

                  {error && <p className="error-message">{error}</p>}
                </form>

              </section>
            </div>
          </section>
        ) : (
          <div className={`workspace-shell ${sidebarOpen ? "sidebar-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarHoverExpanded ? "sidebar-hover-expanded" : ""}`}>
            <button
              type="button"
              className="sidebar-backdrop"
              aria-label="Close navigation menu"
              onClick={() => setSidebarOpen(false)}
            />
            <aside
              className="sidebar-shell"
              onMouseEnter={() => {
                if (sidebarCollapsed && window.innerWidth > 980) setSidebarHoverExpanded(true);
              }}
              onMouseLeave={() => setSidebarHoverExpanded(false)}
            >
              <div className="sidebar-brand">
                <div className="sidebar-logo">NCSA</div>
                <div className="sidebar-brand-copy">
                  <strong>New Clarin</strong>
                  <span>Sports Arena POS</span>
                </div>
                <button
                  type="button"
                  className="sidebar-collapse-button"
                  title={window.innerWidth <= 980 ? "Close navigation" : sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-label={window.innerWidth <= 980 ? "Close navigation" : sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  onClick={handleSidebarCascade}
                >
                  <span aria-hidden="true">{window.innerWidth <= 980 ? "×" : sidebarCollapsed ? ">" : "<"}</span>
                </button>
              </div>

              <nav className="sidebar-nav" aria-label="Primary navigation">
                {navItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`sidebar-nav-item ${activeNavId === item.id ? "active" : ""} ${item.view ? "is-link" : "is-muted"}`}
                    onClick={() => handleNavClick(item)}
                    title={item.label}
                    aria-disabled={item.view ? "false" : "true"}
                  >
                    <span className="sidebar-nav-icon">
                      <NavIcon kind={item.icon} />
                    </span>
                    <span className="sidebar-nav-copy">
                      <span>{item.label}</span>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))}
              </nav>

              <div className="sidebar-footer">
                <div className="sidebar-account-card">
                    {profilePicture ? <img className="sidebar-account-avatar-image" src={profilePicture} alt="" /> : <div className="sidebar-account-avatar" aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</div>}
                  <div className="sidebar-account-copy">
                    <strong>{accountName}</strong>
                  </div>
                </div>
                <button className="sidebar-logout-row" onClick={logout}>
                  <span className="sidebar-logout-icon" aria-hidden="true">↳</span>
                  <span>Log out</span>
                </button>
              </div>
            </aside>

            <section className="workspace-content">
              <header className="workspace-header">
                <div className="workspace-heading-group">
                  <button className="workspace-menu-button" type="button" onClick={toggleSidebarFromHeader} aria-label="Toggle sidebar">
                    <span />
                    <span />
                    <span />
                  </button>
                  <div>
                    <h2>{view === "dashboard" ? "Dashboard" : view === "pos" ? "POS" : view === "products" ? "Products" : view === "inventory" ? "Inventory" : view === "deliveries" ? "Vendor Deliveries" : view === "sales-history" ? "Sales History" : view === "users" ? "Account Management" : "Reports"}</h2>
                  </div>
                </div>
                <div className="workspace-meta">
                  <span className="workspace-status workspace-status-date">{dateLabel}</span>
                  <span className="workspace-status workspace-status-time">{timeLabel}</span>
                </div>
              </header>

              <div
                key={view}
                className={`workspace-view-transition ${transitionDirection === "backward" ? "is-backward" : "is-forward"}`}
                aria-live="polite"
              >
                {view === "dashboard" && <Dashboard token={token} role={role} vendorId={vendorId} viewMode="dashboard" />}
                {view === "pos" && <POS token={token} role={role} vendorId={vendorId} viewMode="pos" />}
                {view === "products" && <Dashboard token={token} role={role} vendorId={vendorId} viewMode="products" />}
                {view === "inventory" && <Dashboard token={token} role={role} vendorId={vendorId} viewMode="inventory" />}
                {view === "deliveries" && <POS token={token} role={role} vendorId={vendorId} viewMode="deliveries" />}
                {view === "sales-history" && <POS token={token} role={role} vendorId={vendorId} viewMode="sales-history" />}
                {view === "users" && <AccountManagement token={token} />}
                {view === "reports" && <Reports token={token} role={role} vendorId={vendorId} />}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
