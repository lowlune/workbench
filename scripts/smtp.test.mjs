import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSmtpInput } from '../server/smtp.mjs';

// readSmtpConfig only needs getSetting; an empty store yields the defaults.
const store = { getSetting: () => null };

test('validateSmtpInput rejects CR/LF in From, EHLO name and user', () => {
  assert.throws(() => validateSmtpInput(store, { from: 'a@example.com\r\nBcc: evil@example.com' }), /line breaks/);
  assert.throws(() => validateSmtpInput(store, { helloName: 'mail.example\r\nMAIL FROM:<x>' }), /line breaks/);
  assert.throws(() => validateSmtpInput(store, { user: 'user\ninjected' }), /line breaks/);
});

test('validateSmtpInput strips surrounding whitespace and keeps safe values', () => {
  const config = validateSmtpInput(store, { from: '  a@example.com  ', helloName: '  mail.example  ', user: '  bob  ' });
  assert.equal(config.from, 'a@example.com');
  assert.equal(config.helloName, 'mail.example');
  assert.equal(config.user, 'bob');
});
