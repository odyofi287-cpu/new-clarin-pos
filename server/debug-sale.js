import app from './app.js';

const srv = app.listen(5001, () => console.log('debug server listening on 5001'));

async function run() {
  try {
    const loginRes = await fetch('http://127.0.0.1:5001/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'staff@clarin.local', password: 'Staff123!' }),
    });
    const loginBody = await loginRes.json();
    console.log('login status', loginRes.status);
    console.log('login body', loginBody);

    const token = loginBody?.data?.token;
    if (!token) {
      throw new Error('No token from login');
    }

    const saleRes = await fetch('http://127.0.0.1:5001/api/sales', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [{ product_id: 1, quantity: 1 }] }),
    });
    const saleBody = await saleRes.json();
    console.log('sale status', saleRes.status);
    console.log('sale body', saleBody);
  } catch (err) {
    console.error('run error', err);
  } finally {
    srv.close();
  }
}

run();
