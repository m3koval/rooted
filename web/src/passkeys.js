import {authorized} from './core.js';

export function passkeysSupported(env=globalThis) {
  return !!(env.isSecureContext && env.PublicKeyCredential && env.navigator?.credentials?.create && env.navigator?.credentials?.get);
}
export function passkeyError(error) {
  const name=error?.name || error?.cause?.name;
  if (['NotAllowedError','AbortError'].includes(name) || /cancel|timed? out|not allowed/i.test(error?.message || '')) return 'Passkey request cancelled or timed out. You can try again or sign in with your password.';
  if (error?.code==='passkey_disabled') return 'Passkeys are not enabled yet. Sign in with your password.';
  if (name==='NotSupportedError' || error?.code==='unsupported') return 'Passkeys are unavailable in this browser. Use a supported browser on your personal device, or sign in with your password.';
  if (error?.code==='webauthn_credential_exists') return 'This passkey is already registered. Refresh your passkey list.';
  if (error?.code==='too_many_passkeys') return 'Your account has reached its passkey limit. Review your existing passkeys first.';
  return 'Passkey request was not completed or could not be verified. Refresh your passkey list before retrying registration; password sign-in remains available.';
}
function requireSupport(env) { if (!passkeysSupported(env)) throw {code:'unsupported'}; }
function value(result) { if (result.error) throw result.error; return result.data; }
export async function signInWithLeaderPasskey(client,boot,env=globalThis) {
  requireSupport(env);
  const data=value(await client.auth.signInWithPasskey());
  if (!data?.session?.user?.id) throw new Error('Missing session');
  // Authentication is not authorization: use exactly the existing authority path.
  await boot(data.session);
}
export async function leaderPasskeyAction(client,actor,action,passkeyId,isCurrent=()=>true,env=globalThis) {
  if (!actor || !isCurrent()) throw new Error('Access unavailable');
  const {user}=value(await client.auth.getUser()) || {};
  if (!user || user.id!==actor || user.is_anonymous || !(user.email_confirmed_at || user.phone_confirmed_at)) throw new Error('Confirmed leader required');
  const identity=value(await client.rpc('rooted_identity'));
  if (!authorized(identity,user.id) || !isCurrent()) throw new Error('Leader access unavailable');
  const list=async()=>{
    const rows=value(await client.auth.passkey.list());
    if (!Array.isArray(rows) || !isCurrent()) throw new Error('Passkey list unavailable');
    return rows;
  };
  if (action==='list') return list();
  if (action==='register') {
    requireSupport(env);
    const created=value(await client.auth.registerPasskey());
    const rows=await list();
    if (!created?.id || !rows.some(row=>row.id===created.id)) throw new Error('Enrollment readback unavailable');
    return rows;
  }
  if (action==='delete') {
    const before=await list();
    if (!before.some(row=>row.id===passkeyId)) throw new Error('Unknown credential');
    value(await client.auth.passkey.delete({passkeyId}));
    const rows=await list();
    if (rows.some(row=>row.id===passkeyId)) throw new Error('Deletion readback unavailable');
    return rows;
  }
  throw new Error('Unknown passkey action');
}
