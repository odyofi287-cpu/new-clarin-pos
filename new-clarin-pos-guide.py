from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors

output_file = "new-clarin-pos-guide.pdf"

def make_paragraph(text, style_name="BodyText"):
    return Paragraph(text, styles[style_name])

styles = getSampleStyleSheet()
styles["Heading1"].fontSize = 18
styles["Heading1"].leading = 22
styles["Heading1"].spaceAfter = 12
styles["Heading2"].fontSize = 14
styles["Heading2"].leading = 18
styles["Heading2"].spaceAfter = 10
styles["BodyText"].fontSize = 11
styles["BodyText"].leading = 14
styles["BodyText"].spaceAfter = 8
if "Bullet" not in styles:
    styles.add(ParagraphStyle(name="Bullet", parent=styles["BodyText"], bulletIndent=12, leftIndent=24, bulletFontSize=10))

story = []

story.append(make_paragraph("New Clarin Sports Arena POS - Application Guide", "Heading1"))
story.append(make_paragraph("This document describes the architecture, features, and user flows of the New Clarin Sports Arena web-based POS application.", "BodyText"))
story.append(Spacer(1, 12))

story.append(make_paragraph("1. Overview", "Heading2"))
story.append(make_paragraph("The app is a full-stack POS system built with an Express backend and a React + Vite frontend. It supports staff and vendor authentication, product inventory management, point-of-sale checkout, dashboard metrics, and exportable reports.", "BodyText"))

story.append(make_paragraph("2. Architecture", "Heading2"))
story.append(make_paragraph("Backend:", "BodyText"))
story.append(make_paragraph("- Node.js + Express server under server/\n- SQLite data persistence using better-sqlite3 in production\n- In-memory test database shim in server/db.js for fast test execution", "Bullet"))
story.append(make_paragraph("Frontend:", "BodyText"))
story.append(make_paragraph("- React application under client/src\n- Vite-based development server\n- Main views: Dashboard, POS, Reports", "Bullet"))
story.append(make_paragraph("Database and data model:", "BodyText"))
story.append(make_paragraph("- Users, roles, vendors, products, deliveries, delivery items, inventory movements, sales, and sale items\n- Core entities are created and seeded for both test and runtime environments", "Bullet"))

story.append(make_paragraph("3. Authentication and Authorization", "Heading2"))
story.append(make_paragraph("Users log in through /api/auth/login using email and password. The backend issues a JWT token valid for 8 hours.", "BodyText"))
story.append(make_paragraph("Roles and access:", "BodyText"))
story.append(make_paragraph("- ADMIN: full access to products, inventory, reports, dashboard, deliveries, and sales.\n- STAFF: full POS and product management access except vendor-specific restrictions.\n- VENDOR: read-only access to deliveries, vendor dashboard, and vendor reports.\n- Authorization is enforced in middleware/auth.js using requireRole() and authMiddleware().", "Bullet"))

story.append(make_paragraph("4. Key Backend API Routes", "Heading2"))

routes = [
    ["Route", "Description"],
    ["POST /api/auth/login", "Authenticate staff or vendor and receive JWT token."],
    ["GET /api/products", "List products with optional search query and stock status."],
    ["POST /api/products", "Create new product with optional initial stock and inventory movement."],
    ["PUT /api/products/:id", "Update product metadata and pricing."],
    ["PATCH /api/products/:id/activate", "Enable or disable a product."],
    ["POST /api/products/:id/stock-movements", "Apply STOCK_IN, STOCK_OUT, or ADJUSTMENT inventory movements."],
    ["POST /api/sales", "Create a POS sale transaction, decrement stock, record sale items, and insert inventory movements."],
    ["GET /api/dashboard", "Load either operational or vendor dashboard metrics."],
    ["GET /api/reports/sales", "Fetch sales report data."],
    ["GET /api/reports/sales/csv", "Export sales report CSV."],
    ["GET /api/reports/inventory", "Fetch inventory report data."],
    ["GET /api/reports/inventory/csv", "Export inventory report CSV."],
    ["GET /api/reports/vendor-deliveries", "Fetch vendor deliveries report."],
    ["GET /api/deliveries", "List deliveries with filtering by date and vendor."],
    ["GET /api/deliveries/:id", "Get delivery details and items."],
    ["GET /api/users/me", "Load current authenticated user profile."],
]

