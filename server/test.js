import test from "node:test";
import assert from "node:assert";

process.env.NODE_ENV = "test";

const { default: app } = await import("./app.js");
const { getBusinessDate } = await import("./businessDate.js");
const { buildSalesCalendar } = await import("./routes/dashboard.js");
const srv = app.listen(0);
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

test.after(() => new Promise((resolve, reject) => {
  srv.close((error) => error ? reject(error) : resolve());
}));

test("Business date follows the configured Manila operating day", () => {
  assert.strictEqual(getBusinessDate(new Date("2026-09-19T18:00:00.000Z")), "2026-09-20");
});

test("Sales calendar groups Postgres date objects by their Manila calendar date", () => {
  const calendar = buildSalesCalendar(
    [{ sale_date: new Date("2026-09-18T16:00:00.000Z"), total_amount: 1000 }],
    [],
    [],
    "2026-09-20"
  );
  assert.strictEqual(calendar.daily.find((row) => row.period === "2026-09-19")?.recorded_sales, 1000);
  assert.strictEqual(calendar.monthly.find((row) => row.period === "2026-09")?.recorded_sales, 1000);
});

async function login(email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.strictEqual(res.status, 200, `Login failed for ${email}`);
  const body = await res.json();
  return body.data.token;
}

test("Database repairs a missing superadmin seed", async () => {
  const { initDb } = await import("./db.js");
  const db = initDb();
  const records = db.prepare("SELECT email, name, role_id FROM users WHERE email = ?").all("superadmin@clarin.local");
  assert.ok(records.length >= 1, "Expected the initial database seed to include the superadmin account");
  const roles = db.prepare("SELECT name FROM roles WHERE name = ?").all("SUPERADMIN");
  assert.ok(roles.length >= 1, "Expected the initial database seed to include the SUPERADMIN role");
});

test("Admin can login and access deliveries", async () => {
  const token = await login("admin@clarin.local", "Admin123!");
  const res = await fetch(`${base}/api/deliveries`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.data));
  assert(body.data.every((delivery) => /^VND-\d{4}$/.test(delivery.vendor_code)), "Expected deliveries to include the assigned vendor code");
});

test("Staff can login and access deliveries", async () => {
  const token = await login("staff@clarin.local", "Staff123!");
  const res = await fetch(`${base}/api/deliveries`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.data));
});

test("Vendor can login and list only own deliveries", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/deliveries`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.data));
  assert(body.data.every((d) => d.vendor_id === 1));
});

test("Staff can record a vendor pickup", async () => {
  const token = await login("staff@clarin.local", "Staff123!");
  const userRes = await fetch(`${base}/api/users`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(userRes.status, 403, "Staff should not access the user list");

  const productsRes = await fetch(`${base}/api/products?active=1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(productsRes.status, 200);
  const productsBody = await productsRes.json();
  const product = productsBody.data[0];
  assert(product, "Expected at least one product for pickup");

  const beforeRes = await fetch(`${base}/api/products/${product.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await beforeRes.json();
  const beforeStock = Number(beforeBody.data.current_stock || 0);

  const pickupRes = await fetch(`${base}/api/deliveries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      vendor_id: 1,
      pickup_datetime: '2026-08-16T09:30:00',
      items: [{ product_id: product.id, quantity: 4 }],
    })
  });
  assert.strictEqual(pickupRes.status, 201, 'Expected staff to create a vendor pickup');
  const body = await pickupRes.json();
  assert.strictEqual(body.data.vendor_id, 1);
  assert.strictEqual(body.data.total_amount, Number(product.selling_price) * 4);

  const afterRes = await fetch(`${base}/api/products/${product.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await afterRes.json();
  assert.strictEqual(Number(afterBody.data.current_stock), beforeStock - 4, 'Vendor pickup should reduce stock immediately');
});

test("Staff can record and list vendor returns and exclude them from sales totals", async () => {
  const token = await login("staff@clarin.local", "Staff123!");
  const productsRes = await fetch(`${base}/api/products?active=1`, { headers: { Authorization: `Bearer ${token}` } });
  const products = await productsRes.json();
  const product = products.data.find((item) => item.id === 1) || products.data[0];
  assert(product, "Expected a product for return testing");

  const createRes = await fetch(`${base}/api/vendor-returns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      return_date: '2026-08-20',
      return_time: '09:45',
      vendor_id: 1,
      product_id: product.id,
      quantity: 2,
      total_product_price_returned: 70,
    })
  });
  assert.strictEqual(createRes.status, 201, 'Expected vendor return creation to succeed');
  const created = await createRes.json();
  assert.strictEqual(created.data.vendor_id, 1);
  assert.strictEqual(created.data.quantity, 2);

  const listRes = await fetch(`${base}/api/vendor-returns`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(listRes.status, 200);
  const list = await listRes.json();
  assert(Array.isArray(list.data));
  assert(list.data.some((entry) => Number(entry.id) === Number(created.data.id)));

  const salesRes = await fetch(`${base}/api/reports/sales?start_date=2026-08-20&end_date=2026-08-20`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(salesRes.status, 200);
  const sales = await salesRes.json();
  assert(Array.isArray(sales.data));
  const firstSale = sales.data.find((row) => row.transaction_id === 1) || sales.data[0];
  if (firstSale) {
    assert(firstSale.total_amount >= 0, 'Returned product amounts should not inflate sales totals');
  }
});

