import { ClobClient } from '@polymarket/clob-client-v2';
import { Wallet } from 'ethers';
import 'dotenv/config';

async function main() {
  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk) { console.error('POLY_PRIVATE_KEY not set'); process.exit(1); }

  const funder = process.env.POLY_FUNDER;
  const sigType = parseInt(process.env.POLY_SIGNATURE_TYPE || '2');

  const wallet = new Wallet(pk);
  console.log('EOA Wallet:', wallet.address);
  console.log('Funder (proxy):', funder || '<not set>');
  console.log('Signature type:', sigType, '(0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE)');

  if (!funder) {
    console.error('\nWARNING: POLY_FUNDER not set. Orders will fail because USDC is in the proxy, not EOA.');
    console.error('Add POLY_FUNDER=<your Polymarket proxy address> to .env');
    process.exit(1);
  }

  const creds = process.env.POLY_API_KEY ? {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_API_SECRET || '',
    passphrase: process.env.POLY_PASSPHRASE || '',
  } : undefined;

  console.log('Using saved creds:', !!creds);

  const client = new ClobClient({
    host: 'https://clob.polymarket.com',
    chain: 137 as any,
    signer: wallet as any,
    creds,
    signatureType: sigType as any,
    funderAddress: funder,
  });

  // Test 1: Get open orders (authenticated read)
  console.log('\n--- Test 1: Get open orders ---');
  try {
    const orders = await client.getOpenOrders();
    console.log('Result:', JSON.stringify(orders).substring(0, 500));
  } catch (err: any) {
    console.error('Error:', err.message);
    if (err.response) console.error('Status:', err.response.status, err.response.data);
  }

  // Test 2: Derive/check API key
  console.log('\n--- Test 2: Check API key ---');
  try {
    const derived = await client.createOrDeriveApiKey();
    console.log('Derived:', JSON.stringify({...derived}).substring(0, 200));
  } catch (err: any) {
    console.error('Error:', err.message);
  }

  // Test 3: Get server time (unauthenticated)
  console.log('\n--- Test 3: Server time ---');
  try {
    const time = await client.getServerTime();
    console.log('Server time:', time);
  } catch (err: any) {
    console.error('Error:', err.message);
  }

  // Test 4: Check balance & allowance via balance/allowance endpoint
  console.log('\n--- Test 4: USDC balance & allowance for proxy ---');
  try {
    // Polymarket's CLOB exposes a /balance-allowance endpoint per asset.
    // For USDC (collateral), assetType=COLLATERAL with no token_id.
    const balanceCollateral = await (client as any).getBalanceAllowance({ asset_type: 'COLLATERAL' });
    console.log('USDC balance & allowance:', balanceCollateral);
  } catch (err: any) {
    console.error('Error:', err.message);
    if (err.response) console.error('Status:', err.response.status, err.response.data);
  }

  // Test 5: Get a sample market and try to build (not place) a test order
  // — confirms client can sign orders correctly with proxy.
  console.log('\n--- Test 5: Build (not place) a $1 test order ---');
  console.log('  Skipped — requires a token_id input. Run test-place-order.ts to do a real $1 buy.');
}

main().catch(err => { console.error(err); process.exit(1); });
