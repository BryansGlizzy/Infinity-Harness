#!/usr/bin/env node
// A stand-in for `rbxsync serve`: listens on the port it is given and says which folder it was started in.
import { createServer } from 'node:http';
const port = Number(process.argv[2]);
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', cwd: process.cwd() }));
  res.statusCode = 404;
  res.end('{}');
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