test("Vendor can view returns but cannot create or delete them", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const listRes = await fetch(`${base}/api/vendor-returns`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(listRes.status, 200);

  const createRes = await fetch(`${base}/api/vendor-returns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ vendor_id: 1, return_date: '2026-08-20', return_time: '09:45', product_id: 1, quantity: 1, total_product_price_returned: 35 }),
  });
  assert.strictEqual(createRes.status, 403);

  const deleteRes = await fetch(`${base}/api/vendor-returns/1`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(deleteRes.status, 403);
});

test("Superadmin can update a pickup after password verification", async () => {
  const token = await login("superadmin@clarin.local", "Superadmin123!");
  const verify = await fetch(`${base}/api/users/verify-superadmin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password: 'Superadmin123!' })
  });
  assert.strictEqual(verify.status, 200);

  const pickup = await fetch(`${base}/api/deliveries/1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(pickup.status, 200);
  const pickupBody = await pickup.json();
  const productId = pickupBody.data.items[0].product_id;
  const quantity = pickupBody.data.items[0].quantity + 1;
  const updateRes = await fetch(`${base}/api/deliveries/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      vendor_id: 1,
      delivery_date: '2026-08-16',
      pickup_datetime: '2026-08-16T10:00:00',
      items: [{ product_id: productId, quantity, unit_cost: 25 }],
    })
  });
  assert.strictEqual(updateRes.status, 200, 'Expected superadmin edit to succeed after verification');
  const updated = await updateRes.json();
  assert.strictEqual(updated.data.vendor_id, 1);
  assert.strictEqual(updated.data.items[0].quantity, quantity);
});

test("Superadmin can delete a pickup after creation", async () => {
  const token = await login("superadmin@clarin.local", "Superadmin123!");
  const productsRes = await fetch(`${base}/api/products?active=1`, { headers: { Authorization: `Bearer ${token}` } });
  const product = (await productsRes.json()).data[0];
  const createRes = await fetch(`${base}/api/deliveries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      vendor_id: 1,
      pickup_datetime: '2026-08-22T11:00:00',
      items: [{ product_id: product.id, quantity: 3, unit_cost: product.selling_price }],
    })
  });
  assert.strictEqual(createRes.status, 201, 'Expected pickup creation to succeed');
  const created = await createRes.json();
  assert.ok(created.data.id, 'Expected create response to include the pickup ID');

  const deleteRes = await fetch(`${base}/api/deliveries/${created.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(deleteRes.status, 200, 'Expected pickup delete to succeed');
  const deletedBody = await deleteRes.json();
  assert.strictEqual(deletedBody.data.deleted, true);
});

test("Vendor cannot access another vendor delivery by ID", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/deliveries/2`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 403);
});

test("Vendor can filter own delivery history by date", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/deliveries?start_date=2020-01-01&end_date=2030-12-31`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.data));
  assert(body.data.every((d) => d.vendor_id === 1));
});