route_table = Table(routes, colWidths=[180, 320])
route_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.black),
    ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
    ("FONTSIZE", (0, 0), (-1, -1), 9),
    ("ALIGN", (0, 0), (-1, -1), "LEFT"),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("LINEBEFORE", (0, 0), (-1, -1), 0.25, colors.grey),
    ("LINEAFTER", (0, 0), (-1, -1), 0.25, colors.grey),
    ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.grey),
    ("BOX", (0, 0), (-1, -1), 0.25, colors.grey),
]))
story.append(route_table)
story.append(Spacer(1, 14))

story.append(make_paragraph("5. POS Flow", "Heading2"))
story.append(make_paragraph("The POS checkout page allows staff to search products, add them to a cart, set quantities, and complete sales.", "BodyText"))
story.append(make_paragraph("Key POS flow steps:", "BodyText"))
story.append(make_paragraph("1. Load products via GET /api/products.\n2. Add items from the product list to the cart.\n3. Adjust item quantity within available stock.\n4. Submit the cart to POST /api/sales.\n5. On success, receive sale_id and total_amount, clear cart, and display transaction confirmation.", "Bullet"))

story.append(make_paragraph("6. Sales Transaction Logic", "Heading2"))
story.append(make_paragraph("On the backend, sales are processed in a transactional wrapper that performs:", "BodyText"))
story.append(make_paragraph("- Validation of cart items and stock availability\n- Computation of total sale amount\n- INSERT into sales table\n- INSERT sale_items rows for each product\n- UPDATE products current_stock by subtracting sale quantity\n- INSERT inventory_movements with movement_type = SALE / STOCK_OUT\n- Return sale_id and total_amount to frontend", "Bullet"))

story.append(make_paragraph("7. Inventory and Stock Management", "Heading2"))
story.append(make_paragraph("Products expose current_stock and minimum_stock. The frontend renders stock status, and backend APIs enforce inventory movements.", "BodyText"))
story.append(make_paragraph("Product status categories:", "BodyText"))
story.append(make_paragraph("- OK: current_stock > minimum_stock\n- LOW_STOCK: current_stock > 0 && current_stock <= minimum_stock\n- OUT_OF_STOCK: current_stock <= 0", "Bullet"))

story.append(make_paragraph("8. Dashboard Features", "Heading2"))
story.append(make_paragraph("Dashboard shows operational metrics for ADMIN/STAFF users and vendor-specific summaries for VENDOR users.", "BodyText"))
story.append(make_paragraph("Operational metrics include:", "BodyText"))
story.append(make_paragraph("- Today's total sales\n- Transaction count\n- Items sold today\n- Total current inventory\n- Low-stock and out-of-stock counts\n- Recent sales list\n- Recent deliveries list\n- Low-stock product table", "Bullet"))
story.append(make_paragraph("Vendor dashboard includes:", "BodyText"))
story.append(make_paragraph("- Today’s delivery count for the vendor\n- Today’s delivery total amount\n- Recent deliveries for the vendor", "Bullet"))

story.append(make_paragraph("9. Reports", "Heading2"))
story.append(make_paragraph("The Reports page supports three report types and CSV export.", "BodyText"))
story.append(make_paragraph("Report types:", "BodyText"))
story.append(make_paragraph("- Sales report: transaction-level sales data with staff, items, quantity, and total.\n- Inventory report: stock-in, stock-out, current stock, minimum stock, and status.\n- Vendor deliveries: filtered delivery summaries for the selected vendor or administrator view.", "Bullet"))
story.append(make_paragraph("CSV export is available for sales and inventory reports via /api/reports/sales/csv and /api/reports/inventory/csv.", "BodyText"))

story.append(make_paragraph("10. Setup and Run Commands", "Heading2"))
story.append(make_paragraph("Backend:", "BodyText"))
story.append(make_paragraph("cd server && npm install\nnpm run dev", "Bullet"))
story.append(make_paragraph("Frontend:", "BodyText"))
story.append(make_paragraph("cd client && npm install\nnpm run dev", "Bullet"))
story.append(make_paragraph("The backend listens by default on port 4000 and exposes /api routes. The frontend uses Vite and proxies API requests to /api.", "BodyText"))

