'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../lib/HydrawiseSensors');
const response = (data, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => data });
const user = { data: { me: { id: 1, controllers: [{ id: 4, sensors: [] }] } } };
function setup(replies, auth = { accountId: 1, access: 'access-secret', refresh: 'refresh-secret', expires: 900000 }) {
  let time = 100000; const calls = []; const saved = [];
  const client = new Client({ load: () => auth, save: value => { saved.push(value); auth = value; }, now: () => time, fetchImpl: async (url, options) => {
    calls.push({ url, options }); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply;
  } });
  return { client, calls, saved, advance: n => { time += n; } };
}
test('concurrent sensors share one request and a short-lived cache', async () => {
  const { client, calls } = setup([response(user)]);
  const [a, b] = await Promise.all([client.controllers(), client.controllers()]);
  assert.deepEqual(a, b); await client.controllers(); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
});
test('expired authentication refreshes once and persists rotation across restarts', async () => {
  const s = setup([response({ access_token: 'next', refresh_token: 'next-refresh', expires_in: 3600 }), response(user)], { accountId: 1, refresh: 'old', expires: 0 });
  await Promise.all([s.client.controllers(), s.client.controllers()]);
  assert.equal(s.saved.length, 1); assert.equal(s.saved[0].refresh, 'next-refresh'); assert.equal(s.saved[0].accountId, 1);
});
test('expired server-side access token refreshes and retries once', async () => {
  const s = setup([response({}, 401), response({ access_token: 'next', refresh_token: 'next-refresh', expires_in: 3600 }), response(user)]);
  assert.deepEqual(await s.client.controllers(), user.data.me.controllers);
  assert.equal(s.calls.length, 3);
});
test('429 respects Retry-After and does not issue more requests during backoff', async () => {
  const s = setup([response({}, 429, { 'retry-after': '120' }), response(user)]);
  await assert.rejects(s.client.controllers(), /rate_limited/); s.advance(60000);
  await assert.rejects(s.client.controllers(), /rate_limited/); assert.equal(s.calls.length, 1);
  s.advance(60001); await s.client.controllers(); assert.equal(s.calls.length, 2);
});
test('HTTP-date Retry-After is respected', async () => {
  const s = setup([response({}, 429, { 'retry-after': new Date(280000).toUTCString() })]);
  await assert.rejects(s.client.controllers(), /rate_limited/); s.advance(120000);
  await assert.rejects(s.client.controllers(), /rate_limited/); assert.equal(s.calls.length, 1);
});
test('partial GraphQL errors and invalid identity never populate the cache', async () => {
  const s = setup([response({ ...user, errors: [{ message: 'secret details' }] }), response({ data: { me: { id: 2, controllers: [] } } })]);
  await assert.rejects(s.client.controllers(), /invalid_response/);
  await assert.rejects(s.client.controllers(), /login_required/);
});
test('login never persists a password or unverified auth', async () => {
  const s = setup([response({ access_token: 'next', refresh_token: 'next-refresh', expires_in: 3600 }), response(user)]);
  const auth = await s.client.login('user', 'password-secret');
  assert.equal(auth.accountId, 1); assert.equal(s.saved.length, 0); assert.ok(!JSON.stringify(auth).includes('password-secret'));
});
test('errors do not expose network exception credentials', async () => {
  const s = setup([new Error('secret-password https://private-url')]);
  await assert.rejects(s.client.controllers(), { message: 'connection_failed' });
});
