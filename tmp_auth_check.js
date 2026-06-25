const http = require('http');

function requestJSON(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      },
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

(async () => {
  const signup = await requestJSON('POST', '/api/signup', {
    fullName: 'Verification User',
    email: 'verify@example.com',
    password: 'VerificationPass123!',
  });
  console.log('signup status', signup.statusCode);
  console.log('signup body', signup.body);

  const login = await requestJSON('POST', '/api/login', {
    email: 'verify@example.com',
    password: 'VerificationPass123!',
  });
  console.log('login status', login.statusCode);
  console.log('login body', login.body);
})();
