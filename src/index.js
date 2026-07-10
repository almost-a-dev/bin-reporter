const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { reportMissedBin, listAddresses, BIN_COLOURS } = require('./reportBin');

const HOUSE_NUMBER = process.env.BIN_HOUSE_NUMBER;
const POSTCODE = process.env.BIN_POSTCODE;
const UPRN = process.env.BIN_UPRN;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = Number(process.env.PORT || 3000);

if (!HOUSE_NUMBER || !POSTCODE) {
  console.error(
    'Missing configuration: set BIN_HOUSE_NUMBER and BIN_POSTCODE env vars (and optionally BIN_UPRN if the address is ambiguous).'
  );
  process.exit(1);
}

if (!AUTH_TOKEN) {
  console.error('Missing configuration: set MCP_AUTH_TOKEN to a secret used to authenticate requests.');
  process.exit(1);
}

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

function isAuthorized(req) {
  const header = req.headers['authorization'] || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token === AUTH_TOKEN;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('Error handling MCP request:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`bin-reporter MCP server listening on port ${PORT}`);
});
