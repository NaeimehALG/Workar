// Service-role-only database operations; never read/overwrite a balance in JS.
async function rpc(name, body) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !process.env.SUPABASE_URL) throw new Error('credit-store-not-configured');
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('credit-transaction-failed');
  return response.json();
}
async function grantPurchase(sessionId, userId, credits) {
  const result = await rpc('grant_ai_credit_purchase', {
    p_session_id: sessionId, p_user_id: userId, p_credits: credits
  });
  if (!result || typeof result.applied !== 'boolean') throw new Error('invalid-credit-receipt');
  return result;
}
async function consume(userId) {
  const result = await rpc('consume_ai_credit', { p_user_id: userId });
  if (result === null) return null;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid-credit-balance');
  return result;
}
module.exports = { grantPurchase, consume };
