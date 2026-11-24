// Serverless.call as a promise. The platform sends the init data itself.
export function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    window.Telegram.WebApp.Serverless.call(name, input, (err, result) => (err ? reject(err) : resolve(result)));
  });
}
