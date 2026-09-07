const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || (window.location.port === "8010" ? "http://localhost:4000" : "");

export function apiUrl(path) {
  return `${API_ORIGIN}${path}`;
}
