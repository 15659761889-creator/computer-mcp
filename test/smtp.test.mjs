import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smtpConfig } from '../src/smtp.mjs';

test('SMTP is disabled unless all required variables are configured', () => {
  assert.equal(smtpConfig({}), null);
  assert.equal(smtpConfig({
    WANJI_SMTP_HOST: 'smtp.example.com',
    WANJI_SMTP_USER: 'mailer@example.com',
  }), null);
});

test('SMTP defaults to implicit TLS on port 465 and supports STARTTLS on port 587', () => {
  const implicit = smtpConfig({
    WANJI_SMTP_HOST: 'smtp.example.com',
    WANJI_SMTP_USER: 'mailer@example.com',
    WANJI_SMTP_PASSWORD: 'local-test-password',
  });
  assert.deepEqual(implicit, {
    host: 'smtp.example.com', port: 465, user: 'mailer@example.com',
    password: 'local-test-password', from: 'mailer@example.com', secure: true,
  });

  const startTls = smtpConfig({
    WANJI_SMTP_HOST: 'smtp.example.com', WANJI_SMTP_PORT: '587',
    WANJI_SMTP_SECURE: 'false',
    WANJI_SMTP_USER: 'mailer@example.com', WANJI_SMTP_PASSWORD: 'local-test-password',
    WANJI_SMTP_FROM: 'billing@example.com',
  });
  assert.equal(startTls.port, 587);
  assert.equal(startTls.secure, false);
  assert.equal(startTls.from, 'billing@example.com');
});

test('SMTP rejects invalid ports, header newlines and malformed sender addresses', () => {
  const base = {
    WANJI_SMTP_HOST: 'smtp.example.com', WANJI_SMTP_USER: 'mailer@example.com',
    WANJI_SMTP_PASSWORD: 'local-test-password',
  };
  for (const extra of [
    { WANJI_SMTP_PORT: '70000' },
    { WANJI_SMTP_PORT: '0' },
    { WANJI_SMTP_USER: 'mailer@example.com\r\nBcc: victim@example.com' },
    { WANJI_SMTP_FROM: 'bad-address' },
    { WANJI_SMTP_HOST: 'smtp.example.com\r\nMAIL FROM:<attacker@example.com>' },
  ]) assert.equal(smtpConfig({ ...base, ...extra }), null);
});
