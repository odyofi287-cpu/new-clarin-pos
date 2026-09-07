import { useEffect, useState } from "react";

export default function useAuth() {
  const [token, setToken] = useState(() => window.localStorage.getItem("clarin_token") || "");
  const [role, setRole] = useState(() => window.localStorage.getItem("clarin_role") || "");
  const [vendorId, setVendorId] = useState(() => {
    const v = window.localStorage.getItem("clarin_vendor_id");
    return v === null || v === "" ? null : v;
  });

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

  const clear = () => {
    setToken("");
    setRole("");
    setVendorId(null);
    window.localStorage.removeItem("clarin_token");
    window.localStorage.removeItem("clarin_role");
    window.localStorage.removeItem("clarin_vendor_id");
  };

  return { token, setToken, role, setRole, vendorId, setVendorId, clear };
}
