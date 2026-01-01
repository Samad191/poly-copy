import dotenv from 'dotenv';
import { Wallet } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';

dotenv.config();

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const CLOB_API_URL = 'https://clob.polymarket.com';
const DATA_API_URL = 'https://data-api.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Poly proxy wallet signature type

const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Funder address = your Polymarket proxy wallet (shown under profile picture on polymarket.com)
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS;

// Target address to mirror trades from
const TARGET_ADDRESS = '0x589222a5124a96765443b97a3498d89ffd824ad2';

// Polling interval in milliseconds (1 second)
const POLL_INTERVAL = 1000;

let clobClient = null;
let wallet = null;

// Track seen trade IDs to avoid duplicates
const seenTrades = new Set();

// Track the latest timestamp to only fetch new trades
let lastTimestamp = Math.floor(Date.now() / 1000);

// ═══════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatTimestamp(unixTimestamp) {
  if (unixTimestamp) {
    return new Date(unixTimestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  }
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatPrice(price) {
  const p = parseFloat(price);
  return isNaN(p) ? 'N/A' : `$${p.toFixed(4)}`;
}

function formatSize(size) {
  const s = parseFloat(size);
  return isNaN(s) ? 'N/A' : s.toFixed(2);
}

// ═══════════════════════════════════════════════════════════════
// AUTH - SETUP CLOB CLIENT
// ═══════════════════════════════════════════════════════════════

async function setupClobClient() {
  console.log('🔑 Setting up CLOB client with private key...');
  
  wallet = new Wallet(PRIVATE_KEY);
  const signerAddress = await wallet.getAddress();
  
  console.log(`   Signer address: ${signerAddress}`);
  console.log(`   Funder address: ${FUNDER_ADDRESS}`);
  console.log(`   Target wallet: ${TARGET_ADDRESS}`);
  
  // Create or derive API credentials
  const credentials = await new ClobClient(CLOB_API_URL, CHAIN_ID, wallet).createOrDeriveApiKey();
  console.log('✅ API credentials obtained');
  
  // Create authenticated CLOB client with funder and signature type
  clobClient = new ClobClient(
    CLOB_API_URL,
    CHAIN_ID,
    wallet,
    credentials,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS
  );
  
  console.log('✅ CLOB client ready for trading');
  
  return clobClient;
}

// ═══════════════════════════════════════════════════════════════
// TRADE MIRRORING - BUY/SELL EXECUTION
// ═══════════════════════════════════════════════════════════════

async function mirrorTrade(tradeData) {
  const { asset, side, size, price } = tradeData;
  
  console.log('\n🔄 MIRRORING TRADE...');
  console.log(`   Token ID: ${asset}`);
  console.log(`   Side: ${side} | Size: ${size} | Price: ${formatPrice(price)}`);
  
  try {
    // Build order parameters
    const orderParams = {
      tokenID: asset,
      side: side === 'BUY' ? Side.BUY : Side.SELL,
      size: parseFloat(size),
      price: parseFloat(price),
    };
    
    console.log('📝 Creating order with params:', orderParams);
    
    // Step 1: Create the signed order
    const order = await clobClient.createOrder(orderParams);
    
    console.log('📤 Posting order to CLOB...');
    
    // Step 2: Post the order (GTC = Good Till Cancelled)
    const result = await clobClient.postOrder(order, OrderType.GTC);
    
    console.log('✅ Order placed successfully!');
    console.log(`   Order ID: ${result.orderID || result.id || 'N/A'}`);
    console.log(`   Status: ${result.status || 'submitted'}`);
    
    return result;
  } catch (error) {
    console.error('❌ Failed to mirror trade:', error.message);
    if (error.response?.data) {
      console.error('   API Error:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// TRADE LOGGING
// ═══════════════════════════════════════════════════════════════

function logTrade(trade) {
  // The Data API already includes market details!
  console.log('\n' + '═'.repeat(65));
  console.log(`🎯 [${formatTimestamp(trade.timestamp)}] TARGET TRADE DETECTED`);
  console.log('═'.repeat(65));
  console.log(`   Market: "${trade.title}"`);
  console.log(`   Outcome: ${trade.outcome}`);
  console.log(`   Side: ${trade.side} | Price: ${formatPrice(trade.price)} | Size: ${formatSize(trade.size)}`);
  console.log(`   USDC Value: $${parseFloat(trade.usdcSize || 0).toFixed(2)}`);
  console.log(`   Condition ID: ${trade.conditionId}`);
  console.log(`   Token ID: ${trade.asset}`);
  console.log(`   Tx Hash: ${trade.transactionHash}`);
  console.log(`   Trader: ${trade.name || trade.pseudonym || trade.proxyWallet}`);
  console.log('═'.repeat(65));
  
  // Mirror the trade
  mirrorTrade({
    asset: trade.asset,
    side: trade.side,
    size: trade.size,
    price: trade.price,
  });
}

// ═══════════════════════════════════════════════════════════════
// POLLING - FETCH TARGET'S TRADES
// ═══════════════════════════════════════════════════════════════

async function fetchTargetActivity() {
  try {
    const response = await fetch(
      `${DATA_API_URL}/activity?user=${TARGET_ADDRESS}&limit=100`
    );
    
    if (!response.ok) {
      console.error(`❌ API Error: ${response.status} ${response.statusText}`);
      return [];
    }
    
    const activity = await response.json();
    
    // Filter for trades only (not orders, not other activity types)
    return activity.filter(item => item.type === 'TRADE');
  } catch (error) {
    console.error(`❌ Error fetching activity: ${error.message}`);
    return [];
  }
}

async function pollForTrades() {
  const trades = await fetchTargetActivity();
  
  // Sort by timestamp descending to process newest first
  trades.sort((a, b) => b.timestamp - a.timestamp);
  
  let newTradeCount = 0;
  
  for (const trade of trades) {
    // Create unique ID from transaction hash + asset
    const tradeId = `${trade.transactionHash}-${trade.asset}`;
    
    // Skip if we've already seen this trade
    if (seenTrades.has(tradeId)) {
      continue;
    }
    
    // Skip trades from before we started
    if (trade.timestamp < lastTimestamp - 5) {
      // Add to seen so we don't process old trades
      seenTrades.add(tradeId);
      continue;
    }
    
    // Mark as seen
    seenTrades.add(tradeId);
    
    // Log the new trade
    logTrade(trade);
    newTradeCount++;
  }
  
  // Update last timestamp if we found new trades
  if (trades.length > 0 && trades[0].timestamp > lastTimestamp) {
    lastTimestamp = trades[0].timestamp;
  }
  
  // Limit the size of seenTrades to prevent memory issues
  if (seenTrades.size > 10000) {
    const entries = Array.from(seenTrades);
    entries.slice(0, 5000).forEach(id => seenTrades.delete(id));
  }
}

function startPolling() {
  console.log(`\n📡 Starting to poll for trades every ${POLL_INTERVAL}ms`);
  console.log(`👁️  Watching: ${TARGET_ADDRESS}`);
  console.log(`📊 Using Data API: ${DATA_API_URL}/activity`);
  console.log('\n⏳ Waiting for new trades...\n');
  
  // Initial poll
  pollForTrades();
  
  // Set up recurring polls
  setInterval(pollForTrades, POLL_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

function validateConfig() {
  if (!PRIVATE_KEY) {
    console.error('❌ Missing PRIVATE_KEY in .env file');
    console.error('   Required: PRIVATE_KEY (your Ethereum wallet private key)');
    process.exit(1);
  }
  
  // Basic validation - should be 64 hex chars (with or without 0x prefix)
  const cleanKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
  if (!/^[a-fA-F0-9]{64}$/.test(cleanKey)) {
    console.error('❌ Invalid PRIVATE_KEY format');
    console.error('   Should be 64 hex characters (with or without 0x prefix)');
    process.exit(1);
  }
  
  if (!FUNDER_ADDRESS) {
    console.error('❌ Missing FUNDER_ADDRESS in .env file');
    console.error('   Required: Your Polymarket proxy wallet address (shown under profile picture)');
    process.exit(1);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   POLYMARKET TRADE MIRROR');
  console.log('   Real-time trade tracking & execution via CLOB API');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  validateConfig();
  
  // Setup CLOB client for executing trades (for future use)
  await setupClobClient();
  
  // Start polling for target's trades
  startPolling();
}

main();
