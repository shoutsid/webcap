/**
 * Streamable-HTTP MCP transport for webcap: POST /mcp.
 *
 * `server.ts` is the transport-free JSON-RPC core and `stdio.ts` is the local
 * install path. This module is the third one: a remote endpoint an MCP host can
 * point at with no install, no package manager and no package registry.
 *
 *   { "mcpServers": { "webcap": { "url": "https://webcap.shoutsid.fyi/mcp" } } }
 *
 * Why this earns its place: an installable server needs a package, a registry
 * entry and a publish token, and GitHub Packages would additionally demand a
 * personal access token on every install — friction an autonomous agent cannot
 * clear. A public HTTPS endpoint needs none of those things, and it is the
 * shape the official MCP Registry accepts as a `remotes` entry.
 *
 * Transport shape (MCP "Streamable HTTP"):
 * - POST carries one JSON-RPC message (a batch array is accepted too) and is
 *   answered `application/json`. The spec allows a single JSON response instead
 *   of an SSE stream, which keeps this stateless and testable.
 * - A body that is only notifications/responses is answered `202`, no body.
 * - GET is deliberately not registered: this server never opens a
 *   server-initiated SSE stream, and the spec's answer for that case is 405.
 *   The app's not-found envelope already produces exactly that, with
 *   `Allow: POST`, so no GET route has to exist to lie about it.
 * - No sessions: `Mcp-Session-Id` is optional, and a stateless server lets any
 *   number of hosts call concurrently.
 * - A batch is capped at {@link MAX_BATCH_MESSAGES}, because each message can
 *   become a nested request and the body limit alone is not a work bound.
 *
 * Payment: this endpoint holds NO wallet and NO operator account key. Free
 * tools work for anyone; a paid tool returns the live x402 402 challenge as
 * text so the calling agent settles it with its own x402 client. Auto-paying
 * from an operator key here would be free money for any anonymous caller, so
 * the capability is absent rather than merely undocumented.
 */
import type { FastifyInstance } from 'fastify';
import type { WebcapConfig } from '../config.js';
import { handleRpc, declareProtocolVersion, MCP_SERVER_VERSION, type McpHttp, type McpResponse } from './server.js';
import { clientIpOf } from '../util/client-ip.js';

/**
 * The HTTP seam over this same app: in-process, so no network or loopback port.
 *
 * `forward` matters for correctness, not just tidiness. The nested call is a
 * real request that runs the free routes' per-peer rate limiter and the metrics
 * hook, and Fastify's `req.ip` on an injected request is loopback. Forwarding
 * the caller's address keeps the free tools' budget per real caller instead of
 * one shared bucket for every MCP host on the internet, and forwarding the
 * user agent keeps `endpoint_hits` attribution honest (attribution is the reach
 * metric, and "unknown" would erase this whole transport from it).
 *
 * The address forwarded is `clientIpOf(req)`, not `req.ip`: behind the tunnel
 * the raw peer is the gateway for every caller, so forwarding it would give
 * every MCP host on the internet the one bucket this comment exists to avoid.
 */
function selfClient(app: FastifyInstance, forward: { readonly remoteAddress?: string; readonly userAgent?: string }): McpHttp {
  return {
    async request(method, path, body, headers): Promise<McpResponse> {
      const res = await app.inject({
        method,
        url: path,
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
        // An explicit header wins over the forwarded one (the credit-key rail
        // sets authorization; nothing else sets user-agent).
        headers: {
          ...(forward.userAgent !== undefined ? { 'user-agent': forward.userAgent } : {}),
          ...(headers ?? {}),
        },
        ...(forward.remoteAddress !== undefined ? { remoteAddress: forward.remoteAddress } : {}),
      });
      // The injected route always answers JSON here; fall back to the raw text
      // rather than throwing, so an unexpected non-JSON reply still reaches the
      // tool layer as its real status plus body.
      let parsed: unknown = res.body;
      try {
        parsed = res.json();
      } catch {
        parsed = res.body;
      }
      return { status: res.statusCode, body: parsed };
    },
  };
}

/** JSON-RPC error envelope for a request we could not even parse. */
function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

/**
 * Most JSON-RPC messages one POST may carry.
 *
 * A batch is processed sequentially, but each `tools/call` becomes a real
 * nested HTTP request, and the body limit alone would still allow thousands of
 * tiny messages in one 2 MB POST — an unauthenticated caller could turn one
 * request into thousands of downstream ones. The cap matches the batch size we
 * already allow elsewhere (up to 50 URLs per extract payment).
 */
export const MAX_BATCH_MESSAGES = 50;

/**
 * Register POST /mcp. Safe to call on any deployment: the free tools are the
 * same handlers the REST surface serves, and a paid tool call costs the caller
 * its own money, never this deployment's.
 */
export function registerMcpHttpRoute(app: FastifyInstance, config: WebcapConfig): void {
  // Honest, transport-specific advice: there is no wallet here to configure,
  // so pointing the caller at WEBCAP_MCP_WALLET_KEY would be a dead end.
  const noPayerHint =
    'This is the public HTTPS MCP endpoint, which holds no wallet: pay from your own x402 client by calling the ' +
    `same endpoints over HTTPS at ${config.publicBaseUrl} (for example POST ${config.publicBaseUrl}/v1/x402/extract).`;

  app.post('/mcp', async (req, reply) => {
    const body: unknown = req.body;
    const isBatch = Array.isArray(body);

    if (body === undefined || body === null) {
      return reply.status(400).send(rpcError(-32700, 'parse error: a JSON-RPC message is required'));
    }
    if (isBatch && body.length === 0) {
      return reply.status(400).send(rpcError(-32600, 'invalid request: an empty batch carries no message'));
    }
    if (isBatch && body.length > MAX_BATCH_MESSAGES) {
      return reply
        .status(400)
        .send(rpcError(-32600, `invalid request: a batch may carry at most ${MAX_BATCH_MESSAGES} messages`));
    }

    // Built per request so the tool calls inherit this caller's identity.
    const userAgent = req.headers['user-agent'];
    const ctx = {
      baseUrl: config.publicBaseUrl,
      version: MCP_SERVER_VERSION,
      http: selfClient(app, {
        remoteAddress: clientIpOf(req),
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      }),
      canPay: false,
      noPayerHint,
    };

    const messages: readonly unknown[] = isBatch ? body : [body];
    // The 2026-07-28 transport carries the revision in an `MCP-Protocol-Version`
    // header as well as in `_meta`; accept either, so a header-only client is
    // not silently treated as legacy.
    const headerVersion = req.headers['mcp-protocol-version'];
    const declaredHeader = typeof headerVersion === 'string' ? headerVersion : undefined;
    const responses: unknown[] = [];
    for (const message of messages) {
      try {
        const response = await handleRpc(declareProtocolVersion(message, declaredHeader), ctx);
        if (response !== null) responses.push(response);
      } catch (err) {
        // A handler fault must not take the transport down: answer the one
        // message with an internal error and keep serving the rest of a batch.
        responses.push(rpcError(-32603, `internal error: ${err instanceof Error ? err.message : String(err)}`));
      }
    }

    // Notifications and responses only: the spec wants 202 with no body.
    if (responses.length === 0) return reply.status(202).send();

    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .send(isBatch ? responses : responses[0]);
  });
}
