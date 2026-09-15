'use strict';

// GraphQL protocol also used by pydrawise (Apache-2.0).
// Public Hydrawise application identifier, not an account credential.
const TOKEN_URL = 'https://app.hydrawise.com/api/v2/oauth/access-token';
const GRAPH_URL = 'https://app.hydrawise.com/api/v2/graph';
const QUERY = '{ me { id controllers { id name online sensors { id name model { name } status { active } } } } }';

class HydrawiseSensors {
  constructor({ load, save, fetchImpl = fetch, now = Date.now }) {
    this.load = load;
    this.save = save;
    this.fetch = fetchImpl;
    this.now = now;
    this.pending = null;
    this.cache = null;
    this.retryAfter = 0;
  }

  async request(url, options) {
    if (this.now() < this.retryAfter) throw new Error('rate_limited');
    let response;
    try {
      response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch {
      throw new Error('connection_failed');
    }
    if (response.status === 429) {
      const raw = response.headers.get('retry-after');
      const seconds = Number(raw);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - this.now();
      this.retryAfter = this.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0);
      throw new Error('rate_limited');
    }
    if (response.status === 401 || response.status === 403) throw new Error('login_required');
    if (url === TOKEN_URL && response.status === 400) throw new Error('login_required');
    if (!response.ok) throw new Error('connection_failed');
    try { return await response.json(); } catch { throw new Error('invalid_response'); }
  }

  async token(fields) {
    const body = new URLSearchParams({ client_id: 'hydrawise_app', client_secret: 'zn3CrjglwNV1', ...fields });
    const data = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !(Number(data.expires_in) > 0)) {
      throw new Error('login_required');
    }
    return { access: data.access_token, refresh: data.refresh_token, expires: this.now() + Number(data.expires_in) * 1000 };
  }

  async query(auth) {
    const data = await this.request(GRAPH_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY }),
    });
    if (!data || data.errors?.length || !Number.isInteger(data.data?.me?.id) || !Array.isArray(data.data.me.controllers)) {
      throw new Error('invalid_response');
    }
    return data.data.me;
  }

  // Validate before persisting. Password is never saved or returned.
  async login(username, password) {
    const auth = await this.token({ grant_type: 'password', scope: 'all', username, password });
    const user = await this.query(auth);
    return { ...auth, accountId: user.id };
  }

  async controllers() {
    if (this.now() < this.retryAfter) throw new Error('rate_limited');
    if (this.cache && this.now() - this.cache.time < 30000) return this.cache.controllers;
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }

  async refresh(auth) {
    const next = { ...await this.token({ grant_type: 'refresh_token', refresh_token: auth.refresh }), accountId: auth.accountId };
    await this.save(next);
    return next;
  }

  async read() {
    let auth = this.load();
    if (!auth?.refresh) throw new Error('login_required');
    let refreshed = false;
    if (!Number.isFinite(auth.expires) || auth.expires < this.now() + 60000) {
      auth = await this.refresh(auth);
      refreshed = true;
    }
    let user;
    try { user = await this.query(auth); } catch (error) {
      if (error.message !== 'login_required' || refreshed) throw error;
      auth = await this.refresh(auth);
      user = await this.query(auth);
    }
    if (user.id !== auth.accountId) throw new Error('login_required');
    this.cache = { time: this.now(), controllers: user.controllers };
    return user.controllers;
  }
}
module.exports = HydrawiseSensors;