test("Vendor can access own delivery details", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/deliveries/1`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(body.data.vendor_id === 1);
  assert(Array.isArray(body.data.items));
});

test("Vendor cannot modify a delivery record", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/deliveries/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ total_amount: 999 })
  });
  assert.strictEqual(res.status, 403);
});

test("Superadmin can login and manage users", async () => {
  const token = await login("superadmin@clarin.local", "Superadmin123!");

  let res = await fetch(`${base}/api/users`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 200);
  let body = await res.json();
  assert(Array.isArray(body.data));

  const username = `newstaff${Date.now()}`;
  const email = `${username}@clarin.local`;

  res = await fetch(`${base}/api/users/verify-superadmin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ password: 'Superadmin123!' })
  });
  assert.strictEqual(res.status, 200, 'Expected superadmin verification to pass');

  res = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username,
      password: 'NewStaff123!',
      name: 'New Staff',
      role: 'STAFF',
      contact_person: 'Mary Jones',
      contact_number: '09171234567'
    })
  });
  assert.strictEqual(res.status, 201, 'Expected superadmin to create a staff user');
  body = await res.json();
  assert.strictEqual(body.data.email, email);
  assert.strictEqual(body.data.contact_person, 'Mary Jones');
  assert.strictEqual(body.data.contact_number, '09171234567');

  res = await fetch(`${base}/api/users/${body.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 200, 'Expected superadmin to delete a user');
});

test("Superadmin can update managed account information", async () => {
  const token = await login("superadmin@clarin.local", "Superadmin123!");
  const username = `edituser${Date.now()}`;
  const email = `${username}@clarin.local`;

  let res = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username,
      password: 'EditUser123!',
      name: 'Original Name',
      role: 'STAFF',
      contact_person: 'Original Contact',
      contact_number: '09990000000'
    })
  });
  assert.strictEqual(res.status, 201, 'Expected superadmin to create a managed account');
  const created = await res.json();

  res = await fetch(`${base}/api/users/${created.data.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: `${username}-renamed`,
      email: `${username}-renamed@example.com`,
      password: 'ChangedPassword123!',
      name: 'Updated Name',
      role: 'ADMIN',
      contact_person: 'Updated Contact',
      contact_number: '09991112222',
      vendor_id: null
    })
  });

  assert.strictEqual(res.status, 200, 'Expected superadmin to update managed account information');
  const updated = await res.json();
  assert.strictEqual(updated.data.username, `${username}-renamed`);
  assert.strictEqual(updated.data.email, `${username}-renamed@example.com`);
  assert.strictEqual(updated.data.name, 'Updated Name');
  assert.strictEqual(updated.data.role, 'ADMIN');
  assert.strictEqual(updated.data.contact_person, 'Updated Contact');
  assert.strictEqual(updated.data.contact_number, '09991112222');

  const updatedToken = await login(`${username}-renamed`, 'ChangedPassword123!');
  assert.ok(updatedToken, 'Expected updated username and password to authenticate');

  res = await fetch(`${base}/api/users/${created.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 200, 'Expected superadmin to delete the updated user');
});

test("Vendor accounts receive sequential system-assigned vendor records", async () => {
  const token = await login("superadmin@clarin.local", "Superadmin123!");
  const username = `supplier${Date.now()}`;

  let res = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username,
      password: 'Supplier123!',
      name: 'Supplier Account',
      role: 'VENDOR',
      contact_number: '09170000000'
    })
  });
  assert.strictEqual(res.status, 201, 'Expected a vendor account without a selected vendor to create a vendor record');
  const created = await res.json();
  assert.ok(created.data.vendor_id, 'Expected the account to receive a vendor ID');
  assert.match(created.data.vendor_code, /^VND-\d{4}$/);

  res = await fetch(`${base}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: `${username}-invalid`,
      password: 'Supplier123!',
      name: 'Invalid Supplier Account',
      role: 'VENDOR',
      vendor_id: 999999
    })
  });
  assert.strictEqual(res.status, 201, 'Expected vendor assignment input to be ignored for new vendor accounts');
  const secondCreated = await res.json();
  assert.ok(secondCreated.data.vendor_id, 'Expected the second account to receive a vendor ID');
  assert.match(secondCreated.data.vendor_code, /^VND-\d{4}$/);
  assert.notStrictEqual(secondCreated.data.vendor_code, created.data.vendor_code, 'Expected each new vendor account to receive a new vendor code');

  res = await fetch(`${base}/api/users/vendors`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  let vendorList = await res.json();
  assert(vendorList.data.some((vendor) => vendor.vendor_code === created.data.vendor_code));
  assert(vendorList.data.some((vendor) => vendor.vendor_code === secondCreated.data.vendor_code));

  res = await fetch(`${base}/api/users/${created.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 200);

  res = await fetch(`${base}/api/users/${secondCreated.data.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.strictEqual(res.status, 200);

  res = await fetch(`${base}/api/users/vendors`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  vendorList = await res.json();
  assert(!vendorList.data.some((vendor) => vendor.vendor_code === created.data.vendor_code));
  assert(!vendorList.data.some((vendor) => vendor.vendor_code === secondCreated.data.vendor_code));
});

test("Vendor cannot access admin product creation endpoint", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Unauthorized', selling_price: 10 })
  });
  assert.strictEqual(res.status, 403);
});

