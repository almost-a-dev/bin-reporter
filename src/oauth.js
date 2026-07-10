const crypto = require('node:crypto');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderConsentPage({ client, params, error }) {
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escapeHtml(value ?? '')}">`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Authorize bin-reporter</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 1.1rem; }
  input[type=password] { width: 100%; padding: 8px; font-size: 1rem; box-sizing: border-box; margin: 12px 0; }
  button { padding: 8px 16px; font-size: 1rem; }
  .error { color: #b00020; }
</style>
</head>
<body>
  <h1>${escapeHtml(client.client_name || client.client_id)} wants to access bin-reporter</h1>
  <p>Enter your MCP passphrase to continue.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/authorize/verify">
    ${hidden('client_id', client.client_id)}
    ${hidden('redirect_uri', params.redirectUri)}
    ${hidden('state', params.state)}
    ${hidden('code_challenge', params.codeChallenge)}
    ${hidden('scope', (params.scopes || []).join(' '))}
    ${hidden('resource', params.resource ? params.resource.toString() : '')}
    <input type="password" name="passphrase" placeholder="Passphrase" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

class InMemoryClientsStore {
  constructor() {
    this.clients = new Map();
  }

  async getClient(clientId) {
    return this.clients.get(clientId);
  }

  async registerClient(client) {
    this.clients.set(client.client_id, client);
    return client;
  }
}

/**
 * Single-user OAuth provider: dynamic client registration is open (as MCP clients expect),
 * but the authorize step gates on a passphrase (MCP_AUTH_TOKEN) instead of a real login,
 * since this server only ever has one authorized user.
 */
class BinReporterOAuthProvider {
  constructor(passphrase) {
    this.passphrase = passphrase;
    this.clientsStore = new InMemoryClientsStore();
    this.codes = new Map();
    this.tokens = new Map();
    this.refreshTokens = new Map();
  }

  async authorize(client, params, res) {
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new Error('Unregistered redirect_uri');
    }
    res.set('Content-Type', 'text/html');
    res.send(renderConsentPage({ client, params }));
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    return codeData.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    if (codeData.clientId !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, codeData.scopes, codeData.resource);
  }

  async exchangeRefreshToken(client, refreshToken) {
    const data = this.refreshTokens.get(refreshToken);
    if (!data || data.clientId !== client.client_id) {
      throw new Error('Invalid refresh token');
    }
    return this.issueTokens(client.client_id, data.scopes, data.resource, refreshToken);
  }

  issueTokens(clientId, scopes, resource, existingRefreshToken) {
    const accessToken = crypto.randomUUID();
    const expiresIn = 12 * 3600;
    this.tokens.set(accessToken, {
      clientId,
      scopes: scopes || [],
      resource,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    const refreshToken = existingRefreshToken || crypto.randomUUID();
    this.refreshTokens.set(refreshToken, { clientId, scopes: scopes || [], resource });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: (scopes || []).join(' '),
    };
  }

  async verifyAccessToken(token) {
    const data = this.tokens.get(token);
    if (!data || data.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token');
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
      resource: data.resource,
    };
  }

  /** Handles the passphrase-gated POST from the consent form rendered by authorize(). */
  async completeAuthorization(req, res) {
    const { client_id: clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, scope, resource, passphrase } = req.body;
    const client = await this.clientsStore.getClient(clientId);
    const params = {
      redirectUri,
      state,
      codeChallenge,
      scopes: scope ? scope.split(' ') : [],
      resource: resource ? new URL(resource) : undefined,
    };
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      res.status(400).send('Invalid client or redirect_uri.');
      return;
    }
    if (passphrase !== this.passphrase) {
      res.set('Content-Type', 'text/html');
      res.status(401).send(renderConsentPage({ client, params, error: 'Incorrect passphrase.' }));
      return;
    }
    const code = crypto.randomUUID();
    this.codes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes,
      resource: params.resource,
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state !== undefined) {
      target.searchParams.set('state', state);
    }
    res.redirect(target.toString());
  }
}

module.exports = { BinReporterOAuthProvider };
