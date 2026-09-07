import { useEffect, useState } from "react";
import { apiUrl } from "./api";

const ROLES = ["SUPERADMIN", "ADMIN", "STAFF", "VENDOR"];
const emptyAccount = () => ({
  username: "",
  email: "",
  password: "",
  name: "",
  role: "STAFF",
  vendor_id: null,
  contact_person: "",
  contact_number: "",
});

function AccountFields({ form, vendors, isNew, onChange }) {
  return (
    <div className="account-form-grid">
      <label>Username<input value={form.username} onChange={(event) => onChange("username", event.target.value)} required /></label>
      <label>Email address<input type="email" value={form.email} onChange={(event) => onChange("email", event.target.value)} required /></label>
      <label>{isNew ? "Password" : "New password"}<input type="password" value={form.password} onChange={(event) => onChange("password", event.target.value)} placeholder={isNew ? "Enter password" : "Leave blank to keep current password"} required={isNew} /></label>
      <label>Full name<input value={form.name} onChange={(event) => onChange("name", event.target.value)} required /></label>
      <label>Role<select value={form.role} onChange={(event) => onChange("role", event.target.value)}>{ROLES.map((role) => <option key={role}>{role}</option>)}</select></label>
      {form.role === "VENDOR" && <label>Vendor ID<select value={form.vendor_id || ""} onChange={(event) => onChange("vendor_id", event.target.value ? Number(event.target.value) : null)}><option value="">No vendor assigned</option>{vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.vendor_code} - {vendor.name}</option>)}</select></label>}
      <label>Contact person<input value={form.contact_person} onChange={(event) => onChange("contact_person", event.target.value)} /></label>
      <label>Contact number<input type="tel" value={form.contact_number} onChange={(event) => onChange("contact_number", event.target.value)} /></label>
    </div>
  );
}

