const params = new URLSearchParams(location.search);
const error = document.querySelector('#login-error');
const randomByte = new Uint8Array(1);
crypto.getRandomValues(randomByte);
document.body.dataset.art = String(randomByte[0] % 8);

if (error && (location.pathname === '/auth/login' || params.has('locked') || params.has('error'))) {
  error.textContent = params.has('locked') || location.pathname === '/auth/login'
    ? 'Too many tries. Wait a minute and try again.'
    : 'That access key didn’t match. Try again.';
  error.hidden = false;
  document.querySelector('#password')?.setAttribute('aria-invalid', 'true');
}