story.append(make_paragraph("11. Test and Seed Data", "Heading2"))
story.append(make_paragraph("The server includes an in-memory test DB for Node tests. In test mode, the database is seeded with roles, users, vendors, products, deliveries, and inventory entries.", "BodyText"))
story.append(make_paragraph("Login credentials for seeded users:", "BodyText"))
story.append(make_paragraph("- ADMIN: admin@clarin.local / Admin123!\n- STAFF: staff@clarin.local / Staff123!\n- VENDOR (Clarin Beverages): vendor@clarin.local / Vendor123!\n- VENDOR (Arena Drinks Supplier): vendor2@clarin.local / Vendor123!", "Bullet"))

story.append(make_paragraph("12. File Structure", "Heading2"))
story.append(make_paragraph("Key files and folders:", "BodyText"))
story.append(make_paragraph("- server/app.js: Express app setup and route mounting\n- server/index.js: server startup script\n- server/db.js: database initialization, schema, and in-memory DB shim\n- server/routes/auth.js: login route\n- server/routes/products.js: product CRUD and stock movements\n- server/routes/sales.js: sale transaction processing\n- server/routes/reports.js: report data and CSV export\n- server/routes/dashboard.js: dashboard metrics\n- client/src/App.jsx: login and view routing\n- client/src/POS.jsx: POS checkout UI\n- client/src/Dashboard.jsx: dashboard UI\n- client/src/Reports.jsx: report UI", "Bullet"))

story.append(make_paragraph("13. Important Notes", "Heading2"))
story.append(make_paragraph("- All authenticated requests require the Authorization header: Bearer <token>.\n- Sale creation uses atomic transactions when supported to keep stock updates and sale records consistent.\n- Inventory movements are recorded for stock changes from sales and manual stock adjustments.", "BodyText"))

story.append(make_paragraph("14. How to Use the App", "Heading2"))
story.append(make_paragraph("This section explains the primary user experience for staff, admins, and vendors when using the web application.", "BodyText"))
story.append(make_paragraph("Staff / Admin workflow:", "BodyText"))
story.append(make_paragraph("1. Open the web client and log in with staff or admin credentials.\n2. Use the Dashboard tab to review sales, inventory, and recent activity.\n3. Navigate to the POS tab to search products, add items to the cart, adjust quantities, and complete a sale.\n4. Use the Reports tab to select either Sales, Inventory, or Vendor Deliveries reports, filter by date range, and export CSVs as needed.\n5. Use the Products API or future management views to create or update products, adjust stock, and monitor low/out-of-stock notifications.", "Bullet"))
story.append(make_paragraph("Vendor workflow:", "BodyText"))
story.append(make_paragraph("1. Log in with vendor credentials.\n2. View the vendor dashboard summary of today’s deliveries and recent delivery activity.\n3. Use the vendor deliveries report to see delivery summaries for your vendor account.\n4. Vendors can review delivery history without changing product inventory or sales records.", "Bullet"))

story.append(PageBreak())
story.append(make_paragraph("Appendix: Important Backend Flows", "Heading2"))
story.append(make_paragraph("Login flow:", "BodyText"))
story.append(make_paragraph("1. User submits email and password to POST /api/auth/login.\n2. Backend verifies credentials against users table and bcrypt when available.\n3. JWT token is returned on success.", "Bullet"))
story.append(make_paragraph("Sale flow:", "BodyText"))
story.append(make_paragraph("1. Frontend builds cart items and POSTS to /api/sales.\n2. Backend validates product availability.\n3. Backend writes sales, sale_items, updates product stock, and records inventory movements.\n4. Backend returns transaction id and total amount.", "Bullet"))
story.append(make_paragraph("Product stock movement flow:", "BodyText"))
story.append(make_paragraph("1. POST /api/products/:id/stock-movements with type STOCK_IN, STOCK_OUT, or ADJUSTMENT.\n2. Backend validates movement type and quantity.\n3. Product current_stock is updated, and inventory_movements row is created.", "Bullet"))

pdf = SimpleDocTemplate(output_file, pagesize=letter, rightMargin=40, leftMargin=40, topMargin=40, bottomMargin=40)
pdf.build(story)
print(f"Generated {output_file}")
