const http = require('http');
const fs = require('fs');
const LOGIN_RESULT = 'c:/xampp/htdocs/VegieTrack/backend/login_result.json';
const TOKEN = fs.readFileSync(LOGIN_RESULT, 'utf8').match(/"token":"([^"]+)"/)[1];

function req(method, url, body) {
  return new Promise((resolve) => {
    const urlWithApi = '/api' + url;
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: urlWithApi,
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
      },
    };
    const reqObj = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });
    reqObj.on('error', (e) => {
      resolve({ status: 0, body: e.message });
    });
    if (body) {
      reqObj.write(JSON.stringify(body));
    }
    reqObj.end();
  });
}

(async () => {
  console.log('--- products list (first 6) ---');
  const p = await req('GET', '/products');
  const products = JSON.parse(p.body);
  console.log(JSON.stringify(Array.isArray(products) ? products.slice(0, 6) : products, null, 2));

  console.log('--- batches for product 1 ---');
  const b = await req('GET', '/products/1/batches');
  console.log(JSON.stringify(b.body, null, 2));

  console.log('--- post spoilage (0.5 kg from batch) ---');
  const batchId = JSON.parse(b.body).find(x => Number(x.quantity) > 0)?.id || 1;
  const s = await req('POST', '/spoiled-products', { product_id: 1, batch_id: batchId, quantity: 0.5, reason: 'Rotting' });
  console.log('status', s.status, JSON.stringify(s.body));

  console.log('--- products after spoilage (product 1) ---');
  const p2 = await req('GET', '/products/1');
  console.log(JSON.stringify(JSON.parse(p2.body), null, 2));

  console.log('--- stock remaining check ---');
  const stock = JSON.parse(p2.body).stock_quantity;
  console.log('product 1 stock after spoilage:', stock, '(expected 20.5 if batch decrement worked)');
})();
