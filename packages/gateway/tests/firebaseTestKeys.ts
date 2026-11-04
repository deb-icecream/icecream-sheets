/**
 * Test-only RSA fixtures for Firebase ID-token verification tests.
 *
 * Generates an RSA keypair with WebCrypto, wraps the public key in a
 * minimal self-signed X.509 certificate (DER built by hand — the
 * signature is zeros; only the structure matters for the SPKI
 * extraction), and mints RS256 JWTs shaped like Firebase ID tokens.
 * Nothing here touches the network or real Google certs.
 */

const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return Buffer.from(s, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLenBytes(len: number): number[] {
  if (len < 128) return [len];
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: number[]): number[] {
  return [tag, ...derLenBytes(content.length), ...content];
}

const seq = (...parts: number[][]): number[] => tlv(0x30, parts.flat());
const int = (n: number): number[] => {
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  } while (v > 0);
  if (bytes[0]! >= 0x80) bytes.unshift(0x00);
  return tlv(0x02, bytes);
};
const bitStr = (content: number[]): number[] => tlv(0x03, content);
const utcTime = (s: string): number[] => tlv(0x17, [...te.encode(s)]);
const null_ = (): number[] => [0x05, 0x00];


/** Remove the SPKI envelope from a WebCrypto-exported SPKI, returning the
 *  inner RSAPublicKey DER (the BIT STRING payload minus its pad byte). */
function stripSpkiEnvelope(spki: Uint8Array): number[] {
  const bytes = [...spki];
  // outer SEQUENCE
  if (bytes[0] !== 0x30) throw new Error('fixture: SPKI must start with SEQUENCE');
  let pos = 1;
  // walk: outer length
  const readLen = (at: number): [number, number] => {
    const first = bytes[at]!;
    if ((first & 0x80) === 0) return [first, 1];
    const n = first & 0x7f;
    let len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[at + 1 + i]!;
    return [len, 1 + n];
  };
  const [, outerLenBytes] = readLen(pos);
  pos += outerLenBytes;
  // AlgorithmIdentifier SEQUENCE: skip it wholesale
  if (bytes[pos] !== 0x30) throw new Error('fixture: expected algId SEQUENCE');
  const [algLen, algLenBytes] = readLen(pos + 1);
  pos += 1 + algLenBytes + algLen;
  // BIT STRING
  if (bytes[pos] !== 0x03) throw new Error('fixture: expected BIT STRING');
  const [bsLen, bsLenBytes] = readLen(pos + 1);
  const contentStart = pos + 1 + bsLenBytes;
  if (bytes[contentStart] !== 0x00) throw new Error('fixture: expected zero pad byte');
  return bytes.slice(contentStart + 1, contentStart + bsLen);
}

/** Encode an OID like '1.2.840.113549.1.1.1' as DER. */
function oid(s: string): number[] {
  const nums = s.split('.').map(Number);
  const first = 40 * nums[0]! + nums[1]!;
  const rest: number[] = [];
  for (const n of nums.slice(2)) {
    const enc: number[] = [];
    let v = n;
    do {
      enc.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < enc.length - 1; i++) enc[i]! |= 0x80;
    rest.push(...enc);
  }
  return tlv(0x06, [first, ...rest]);
}

/**
 * Minimal X.509 certificate wrapping `spki` (SubjectPublicKeyInfo DER).
 * Self-signed with a zeroed signature — verification of the cert chain
 * is not what these tests exercise; the SPKI extraction is.
 */
export function selfSignedCertPem(spki: Uint8Array): string {
  // A real X.509 SPKI BIT STRING carries the bare PKCS#1 RSAPublicKey, NOT
  // a nested SPKI (the previous fixture embedded the full SPKI, which is
  // why the suite passed while real Google certs failed in production).
  // Strip the SPKI envelope (SEQUENCE { algId, BIT STRING { 0x00, key } })
  // and embed only the RSAPublicKey bytes.
  const rsaKey = stripSpkiEnvelope(spki);
  const rsaEncryption = seq(oid('1.2.840.113549.1.1.1'), null_());
  const sha256WithRSA = seq(oid('1.2.840.113549.1.1.11'), null_());
  const tbs = seq(
    tlv(0xa0, int(2)), // [0] EXPLICIT version v3
    int(0x1234), // serialNumber
    sha256WithRSA, // signature
    seq(), // issuer (empty)
    seq(utcTime('260101000000Z'), utcTime('270101000000Z')), // validity
    seq(), // subject (empty)
    seq(rsaEncryption, bitStr([0x00, ...rsaKey])), // subjectPublicKeyInfo
  );
  const cert = seq(tbs, sha256WithRSA, bitStr([0x00, ...new Array(256).fill(0)]));
  const b64 = Buffer.from(cert).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export interface TestRsaKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  spki: Uint8Array;
  certPem: string;
  kid: string;
}

export async function makeTestRsaKey(kid = 'test-kid-1'): Promise<TestRsaKey> {
  const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey('spki', publicKey));
  return { privateKey, publicKey, spki, certPem: selfSignedCertPem(spki), kid };
}

export interface FirebasePayloadOverrides {
  aud?: unknown;
  iss?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
  name?: unknown;
  email?: unknown;
  picture?: unknown;
}

/** Mint a Firebase-ID-token-shaped RS256 JWT signed by `key`. */
export async function mintFirebaseToken(
  key: TestRsaKey,
  overrides: FirebasePayloadOverrides = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: key.kid, typ: 'JWT', ...headerOverrides };
  const payload = {
    aud: 'demo-project',
    iss: 'https://securetoken.google.com/demo-project',
    sub: 'firebase-uid-1',
    exp: now + 3600,
    iat: now - 10,
    auth_time: now - 10,
    name: 'Test User',
    email: 'user@example.com',
    picture: 'https://example.com/pic.png',
    ...overrides,
  };
  const h = b64url(te.encode(JSON.stringify(header)));
  const p = b64url(te.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, te.encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

/** fetchCerts override serving the test key's cert. */
export function testFetchCerts(key: TestRsaKey) {
  return () => Promise.resolve({ certs: { [key.kid]: key.certPem }, maxAgeSeconds: 3600 });
}
