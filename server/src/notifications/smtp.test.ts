// D17 (revisión del 8 de octubre): en el 587 el transporte no exigía STARTTLS. Si el servidor
// no lo ofrece (o alguien en medio lo quita), usuario y contraseña viajaban en claro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../test/setup.ts';

const { opcionesSmtp } = await import('./channels.ts');

test('D17: 587 (y por defecto) exige TLS; 465 es TLS directo; quitarlo es explícito', () => {
  const base = { SMTP_HOST: 'smtp.example.invalid', SMTP_USER: 'yo', SMTP_PASS: 'x' };
  const p587 = opcionesSmtp({ ...base, SMTP_PORT: '587' });
  assert.equal(p587.requireTLS, true);
  assert.equal(p587.secure, false);
  assert.equal(opcionesSmtp(base).port, 587);
  assert.equal(opcionesSmtp(base).requireTLS, true, 'sin puerto, 587 y con TLS');
  const p465 = opcionesSmtp({ ...base, SMTP_PORT: '465' });
  assert.equal(p465.secure, true);
  assert.equal(opcionesSmtp({ ...base, SMTP_PORT: '25', SMTP_TLS: 'off' }).requireTLS, false, 'un relé local sin TLS, solo pidiéndolo');
});
