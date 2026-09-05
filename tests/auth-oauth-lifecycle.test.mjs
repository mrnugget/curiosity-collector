import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { BASE_PATH, createHarness, introspectionChecks, providerFetch, strictFieldChecksPassed, safeRequestID, verifyAccessToken } from '../src/lib/server/oauth-lifecycle.ts';

const origin = 'https://harness.example';
const owner = 'user_01K9KJJDPFGCG05B1WFFETGX8E';
const issuer = 'https://auth.ampcode.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', use: 'sig', alg: 'RS256' };
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt(claims, header = {alg:'RS256',kid:'test'}) {
 const data = `${encode(header)}.${encode(claims)}`;
 return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
function fixture(t, mode = '') {
 let auth, cookie, revoked = false, exchanges = 0;
 const hints = [];
 const tokens = new Map();
 const now = Date.now();
 const harness = createHarness({ origin, clientID:'client-test', clientSecret:'secret-test', now:()=>now,
  fetchFn: async (url, init) => {
   if (url.endsWith('/jwks')) return Response.json({keys:[jwk]});
   const form = init.body;
   assert.equal(form.get('client_secret'), 'secret-test');
   if (url.endsWith('/token')) {
    exchanges++;
    assert.equal(form.get('resource'), 'https://ampcode.com/api/v2');
    assert.equal(form.get('redirect_uri'), `${origin}${BASE_PATH}/auth/callback`);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), auth.searchParams.get('code_challenge'));
    const claims = {sub:owner, client_id:'client-test', iss:issuer, aud:'https://ampcode.com/api/v2', sid:`private-sid-${exchanges}`, jti:`private-jti-${exchanges}`, exp:Math.floor(now/1000)+3600};
    const token = jwt(claims);
    tokens.set(token,{claims,number:exchanges});
    return Response.json({access_token:token, expires_in:3600, refresh_token:'private-refresh', id_token:jwt({iss:issuer,aud:'client-test',sub:mode==='owner'?'other':owner,exp:claims.exp,nonce:mode==='nonce'?'wrong':auth.searchParams.get('nonce')})});
   }
   assert.ok(url.endsWith('/introspection'));
   const token = tokens.get(form.get('token'));
   hints.push(form.get('token_type_hint'));
   assert.deepEqual([...form.keys()].sort(), form.has('token_type_hint') ? ['client_id','client_secret','token','token_type_hint'] : ['client_id','client_secret','token']);
   if (mode === 'inactive') return Response.json({active:false}, {headers:{'x-request-id':'request_test-123'}});
   if (mode === 'paired') return Response.json({active:!form.has('token_type_hint')}, {headers:{'x-request-id':form.has('token_type_hint')?'request_with-hint':'request_without-hint'}});
   if (mode === 'failure') throw new Error('private-provider-error');
   return Response.json(revoked && token.number===1 ? {active:false} : {active:true,...token.claims, token_type:'Bearer', provider_secret:'DO-NOT-OUTPUT'});
  }
 });
 t.after(()=>harness.close());
 const request = (path, method='GET', extra={}) => harness.handle(new Request(`${origin}${BASE_PATH}${path}`,{method,headers:{...(cookie?{cookie}:{}),...(method==='POST'?{origin}:{}),...extra}}));
 return {
  async open(){const r=await request('/'); cookie=r.headers.get('set-cookie').split(';')[0]; assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/); return r;},
  request, hints, revoke(){revoked=true;}, exchanges:()=>exchanges,
  async signin(slot, wrongState=false){const r=await request(`/signin-${slot}`,'POST'); assert.equal(r.status,303); auth=new URL(r.headers.get('location')); assert.equal(auth.searchParams.get('scope'),'openid profile email offline_access'); assert.equal(auth.searchParams.get('resource'),'https://ampcode.com/api/v2'); assert.equal(auth.searchParams.get('code_challenge_method'),'S256'); return request(`/auth/callback?code=fake&state=${wrongState?'wrong':auth.searchParams.get('state')}`);},
  async evidence(){const html=await (await request('/')).text(); for(const forbidden of ['private-sid','private-jti','private-refresh','DO-NOT-OUTPUT','secret-test','private-provider-error']) assert.ok(!html.includes(forbidden)); return JSON.parse(html.match(/<pre>(.*?)<\/pre>/s)[1]);}
 };
}

