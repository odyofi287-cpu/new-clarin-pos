// Backwards-compatible entry point for the legacy role migration command.
// Current migrations preserve Staff accounts and rename Superadmin to Admin.
import "./migrate-superadmin-to-admin.js";
