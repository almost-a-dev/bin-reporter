const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { requireBearerAuth } = require('@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js');
const { z } = require('zod');
const { reportMissedBin, listAddresses, BIN_COLOURS } = require('./reportBin');
const { BinReporterOAuthProvider } = require('./oauth');

const HOUSE_NUMBER = process.env.BIN_HOUSE_NUMBER;
const POSTCODE = process.env.BIN_POSTCODE;
const UPRN = process.env.BIN_UPRN;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = Number(process.env.PORT || 3000);

if (!HOUSE_NUMBER || !POSTCODE) {
  console.error(
    'Missing configuration: set BIN_HOUSE_NUMBER and BIN_POSTCODE env vars (and optionally BIN_UPRN if the address is ambiguous).'
  );
  process.exit(1);
}

if (!AUTH_TOKEN) {
  console.error('Missing configuration: set MCP_AUTH_TOKEN to a secret passphrase used to approve new OAuth clients.');
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.error(
    'Missing configuration: set PUBLIC_URL to the externally reachable https URL of this server (e.g. https://bin-reporter.aerw.uk).'
  );
  process.exit(1);
}

const issuerUrl = new URL(PUBLIC_URL);
const resourceServerUrl = new URL('/mcp', PUBLIC_URL);
const provider = new BinReporterOAuthProvider(AUTH_TOKEN);

function createServer() {
  const server = new McpServer({ name: 'bin-reporter', version: '1.0.0' });

  server.registerTool(
    'report_missed_bin',
    {
      title: 'Report a missed bin to Barnsley Council',
      description:
        'Submits a "missed bin" report to Barnsley Council for the pre-configured address. ' +
        "Always uses today's date and always reports the whole street as affected. " +
        'Set dryRun to true to fill the form and see the summary without actually submitting it.',
      inputSchema: {
        colour: z.enum(BIN_COLOURS).describe('The colour of the bin that was missed (Blue, Brown, Green, or Grey).'),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, fills the form and returns the summary without submitting.'),
      },
    },
    async ({ colour, dryRun }) => {
      try {
        const result = await reportMissedBin({
          houseNumber: HOUSE_NUMBER,
          postcode: POSTCODE,
          uprn: UPRN,
          colour,
          everyoneAffected: true,
          dryRun,
        });
        const text = result.submitted
          ? `Report submitted.\n\n${result.summary}\n\n${result.confirmation}`
          : `Dry run only, nothing submitted.\n\n${result.summary}`;
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        if (err.message === 'AMBIGUOUS_ADDRESS') {
          const list = err.options.map((o) => `- ${o.value}: ${o.label}`).join('\n');
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Multiple addresses matched BIN_HOUSE_NUMBER/BIN_POSTCODE. Set BIN_UPRN to one of:\n${list}`,
              },
            ],
          };
        }
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  );

  server.registerTool(
    'list_addresses',
    {
      title: 'List address matches for the configured house number/postcode',
      description:
        'Looks up the configured BIN_HOUSE_NUMBER/BIN_POSTCODE against the council address database and returns ' +
        'the matching addresses with their UPRNs, useful for setting BIN_UPRN if the lookup is ambiguous.',
      inputSchema: {},
    },
    async () => {
      const result = await listAddresses({ houseNumber: HOUSE_NUMBER, postcode: POSTCODE });
      const text = result.addresses.length
        ? result.addresses.map((o) => `- ${o.uprn}: ${o.address}`).join('\n')
        : 'No addresses matched.';
      return { content: [{ type: 'text', text }] };
    }
  );

  return server;
}

const app = express();
// Trust exactly one hop (the reverse proxy in front of this container) so express-rate-limit
// can read the real client IP from X-Forwarded-For without trusting arbitrary spoofed values.
app.set('trust proxy', 1);

app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: ['mcp'],
    resourceName: 'bin-reporter',
  })
);

app.post('/authorize/verify', express.urlencoded({ extended: true }), (req, res) => {
  provider.completeAuthorization(req, res).catch((err) => {
    console.error('Authorization error:', err);
    if (!res.headersSent) {
      res.status(500).send('Internal server error');
    }
  });
});

app.all(
  '/mcp',
  requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  }),
  express.json(),
  async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('Error handling MCP request:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
);

app.use((req, res) => {
  console.warn(`404 ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`bin-reporter MCP server listening on port ${PORT}`);
});
