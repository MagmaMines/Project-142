import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from './helpers/runtime.mjs';

/* A browser cannot open a UDP socket, so the runtime resolves names over DNS-
 * over-HTTPS. These tests stub fetch with recorded RFC 8484 JSON responses and
 * check the record shapes Node produces for each rrtype. */

const rt = loadRuntime();
const dns = rt.CORE.dns;
const promises = rt.CORE['dns/promises'];
const queries = [];
// The runtime lives in another realm, so its arrays/objects have different
// prototypes; compare their plain JSON shape instead.
const plain = value => JSON.parse(JSON.stringify(value));

const answers = {
  A: [{ name: 'example.test.', type: 1, TTL: 60, data: '93.184.216.34' }],
  AAAA: [{ type: 28, TTL: 60, data: '2606:2800:220:1:248:1893:25c8:1946' }],
  MX: [{ type: 15, TTL: 300, data: '10 mail.example.test.' }, { type: 15, TTL: 300, data: '20 backup.example.test.' }],
  TXT: [{ type: 16, TTL: 60, data: '"v=spf1 -all" "include:_spf.example.test"' }],
  CAA: [{ type: 257, TTL: 60, data: '0 issue "letsencrypt.org"' }],
  SRV: [{ type: 33, TTL: 60, data: '1 5 443 target.example.test.' }],
  SOA: [{ type: 6, TTL: 60, data: 'ns1.example.test. hostmaster.example.test. 2024010101 7200 3600 1209600 3600' }],
  TLSA: [{ type: 52, TTL: 60, data: '3 1 1 deadbeef' }],
  NAPTR: [{ type: 35, TTL: 60, data: '100 50 "s" "SIP+D2U" "" _sip._udp.example.test.' }],
  PTR: [{ type: 12, TTL: 60, data: 'host.example.test.' }],
  CNAME: [{ type: 5, TTL: 60, data: 'alias.example.test.' }],
  NS: [{ type: 2, TTL: 60, data: 'ns1.example.test.' }],
  ANY: [{ type: 1, TTL: 60, data: '93.184.216.34' }, { type: 16, TTL: 60, data: '"hello"' }],
};

test.beforeEach(() => {
  queries.length = 0;
  rt.sandbox.fetch = async url => {
    const parsed = new URL(String(url));
    const type = parsed.searchParams.get('type');
    const name = parsed.searchParams.get('name');
    queries.push({ endpoint: parsed.origin + parsed.pathname, name, type });
    if (type === 'CNAME' && name !== 'alias.example.test') return { ok: true, json: async () => ({ Status: 3 }) };
    const answer = answers[type];
    if (!answer) return { ok: true, json: async () => ({ Status: 3 }) };
    return { ok: true, json: async () => ({ Status: 0, Answer: answer }) };
  };
});

test('resolve4/resolve6 return addresses, with the ttl option honoured', async () => {
  assert.deepEqual(plain(await promises.resolve4('example.test')), ['93.184.216.34']);
  assert.deepEqual(plain(await promises.resolve4('example.test', { ttl: true })), [{ address: '93.184.216.34', ttl: 60 }]);
  assert.deepEqual(plain(await promises.resolve6('example.test')), ['2606:2800:220:1:248:1893:25c8:1946']);
  assert.equal(queries[0].endpoint, 'https://cloudflare-dns.com/dns-query');
  assert.equal(queries[0].type, 'A');
});