test('full lifecycle uses real signature verification and emits only safe evidence',async t=>{
 const f=fixture(t); await f.open(); await f.signin('a');
 let e=await f.evidence(); assert.equal(e.beforeRevocation.active,true); assert.equal(e.beforeRevocation.checks.tokenTypeBearer,true); assert.equal(e.beforeRevocation.checks.tokenTypeAccessToken,false);
 assert.equal(e.accessTokenValidationA.result,'valid');
 assert.equal(e.beforeRevocationWithoutHint.active,true);
 assert.deepEqual(f.hints,['access_token',null]);
 assert.equal((await f.request('/signin-b','POST')).status,409);
 f.revoke(); await f.request('/check-a','POST'); await f.signin('b');
 e=await f.evidence(); assert.equal(e.afterRevocation.active,false); assert.equal(e.afterReconsent.expected,true); assert.equal(e.sidEqual,false);
 assert.equal(e.afterReconsent.strictFieldChecksPassed,false);
 await f.request('/reset','POST'); assert.equal((await f.request('/check-both','POST')).status,401);
});
for (const mode of ['owner','nonce','failure']) test(`safe ${mode} failure`,async t=>{
 const f=fixture(t,mode); await f.open(); await f.signin('a'); const e=await f.evidence();
 if(mode==='failure') assert.equal(e.beforeRevocation.active,null);
 else {assert.equal(e.tokenAReceived,false); assert.equal(e.error,mode==='owner'?'owner_mismatch':'sign_in_failed');}
});
test('auth, origin, state and callback replay rejection',async t=>{
 const f=fixture(t); assert.equal((await f.request('/check-a','POST')).status,401); await f.open();
 assert.equal((await f.request('/signin-a','POST',{origin:'https://evil.example'})).status,403);
 await f.signin('a',true); assert.equal(f.exchanges(),0); assert.equal((await f.evidence()).error,'invalid_state');
 await f.signin('a'); await f.request('/auth/callback?code=fake&state=wrong'); assert.equal(f.exchanges(),1);
});
test('missing introspection fields fail diagnostics; transport rejects unknown origins and paths',async()=>{
 assert.ok(Object.values(introspectionChecks({active:true},null,'client-test',owner,Date.now())).every(v=>v===false));
 await assert.rejects(providerFetch('http://auth.ampcode.com/oauth2/introspection'));
 await assert.rejects(providerFetch(`${issuer}/unexpected`));
});

test('platform strict checks require exact access_token and exact string audience',()=>{
 const now=Date.now();
 const claims={sub:owner,client_id:'client-test',iss:issuer,aud:'https://ampcode.com/api/v2',sid:'test-sid',jti:'test-jti',exp:Math.floor(now/1000)+3600};
 const check=(patch={})=>introspectionChecks({...claims,token_type:'access_token',...patch},claims,'client-test',owner,now);
 assert.equal(strictFieldChecksPassed(check()),true);
 assert.equal(check().tokenTypeBearer,false);
 for(const token_type of ['Bearer','bearer','ACCESS_TOKEN']) assert.equal(strictFieldChecksPassed(check({token_type})),false);
 const array=check({aud:[claims.aud]});
 assert.equal(array.audienceIsString,false);
 assert.equal(array.audienceMatchesTokenExact,false);
 assert.equal(strictFieldChecksPassed(array),false);
 assert.equal(strictFieldChecksPassed(check({aud:'different'})),false);
 const tokenArray=introspectionChecks({...claims,token_type:'access_token'},{...claims,aud:[claims.aud]},'client-test',owner,now);
 assert.equal(tokenArray.audienceMatchesTokenExact,false);
 assert.equal(strictFieldChecksPassed(tokenArray),false);
});

