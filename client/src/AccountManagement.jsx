import { useEffect, useState } from "react";
import { apiUrl } from "./api";

const ROLES = ["SUPERADMIN", "STAFF", "VENDOR"];
const emptyAccount = () => ({
  username: "",
  email: "",
  password: "",
  name: "",
  role: "STAFF",
  vendor_id: null,
  contact_person: "",
  contact_number: "",
  profile_picture: "",
  profile_picture_action: "keep",
});

const PROFILE_PICTURE_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const PROFILE_PICTURE_MAX_STORED_BYTES = 512 * 1024;
const PROFILE_PICTURE_MAX_DIMENSION = 512;
const SUPPORTED_PROFILE_PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function dataUrlByteLength(dataUrl) {
  const encoded = String(dataUrl).split(",", 2)[1] || "";
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

async function prepareProfilePicture(file) {
  if (!SUPPORTED_PROFILE_PICTURE_TYPES.has(file.type)) throw new Error("Choose a JPG, PNG, or WebP image.");
  if (file.size > PROFILE_PICTURE_MAX_INPUT_BYTES) throw new Error("Choose an image smaller than 5 MB.");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error("The selected image could not be read."));
      candidate.src = objectUrl;
    });
    const scale = Math.min(1, PROFILE_PICTURE_MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare the selected image.");
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    if (dataUrlByteLength(dataUrl) > PROFILE_PICTURE_MAX_STORED_BYTES) throw new Error("This image is still too detailed after resizing. Choose a different photo.");
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function AccountFields({ form, isNew, onChange, onProfilePictureChange, onRemoveProfilePicture, processingProfilePicture, profilePictureError }) {
  return (
    <div className="account-form-grid">
      <label>Username<input value={form.username} onChange={(event) => onChange("username", event.target.value)} required /></label>
      <label>Email address<input type="email" value={form.email} onChange={(event) => onChange("email", event.target.value)} required /></label>
      <label>{isNew ? "Password" : "New password"}<input type="password" value={form.password} onChange={(event) => onChange("password", event.target.value)} placeholder={isNew ? "Enter password" : "Leave blank to keep current password"} required={isNew} /></label>
      <label>Full name<input value={form.name} onChange={(event) => onChange("name", event.target.value)} required /></label>
      <div className="account-profile-picture-field">
        <span className="account-field-label">Profile picture</span>
        <div className="account-profile-picture-preview">
          {form.profile_picture ? <img src={form.profile_picture} alt="Profile picture preview" /> : <span aria-hidden="true">{(form.name || form.username || "?").slice(0, 1).toUpperCase()}</span>}
          <div><strong>{form.profile_picture ? "Picture selected" : "No picture selected"}</strong><small>JPG, PNG, or WebP. It is resized to a compact profile image before saving.</small></div>
        </div>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => onProfilePictureChange(event.target.files?.[0])} disabled={processingProfilePicture} aria-describedby="profile-picture-help" />
        <small id="profile-picture-help">Maximum source size: 5 MB. Stored profile images are limited to 512 KB.</small>
        {profilePictureError && <small className="account-profile-picture-error" role="alert">{profilePictureError}</small>}
        {form.profile_picture && <button className="account-remove-picture" type="button" onClick={onRemoveProfilePicture} disabled={processingProfilePicture}>Remove picture</button>}
      </div>
      <label>Role<select value={form.role} onChange={(event) => onChange("role", event.target.value)}>{ROLES.map((role) => <option key={role}>{role}</option>)}</select></label>
      {form.role === "VENDOR" && <label>Vendor ID<input value={isNew ? "Automatically assigned" : form.vendor_code || "Assigned vendor"} readOnly /></label>}
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
  const [processingProfilePicture, setProcessingProfilePicture] = useState(false);
  const [profilePictureError, setProfilePictureError] = useState("");

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
      if (event.key === "Escape" && !loading && !processingProfilePicture) closeModal();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [modalOpen, loading, processingProfilePicture]);

  const closeModal = () => {
    setEditingUser(null);
    setCreating(false);
    setForm(emptyAccount());
    setProfilePictureError("");
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
      vendor_code: user.vendor_code || "",
      profile_picture: user.profile_picture || "",
      profile_picture_action: "keep",
      contact_person: user.contact_person || "",
      contact_number: user.contact_number || "",
    });
  };

  const changeField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value, ...(field === "role" && value !== "VENDOR" ? { vendor_id: null } : {}) }));
  };

  const changeProfilePicture = async (file) => {
    if (!file) return;
    setProcessingProfilePicture(true);
    setProfilePictureError("");
    try {
      const profilePicture = await prepareProfilePicture(file);
      setForm((current) => ({ ...current, profile_picture: profilePicture, profile_picture_action: "replace" }));
    } catch (error) {
      setProfilePictureError(error.message || "Unable to prepare the selected image.");
    } finally {
      setProcessingProfilePicture(false);
    }
  };

  const removeProfilePicture = () => {
    setProfilePictureError("");
    setForm((current) => ({ ...current, profile_picture: "", profile_picture_action: "remove" }));
  };

  const saveAccount = async (event) => {
    event.preventDefault();
    const isNew = creating;
    const { profile_picture_action, vendor_code, ...formValues } = form;
    const payload = {
      ...formValues,
      vendor_id: form.role === "VENDOR" ? form.vendor_id : null,
      contact_person: form.contact_person || null,
      contact_number: form.contact_number || null,
    };
    if (isNew || profile_picture_action === "replace") payload.profile_picture = form.profile_picture || null;
    if (profile_picture_action === "remove") {
      payload.profile_picture = null;
      payload.remove_profile_picture = true;
    }
    if (!isNew && !payload.password) delete payload.password;

    setLoading(true);
    setMessage("");
    setProfilePictureError("");
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
      window.dispatchEvent(new Event("vendorsUpdated"));
      window.dispatchEvent(new Event("accountUpdated"));
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
      window.dispatchEvent(new Event("vendorsUpdated"));
      window.dispatchEvent(new Event("accountUpdated"));
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
          <tbody>{users.map((user) => <tr key={user.id}><td data-label="Username">{user.username || "-"}</td><td data-label="Name">{user.name}</td><td data-label="Email">{user.email}</td><td data-label="Role"><span className="account-role">{user.role}</span></td><td data-label="Vendor ID">{user.vendor_code || "-"}</td><td data-label="Contact">{user.contact_person || user.contact_number || "-"}</td><td data-label="Status">{user.active ? "Active" : "Inactive"}</td><td className="account-actions" data-label="Actions"><button onClick={() => editUser(user)} disabled={loading}>Edit</button><button className="account-delete" onClick={() => deleteUser(user.id)} disabled={loading}>Delete</button></td></tr>)}</tbody>
        </table>
        {!loading && users.length === 0 && <p className="account-empty">No accounts found.</p>}
      </div>

      {modalOpen && <div className="account-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading && !processingProfilePicture) closeModal(); }}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title"><header><div><p>{creating ? "New account" : "Account details"}</p><h2 id="account-modal-title">{creating ? "Create user" : `Edit ${editingUser.name}`}</h2></div><button className="account-close" type="button" aria-label="Close account window" onClick={closeModal} disabled={loading || processingProfilePicture}>×</button></header><form onSubmit={saveAccount}><AccountFields form={form} isNew={creating} onChange={changeField} onProfilePictureChange={changeProfilePicture} onRemoveProfilePicture={removeProfilePicture} processingProfilePicture={processingProfilePicture} profilePictureError={profilePictureError} /><footer><button className="account-cancel" type="button" onClick={closeModal} disabled={loading || processingProfilePicture}>Cancel</button><button className="account-primary" type="submit" disabled={loading || processingProfilePicture}>{loading ? "Saving..." : processingProfilePicture ? "Preparing picture..." : creating ? "Create user" : "Save changes"}</button></footer></form></section></div>}

      <style>{`
        .account-management { color:#25345b; padding:1.75rem; }.account-management-header { align-items:center; display:flex; justify-content:space-between; gap:1rem; margin-bottom:1.25rem; }.account-management h1,.account-modal h2 { color:#20335f; letter-spacing:0; margin:0; }.account-management-header p,.account-modal header p { color:#7b6e99; font-size:.78rem; font-weight:700; letter-spacing:.08em; margin:0 0 .3rem; text-transform:uppercase; }.account-primary { background:linear-gradient(135deg,#fc99c4,#903799); border:0; border-radius:8px; color:#fff; cursor:pointer; font-weight:700; padding:.72rem 1rem; }.account-message { background:#e7f4eb; border-radius:6px; color:#24613b; font-weight:600; margin:0 0 1rem; padding:.75rem 1rem; }.account-table-wrap { background:#fff; border:1px solid #e1d9ed; border-radius:8px; overflow-x:auto; }.account-table { border-collapse:collapse; min-width:850px; width:100%; }.account-table th { background:#faf7fc; color:#6e5b87; font-size:.76rem; letter-spacing:.06em; text-align:left; text-transform:uppercase; }.account-table td,.account-table th { border-bottom:1px solid #eee9f4; padding:.9rem 1rem; }.account-table tr:last-child td { border-bottom:0; }.account-role { color:#8d2d85; font-size:.82rem; font-weight:700; }.account-actions { display:flex; gap:.5rem; }.account-actions button,.account-cancel,.account-close { background:transparent; border:0; border-radius:5px; color:#7a2789; cursor:pointer; font-weight:700; padding:.38rem .45rem; }.account-actions .account-delete { color:#bd2859; }.account-empty { color:#746883; margin:0; padding:1rem; }.account-modal-backdrop { align-items:center; background:rgba(20,11,47,.57); display:flex; inset:0; justify-content:center; padding:1rem; position:fixed; z-index:30; }.account-modal { background:#fff; border:1px solid rgba(255,255,255,.65); border-radius:8px; box-shadow:0 24px 56px rgba(25,11,62,.3); color:#25345b; max-height:calc(100vh - 2rem); overflow:auto; width:min(680px,100%); }.account-modal header { align-items:start; border-bottom:1px solid #eee9f4; display:flex; justify-content:space-between; padding:1.35rem 1.5rem; }.account-close { color:#7b6e99; font-size:1.7rem; line-height:1; }.account-modal form { padding:1.5rem; }.account-form-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }.account-form-grid label { color:#5f5276; display:grid; font-size:.83rem; font-weight:700; gap:.42rem; }.account-form-grid input,.account-form-grid select { border:1px solid #d9d0e7; border-radius:6px; color:#27365c; padding:.64rem .7rem; }.account-form-grid input:focus,.account-form-grid select:focus { border-color:#a837a7; box-shadow:0 0 0 3px rgba(168,55,167,.12); outline:0; }.account-modal footer { border-top:1px solid #eee9f4; display:flex; gap:.75rem; justify-content:flex-end; margin:1.5rem -1.5rem -1.5rem; padding:1rem 1.5rem; }.account-cancel { background:#f1edf5; border-radius:8px; color:#534766; padding:.72rem 1rem; }.account-primary:disabled,.account-actions button:disabled,.account-cancel:disabled,.account-close:disabled { cursor:not-allowed; opacity:.6; }.sr-only { clip:rect(0,0,0,0); clip-path:inset(50%); height:1px; overflow:hidden; position:absolute; white-space:nowrap; width:1px; } @media (max-width:680px) { .account-management { padding:1rem; }.account-management-header { align-items:start; flex-direction:column; }.account-form-grid { grid-template-columns:1fr; }.account-modal { max-height:calc(100vh - 1rem); }.account-modal header,.account-modal form { padding:1rem; }.account-modal footer { margin:1.25rem -1rem -1rem; padding:1rem; } }
        .account-profile-picture-field { color:#5f5276; display:grid; font-size:.83rem; font-weight:700; gap:.42rem; }.account-field-label { font-size:.83rem; font-weight:700; }.account-profile-picture-preview { align-items:center; background:#faf7fc; border:1px solid #e7dff0; border-radius:8px; display:flex; gap:.75rem; min-height:64px; padding:.6rem; }.account-profile-picture-preview img,.account-profile-picture-preview > span { background:linear-gradient(135deg,#fc99c4,#903799); border-radius:50%; color:#fff; flex:0 0 46px; height:46px; object-fit:cover; width:46px; }.account-profile-picture-preview > span { align-items:center; display:flex; font-size:1rem; justify-content:center; }.account-profile-picture-preview strong { color:#3b2f50; display:block; font-size:.82rem; }.account-profile-picture-preview small,.account-profile-picture-field > small { color:#746883; font-size:.72rem; font-weight:500; line-height:1.35; }.account-profile-picture-error { color:#b42358 !important; }.account-remove-picture { background:transparent; border:0; color:#8d2d85; cursor:pointer; font-size:.78rem; font-weight:700; justify-self:start; padding:0; }.account-remove-picture:disabled,.account-profile-picture-field input:disabled { cursor:not-allowed; opacity:.6; }
      `}</style>
    </div>
  );
}