export default function AccountManagement({ token }) {
  const [users, setUsers] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [form, setForm] = useState(emptyAccount());
  const [editingUser, setEditingUser] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const modalOpen = Boolean(editingUser || creating);

  const loadUsers = async () => {
    const response = await fetch(apiUrl("/api/users"), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("Failed to load users");
    const body = await response.json();
    setUsers(body.data || []);
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadUsers(),
      fetch(apiUrl("/api/users/vendors"), { headers: { Authorization: `Bearer ${token}` } })
        .then((response) => response.ok ? response.json() : { data: [] })
        .then((body) => setVendors(body.data || [])),
    ]).catch((error) => setMessage(error.message)).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape" && !loading) closeModal();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [modalOpen, loading]);

  const closeModal = () => {
    setEditingUser(null);
    setCreating(false);
    setForm(emptyAccount());
  };

  const editUser = (user) => {
    setEditingUser(user);
    setForm({
      username: user.username || user.email.split("@")[0],
      email: user.email,
      password: "",
      name: user.name,
      role: user.role,
      vendor_id: user.vendor_id,
      contact_person: user.contact_person || "",
      contact_number: user.contact_number || "",
    });
  };

  const changeField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value, ...(field === "role" && value !== "VENDOR" ? { vendor_id: null } : {}) }));
  };

  const saveAccount = async (event) => {
    event.preventDefault();
    const isNew = creating;
    const payload = {
      ...form,
      vendor_id: form.role === "VENDOR" ? form.vendor_id : null,
      contact_person: form.contact_person || null,
      contact_number: form.contact_number || null,
    };
    if (!isNew && !payload.password) delete payload.password;

    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(isNew ? "/api/users" : `/api/users/${editingUser.id}`), {
        method: isNew ? "POST" : "PUT",
        headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to save account");
      closeModal();
      await loadUsers();
      setMessage(isNew ? "User created successfully" : "User updated successfully");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteUser = async (id) => {
    if (!window.confirm("Delete this user account?")) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(`/api/users/${id}`), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to delete user");
      await loadUsers();
      setMessage("User deleted successfully");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="account-management">
      <div className="account-management-header">
        <div><p>Administration</p><h1>Account Management</h1></div>
        <button className="account-primary" onClick={() => setCreating(true)} disabled={loading}>Create user</button>
      </div>
      {message && <p className="account-message" role="status">{message}</p>}
      <div className="account-table-wrap">
        <table className="account-table">
          <thead><tr><th>Username</th><th>Name</th><th>Email</th><th>Role</th><th>Vendor ID</th><th>Contact</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{users.map((user) => <tr key={user.id}><td>{user.username || "-"}</td><td>{user.name}</td><td>{user.email}</td><td><span className="account-role">{user.role}</span></td><td>{user.vendor_code || "-"}</td><td>{user.contact_person || user.contact_number || "-"}</td><td>{user.active ? "Active" : "Inactive"}</td><td className="account-actions"><button onClick={() => editUser(user)} disabled={loading}>Edit</button><button className="account-delete" onClick={() => deleteUser(user.id)} disabled={loading}>Delete</button></td></tr>)}</tbody>
        </table>
        {!loading && users.length === 0 && <p className="account-empty">No accounts found.</p>}
      </div>

      {modalOpen && <div className="account-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) closeModal(); }}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title"><header><div><p>{creating ? "New account" : "Account details"}</p><h2 id="account-modal-title">{creating ? "Create user" : `Edit ${editingUser.name}`}</h2></div><button className="account-close" type="button" aria-label="Close account window" onClick={closeModal} disabled={loading}>×</button></header><form onSubmit={saveAccount}><AccountFields form={form} vendors={vendors} isNew={creating} onChange={changeField} /><footer><button className="account-cancel" type="button" onClick={closeModal} disabled={loading}>Cancel</button><button className="account-primary" type="submit" disabled={loading}>{loading ? "Saving..." : creating ? "Create user" : "Save changes"}</button></footer></form></section></div>}

      <style>{`
        .account-management { color:#25345b; padding:1.75rem; }.account-management-header { align-items:center; display:flex; justify-content:space-between; gap:1rem; margin-bottom:1.25rem; }.account-management h1,.account-modal h2 { color:#20335f; letter-spacing:0; margin:0; }.account-management-header p,.account-modal header p { color:#7b6e99; font-size:.78rem; font-weight:700; letter-spacing:.08em; margin:0 0 .3rem; text-transform:uppercase; }.account-primary { background:linear-gradient(135deg,#fc99c4,#903799); border:0; border-radius:8px; color:#fff; cursor:pointer; font-weight:700; padding:.72rem 1rem; }.account-message { background:#e7f4eb; border-radius:6px; color:#24613b; font-weight:600; margin:0 0 1rem; padding:.75rem 1rem; }.account-table-wrap { background:#fff; border:1px solid #e1d9ed; border-radius:8px; overflow-x:auto; }.account-table { border-collapse:collapse; min-width:850px; width:100%; }.account-table th { background:#faf7fc; color:#6e5b87; font-size:.76rem; letter-spacing:.06em; text-align:left; text-transform:uppercase; }.account-table td,.account-table th { border-bottom:1px solid #eee9f4; padding:.9rem 1rem; }.account-table tr:last-child td { border-bottom:0; }.account-role { color:#8d2d85; font-size:.82rem; font-weight:700; }.account-actions { display:flex; gap:.5rem; }.account-actions button,.account-cancel,.account-close { background:transparent; border:0; border-radius:5px; color:#7a2789; cursor:pointer; font-weight:700; padding:.38rem .45rem; }.account-actions .account-delete { color:#bd2859; }.account-empty { color:#746883; margin:0; padding:1rem; }.account-modal-backdrop { align-items:center; background:rgba(20,11,47,.57); display:flex; inset:0; justify-content:center; padding:1rem; position:fixed; z-index:30; }.account-modal { background:#fff; border:1px solid rgba(255,255,255,.65); border-radius:8px; box-shadow:0 24px 56px rgba(25,11,62,.3); color:#25345b; max-height:calc(100vh - 2rem); overflow:auto; width:min(680px,100%); }.account-modal header { align-items:start; border-bottom:1px solid #eee9f4; display:flex; justify-content:space-between; padding:1.35rem 1.5rem; }.account-close { color:#7b6e99; font-size:1.7rem; line-height:1; }.account-modal form { padding:1.5rem; }.account-form-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }.account-form-grid label { color:#5f5276; display:grid; font-size:.83rem; font-weight:700; gap:.42rem; }.account-form-grid input,.account-form-grid select { border:1px solid #d9d0e7; border-radius:6px; color:#27365c; padding:.64rem .7rem; }.account-form-grid input:focus,.account-form-grid select:focus { border-color:#a837a7; box-shadow:0 0 0 3px rgba(168,55,167,.12); outline:0; }.account-modal footer { border-top:1px solid #eee9f4; display:flex; gap:.75rem; justify-content:flex-end; margin:1.5rem -1.5rem -1.5rem; padding:1rem 1.5rem; }.account-cancel { background:#f1edf5; border-radius:8px; color:#534766; padding:.72rem 1rem; }.account-primary:disabled,.account-actions button:disabled,.account-cancel:disabled,.account-close:disabled { cursor:not-allowed; opacity:.6; }.sr-only { clip:rect(0,0,0,0); clip-path:inset(50%); height:1px; overflow:hidden; position:absolute; white-space:nowrap; width:1px; } @media (max-width:680px) { .account-management { padding:1rem; }.account-management-header { align-items:start; flex-direction:column; }.account-form-grid { grid-template-columns:1fr; }.account-modal { max-height:calc(100vh - 1rem); }.account-modal header,.account-modal form { padding:1rem; }.account-modal footer { margin:1.25rem -1rem -1rem; padding:1rem; } }
      `}</style>
    </div>
  );
}