test('paired probes preserve distinct results and safe request IDs',async t=>{
 const f=fixture(t,'paired'); await f.open(); await f.signin('a');
 const e=await f.evidence();
 assert.equal(e.accessTokenValidationA.result,'valid');
 assert.equal(e.beforeRevocation.active,false);
 assert.equal(e.beforeRevocationWithoutHint.active,true);
 assert.equal(e.beforeRevocation.requestID,'request_with-hint');
 assert.equal(e.beforeRevocationWithoutHint.requestID,'request_without-hint');
 assert.deepEqual(f.hints,['access_token',null]);
});

test('inactive baseline and repeated probe cannot enable reconsent',async t=>{
 const f=fixture(t,'inactive'); await f.open(); await f.signin('a'); await f.request('/check-a','POST');
 const e=await f.evidence();
 assert.equal(e.beforeRevocation.active,false); assert.equal(e.afterRevocation.active,false);
 const html=await (await f.request('/')).text();
 assert.match(html, /<button disabled>3\. Reconsent/);
 assert.equal((await f.request('/signin-b','POST')).status,409);
});

test('request IDs admit only bounded known-header-safe identifiers',()=>{
 assert.equal(safeRequestID('request_ABC-123'),'request_ABC-123');
 for(const value of [null,[],42,'','<script>','secret\nvalue','a'.repeat(129),'token.with.dots']) assert.equal(safeRequestID(value),null);
});

test('independent access JWT verification binds signed claims, issuer, audience, client and owner',async()=>{
 const now=Date.now(); const seconds=Math.floor(now/1000);
 const claims={iss:issuer,aud:'https://ampcode.com/api/v2',client_id:'client-test',sub:owner,exp:seconds+3600};
 let calls=0;
 const fetchKeys=async(url)=>{assert.equal(url,`${issuer}/oauth2/jwks`);calls++;return Response.json({keys:[jwk]});};
 const check=(token,fetchFn=fetchKeys)=>verifyAccessToken(token,'client-test',owner,fetchFn,now);
 assert.equal((await check(jwt(claims))).result,'valid');
 assert.equal((await check(jwt({...claims,nbf:seconds}))).result,'valid');
 for(const patch of [{iss:'https://wrong.example'},{aud:['https://ampcode.com/api/v2']},{aud:'wrong'},{client_id:'wrong'},{sub:'wrong'},{exp:seconds},{exp:'future'},{nbf:seconds+1},{nbf:'invalid'}]) {
  const result=await check(jwt({...claims,...patch})); assert.equal(result.result,'invalid'); assert.equal(result.signatureValid,true); assert.ok(Object.values(result.checks).includes(false));
 }
 for(const name of ['iss','aud','client_id','sub','exp']) {const partial={...claims};delete partial[name];assert.equal((await check(jwt(partial))).result,'invalid');}
 const signed=jwt(claims).split('.'); signed[1]=encode({...claims,sub:'forged'});
 assert.deepEqual(await check(signed.join('.')),{result:'invalid',signatureValid:false,checks:null});
 const before=calls;
 for(const token of ['opaque',jwt(claims,{alg:'none',kid:'test'}),jwt(claims,{alg:'RS256',kid:'test',crit:['unknown']})]) assert.equal((await check(token)).result,'invalid');
 assert.equal(calls,before);
 assert.equal((await check(jwt(claims,{alg:'RS256',kid:'missing',jku:'https://evil.example'}))).result,'invalid');
 assert.deepEqual(await check(jwt(claims),async()=>{throw Error('private-provider-body');}),{result:'unavailable',signatureValid:null,checks:null});
 assert.equal((await check(jwt(claims),async()=>Response.json({error:'private'}, {status:503}))).result,'unavailable');
});
