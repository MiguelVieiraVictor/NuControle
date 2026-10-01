/* A chave secreta do Supabase nunca pode chegar ao site. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validarConfig } from "../frontend/js/nucleo/configuracao.js";

const URL_OK = "https://abcdefgh.supabase.co";
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.assinatura`;

test("aceita a chave publica", () => {
  assert.equal(validarConfig({ supabaseUrl: `${URL_OK}/`, supabaseChave: "sb_publishable_abc" }).supabaseUrl, URL_OK);
  assert.ok(validarConfig({ supabaseUrl: URL_OK, supabaseChave: jwt({ role: "anon" }) }));
});

test("recusa a chave secreta, nos dois formatos", () => {
  assert.throws(() => validarConfig({ supabaseUrl: URL_OK, supabaseChave: "sb_secret_abc" }), /SECRETA/);
  assert.throws(() => validarConfig({ supabaseUrl: URL_OK, supabaseChave: jwt({ role: "service_role" }) }), /SECRETA/);
});

test("recusa configuracao incompleta ou estranha", () => {
  assert.throws(() => validarConfig({ supabaseUrl: URL_OK, supabaseChave: "" }));
  assert.throws(() => validarConfig({ supabaseUrl: URL_OK, supabaseChave: "qualquer-coisa" }));
  assert.throws(() => validarConfig({ supabaseUrl: "http://abcdefgh.supabase.co", supabaseChave: "sb_publishable_abc" }));
  assert.throws(() => validarConfig({ supabaseUrl: "https://evil.com", supabaseChave: "sb_publishable_abc" }));
  assert.throws(() => validarConfig({}));
});
