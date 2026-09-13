import { useEffect, useState } from "react";

export default function useAuth() {
  const [token, setToken] = useState(() => window.localStorage.getItem("clarin_token") || "");
  const [role, setRole] = useState(() => window.localStorage.getItem("clarin_role") || "");
  const [vendorId, setVendorId] = useState(() => {
    const v = window.localStorage.getItem("clarin_vendor_id");
    return v === null || v === "" ? null : v;
  });
  const [username, setUsername] = useState(() => window.localStorage.getItem("clarin_username") || "");
  const [profilePicture, setProfilePicture] = useState(() => window.localStorage.getItem("clarin_profile_picture") || "");

  useEffect(() => {
    if (token) window.localStorage.setItem("clarin_token", token);
    else window.localStorage.removeItem("clarin_token");
  }, [token]);

  useEffect(() => {
    if (role) window.localStorage.setItem("clarin_role", role);
    else window.localStorage.removeItem("clarin_role");
  }, [role]);

  useEffect(() => {
    if (vendorId || vendorId === 0) window.localStorage.setItem("clarin_vendor_id", String(vendorId));
    else window.localStorage.removeItem("clarin_vendor_id");
  }, [vendorId]);

  useEffect(() => {
    if (username) window.localStorage.setItem("clarin_username", username);
    else window.localStorage.removeItem("clarin_username");
  }, [username]);

  useEffect(() => {
    if (profilePicture) window.localStorage.setItem("clarin_profile_picture", profilePicture);
    else window.localStorage.removeItem("clarin_profile_picture");
  }, [profilePicture]);

  const clear = () => {
    setToken("");
    setRole("");
    setVendorId(null);
    setUsername("");
    setProfilePicture("");
    window.localStorage.removeItem("clarin_token");
    window.localStorage.removeItem("clarin_role");
    window.localStorage.removeItem("clarin_vendor_id");
    window.localStorage.removeItem("clarin_username");
    window.localStorage.removeItem("clarin_profile_picture");
  };

  return { token, setToken, role, setRole, vendorId, setVendorId, username, setUsername, profilePicture, setProfilePicture, clear };
}