test('mx, txt, caa, srv, soa, tlsa and naptr shapes match Node', async () => {
  assert.deepEqual(plain(await promises.resolveMx('example.test')), [
    { priority: 10, exchange: 'mail.example.test' },
    { priority: 20, exchange: 'backup.example.test' },
  ]);
  assert.deepEqual(plain(await promises.resolveTxt('example.test')), [['v=spf1 -all', 'include:_spf.example.test']]);
  assert.deepEqual(plain(await promises.resolveCaa('example.test')), [{ critical: 0, issue: 'letsencrypt.org' }]);
  assert.deepEqual(plain(await promises.resolveSrv('example.test')), [{ priority: 1, weight: 5, port: 443, name: 'target.example.test' }]);
  assert.deepEqual(plain(await promises.resolveSoa('example.test')), {
    nsname: 'ns1.example.test', hostmaster: 'hostmaster.example.test', serial: 2024010101, refresh: 7200, retry: 3600, expire: 1209600, minttl: 3600,
  });
  const tlsa = await promises.resolveTlsa('example.test');
  assert.equal(tlsa[0].certUsage, 3);
  assert.equal(Buffer.from(tlsa[0].data).toString('hex'), 'deadbeef');
  const naptr = await promises.resolveNaptr('example.test');
  assert.equal(naptr[0].service, 'SIP+D2U');
  assert.equal(naptr[0].replacement, '_sip._udp.example.test');
  assert.deepEqual(plain(await promises.resolveNs('example.test')), ['ns1.example.test']);
});

test('resolveAny keeps the record type, like Node', async () => {
  const records = await promises.resolveAny('example.test');
  assert.deepEqual(plain(records), [
    { address: '93.184.216.34', type: 'A', ttl: 60 },
    { entries: ['hello'], type: 'TXT', ttl: 60 },
  ]);
});

test('reverse builds the right arpa name for v4 and v6', async () => {
  assert.deepEqual(plain(await promises.reverse('93.184.216.34')), ['host.example.test']);
  assert.equal(queries[0].name, '34.216.184.93.in-addr.arpa');
  queries.length = 0;
  assert.deepEqual(plain(await promises.reverse('2001:db8::1')), ['host.example.test']);
  assert.equal(queries[0].name, '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa');
});

test('lookupService and the callback API answer in Node order', async () => {
  assert.deepEqual(plain(await promises.lookupService('93.184.216.34', 443)), { hostname: 'host.example.test', service: '443' });
  const viaCallback = await new Promise((resolve, reject) => dns.resolve4('example.test', (error, value) => error ? reject(error) : resolve(value)));
  assert.deepEqual(plain(viaCallback), ['93.184.216.34']);
  const service = await new Promise((resolve, reject) => dns.lookupService('93.184.216.34', 80, (error, hostname, port) => error ? reject(error) : resolve({ hostname, port })));
  assert.deepEqual(plain(service), { hostname: 'host.example.test', port: '80' });
});

test('lookup prefers A, honours family and passes literal IPs straight through', async () => {
  assert.deepEqual(plain(await promises.lookup('example.test')), { address: '93.184.216.34', family: 4 });
  assert.deepEqual(plain(await promises.lookup('127.0.0.1')), { address: '127.0.0.1', family: 4 });
  assert.deepEqual(plain(await promises.lookup('::1')), { address: '::1', family: 6 });
  const all = await promises.lookup('example.test', { all: true });
  assert.equal(all.length, 2);
  assert.equal(all[0].family, 4);
  assert.equal(all[1].family, 6);
  const v6Only = await promises.lookup('example.test', { family: 6 });
  assert.equal(v6Only.family, 6);
});

test('NXDOMAIN and transport failures surface as Node error codes', async () => {
  await assert.rejects(promises.resolveCname('example.test'), error => error.code === 'ENOTFOUND');
  rt.sandbox.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(promises.resolve4('example.test'), error => error.code === 'EAI_AGAIN');
});

test('Resolver.setServers accepts DoH endpoints and rejects UDP nameservers', async () => {
  const resolver = new promises.Resolver({ timeout: 500 });
  resolver.setServers(['https://dns.google/dns-query']);
  assert.deepEqual(plain(resolver.getServers()), ['https://dns.google/dns-query']);
  assert.deepEqual(plain(await resolver.resolve4('example.test')), ['93.184.216.34']);
  assert.equal(queries[0].endpoint, 'https://dns.google/dns-query');
  assert.throws(() => resolver.setServers(['8.8.8.8']), error => error.code === 'ERR_INVALID_ARG_VALUE');
  const callbackResolver = new dns.Resolver();
  const value = await new Promise((resolve, reject) => callbackResolver.resolve('example.test', 'A', (error, records) => error ? reject(error) : resolve(records)));
  assert.deepEqual(plain(value), ['93.184.216.34']);
});