test("Vendor cannot use staff-only product update", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/products/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Tamper' })
  });
  assert.strictEqual(res.status, 403);
});

test("Vendor cannot modify inventory via stock movement", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/products/1/stock-movements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'STOCK_IN', quantity: 1 })
  });
  assert.strictEqual(res.status, 403);
});

test("Admin dashboard returns operational metrics", async () => {
  const token = await login("admin@clarin.local", "Admin123!");
  const res = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(typeof body.data.todays_total_sales === 'number');
  assert(typeof body.data.todays_total_vendor_returns === 'number');
  assert.strictEqual(body.data.calculated_todays_sales, Number(body.data.todays_total_sales) + Number(body.data.todays_total_deliveries) - Number(body.data.todays_total_vendor_returns));
  assert(typeof body.data.todays_transaction_count === 'number');
  assert(Array.isArray(body.data.recent_sales));
  assert(Array.isArray(body.data.low_stock_products));
  assert.strictEqual(body.data.sales_calendar.daily.length, 31);
  assert.strictEqual(body.data.sales_calendar.monthly.length, 12);
});

test("Staff can view recorded sales history", async () => {
  const token = await login("staff@clarin.local", "Staff123!");
  const res = await fetch(`${base}/api/sales`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(Array.isArray(body.data));
  assert(body.data.length > 0, "Expected recorded sales history");
  assert(body.data.every((sale) => Object.hasOwn(sale, "item_count") && Object.hasOwn(sale, "total_amount")));
});

test("Vendor delivery CSV exports ISO dates", async () => {
  const token = await login("admin@clarin.local", "Admin123!");
  const res = await fetch(`${base}/api/reports/vendor-deliveries/csv?start_date=2026-01-01&end_date=2026-12-31`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200);
  const csv = await res.text();
  assert.match(csv, /Delivery Date/);
  const dateRows = csv.split("\n").slice(1).filter(Boolean);
  assert(dateRows.length > 0, "Expected at least one vendor delivery CSV row");
  assert(dateRows.every((row) => /,\d{4}-\d{2}-\d{2},/.test(row)), "Expected delivery dates in YYYY-MM-DD format");
});

test("Staff can complete a sale and inventory decrements", async () => {
  console.log('SALE_TEST: start');
  const token = await login("staff@clarin.local", "Staff123!");
  console.log('SALE_TEST: token obtained');
  const productList = await fetch(`${base}/api/products`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('SALE_TEST: products status', productList.status);
  assert.strictEqual(productList.status, 200);
  const listBody = await productList.json();
  console.log('SALE_TEST: products count', listBody.data?.length);
  const item = listBody.data.find((p) => p.current_stock > 0);
  console.log('SALE_TEST: selected item', item);
  assert(item, 'Expected at least one in-stock product');

  const initialStock = item.current_stock;
  const saleRes = await fetch(`${base}/api/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ product_id: item.id, quantity: 1 }] })
  });
  console.log('SALE_TEST: sale status', saleRes.status);
  const saleBody = await saleRes.json();
  console.log('SALE_TEST: sale body', saleBody);
  assert.strictEqual(saleRes.status, 201);
  assert(saleBody.data && saleBody.data.sale_id, 'Expected sale_id in response');
  console.log('SALE_TEST: total_amount', saleBody.data.total_amount, 'expected', item.selling_price);
  assert.strictEqual(saleBody.data.total_amount, item.selling_price);

  const productAfter = await fetch(`${base}/api/products/${item.id}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('SALE_TEST: product after status', productAfter.status);
  assert.strictEqual(productAfter.status, 200);
  const afterBody = await productAfter.json();
  console.log('SALE_TEST: afterBody', afterBody.data);
  assert.strictEqual(afterBody.data.current_stock, initialStock - 1);
  console.log('SALE_TEST: completed');
});

test("Vendor dashboard returns vendor-only delivery summary", async () => {
  const token = await login("vendor@clarin.local", "Vendor123!");
  const res = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert(body.data.vendor_summary);
  assert(typeof body.data.vendor_summary.today_delivery_count === 'number');
  assert(Array.isArray(body.data.vendor_summary.recent_deliveries));
});

test("Unauthorized requests are blocked", async () => {
  const res = await fetch(`${base}/api/deliveries`);
  assert.strictEqual(res.status, 401);
});

test("Inventory flows: STOCK_OUT, LOW/OUT flags, STOCK_IN, ADJUSTMENT, and movement history", async () => {
  const admin = await login('admin@clarin.local','Admin123!');

  const ensureProductStock = async (targetStock) => {
    let res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.strictEqual(res.status, 200);
    let body = await res.json();
    const current = Number(body.data.current_stock || 0);
    if (current < targetStock) {
      res = await fetch(`${base}/api/products/1/stock-movements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` },
        body: JSON.stringify({ type: 'STOCK_IN', quantity: targetStock - current })
      });
      assert.strictEqual(res.status, 200, 'Expected stock to be replenished before the inventory flow test');
    }
    return current;
  };

  await ensureProductStock(12);

  let res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.strictEqual(res.status, 200);
  let body = await res.json();
  const initial = Number(body.data.current_stock || 0);
  assert(initial >= 12, `Expected a starting stock of at least 12 but got ${initial}`);

  // STOCK_OUT large amount to reach LOW_STOCK
  res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'STOCK_OUT', quantity: initial - 5 }) });
  assert.strictEqual(res.status, 200);

  res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  body = await res.json();
  assert.strictEqual(body.data.current_stock, 5);
  assert.strictEqual(body.data.status, 'LOW_STOCK');

    // STOCK_OUT to zero
    res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'STOCK_OUT', quantity: 5 }) });
    assert.strictEqual(res.status, 200);

  res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  body = await res.json();
  assert.strictEqual(body.data.current_stock, 0);
  assert.strictEqual(body.data.status, 'OUT_OF_STOCK');

  // STOCK_IN replenishes
  res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'STOCK_IN', quantity: 20 }) });
  assert.strictEqual(res.status, 200);
  res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  body = await res.json();
  assert.strictEqual(body.data.current_stock, 20);
  assert.strictEqual(body.data.status, 'OK');

  // Exactly 10 units is still LOW_STOCK.
  res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'STOCK_OUT', quantity: 10 }) });
  assert.strictEqual(res.status, 200);
  res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  body = await res.json();
  assert.strictEqual(body.data.current_stock, 10);
  assert.strictEqual(body.data.status, 'LOW_STOCK');

  res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'STOCK_IN', quantity: 5 }) });
  assert.strictEqual(res.status, 200);

  // ADJUSTMENT negative
  res = await fetch(`${base}/api/products/1/stock-movements`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ type: 'ADJUSTMENT', delta: -5 }) });
  assert.strictEqual(res.status, 200);
  res = await fetch(`${base}/api/products/1`, { headers: { Authorization: `Bearer ${admin}` } });
  body = await res.json();
  assert.strictEqual(body.data.current_stock, 10);

  // Movement history
  res = await fetch(`${base}/api/products/1/movements`, { headers: { Authorization: `Bearer ${admin}` } });
  assert.strictEqual(res.status, 200);
  body = await res.json();
  assert(Array.isArray(body.data));
  assert(body.data.length > 0);
});

process.on('exit', () => srv.close());
