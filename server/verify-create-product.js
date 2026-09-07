const fetch = globalThis.fetch || require('node-fetch');
(async () => {
  try {
    const loginRes = await fetch('http://localhost:4000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@clarin.local', password: 'Admin123!' })
    });
    const loginBody = await loginRes.json();
    console.log('login', loginRes.status, loginBody);
    if (!loginRes.ok) process.exit(1);
    const token = loginBody.data.token;

    const createRes = await fetch('http://localhost:4000/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Test Product From Script', selling_price: 42.5, initial_stock: 10 })
    });
    const createBody = await createRes.json();
    console.log('create', createRes.status, createBody);

    if (createRes.ok) {
      const prodId = createBody.data.id;
      const getRes = await fetch(`http://localhost:4000/api/products/${prodId}`, { headers: { Authorization: `Bearer ${token}` } });
      const getBody = await getRes.json();
      console.log('fetched new product', getRes.status, getBody);
    }
  } catch (err) {
    console.error('error', err);
    process.exit(1);
  }
})();
