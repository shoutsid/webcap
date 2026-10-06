/**
 * The remote MCP path docs: POST /mcp.
 *
 * Appended after the original path tables so their key order (and therefore
 * the generated JSON for every pre-existing path) is unchanged.
 */
import type { WebcapConfig } from '../../config.js';
import { jsonContent, type PathContext } from './shared.js';
import type { OpenapiPaths } from './types.js';

/** The remote MCP transport doc (one path: the Streamable HTTP endpoint). */
export function mcpPaths(_config: WebcapConfig, ctx: PathContext): OpenapiPaths {
  return {
    '/mcp': {
      post: {
        tags: ['mcp'],
        summary: 'Remote MCP endpoint (Streamable HTTP): webcap tools for any MCP host, no install',
        description:
          'The Model Context Protocol Streamable HTTP endpoint. An MCP host points at it directly ' +
          '("mcpServers": {"webcap": {"url": "https://<host>/mcp"}}) and gets the same tool set as the npm/stdio ' +
          'server: webcap_service_catalog, webcap_preview, webcap_og (all free), plus webcap_capture ' +
          '(png/jpeg/pdf, or WebM/VP8 scroll video), webcap_extract, webcap_audit, webcap_map_lite and webcap_analyze (paid). ' +
          'Every paid tool is also free while the caller\'s rolling per-IP allowance lasts, so an unpaid call runs ' +
          'the real product and returns x-webcap-allowance-* headers before it ever 402s. ' +
          'Bodies are JSON-RPC 2.0 (initialize, tools/list, tools/call); a batch array is accepted. Free tools run ' +
          'here directly. This endpoint holds no wallet and no operator account key, so a paid tool call returns ' +
          'the live x402 402 challenge as its tool result, to be settled by the calling agent with its own x402 ' +
          'client. Notifications and responses are answered 202 with no body. GET /mcp is deliberately 405 ' +
          '(Allow: POST): this server never opens a server-initiated SSE stream. No sessions, no API key, no account.',
        requestBody: {
          required: true,
          content: jsonContent({
            type: 'object',
            description:
              'A single JSON-RPC 2.0 message (or an array of them). Allowed methods: initialize, ping, tools/list, tools/call.',
            properties: {
              jsonrpc: { type: 'string', enum: ['2.0'] },
              id: { type: ['string', 'number', 'null'], description: 'Absent on notifications' },
              method: { type: 'string', example: 'tools/call' },
              params: { type: 'object' },
            },
            required: ['jsonrpc', 'method'],
          }),
        },
        responses: {
          200: {
            description: 'JSON-RPC 2.0 response (an array when the request body was a batch)',
            content: jsonContent({
              type: 'object',
              properties: {
                jsonrpc: { type: 'string', example: '2.0' },
                id: { type: ['string', 'number', 'null'] },
                result: { type: 'object' },
                error: {
                  type: 'object',
                  properties: { code: { type: 'integer' }, message: { type: 'string' } },
                },
              },
            }),
          },
          202: {
            description: 'Accepted: the body carried only notifications/responses, so there is nothing to return',
          },
          400: ctx.badInput,
        },
        security: [],
      },
    },
  };
}